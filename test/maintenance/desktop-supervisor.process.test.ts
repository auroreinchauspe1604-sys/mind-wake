import { it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Hub } from "../../services/mcp/hub.js";
import { parseHubConfig } from "../../services/mcp/config.js";
import { serveSharedHub } from "../../services/mcp/shared-https.js";
import { MaintenanceRelay } from "../../services/maintenance/relay.js";
import { init } from "../../src/cli/commands/init.js";
import { processContext, DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { toUtcTimestamp } from "../../src/journal/index.js";
import { NODE_ARGS, minimalEnv } from "../mcp/harness.js";
import { resultSchema } from "../../src/communication/maintenance-protocol.js";

it("HTTPS request reaches the installed supervisor bridge and relaunches only its owned fixture app with loaded receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-desktop-control-"));
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem");
  execFileSync(
    process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const keys = [
    randomBytes(32).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ] as const;
  const digest = (v: string) => createHash("sha256").update(v).digest("hex");
  const parties = keys.map((k, i) => ({
    privateId: `fixture-control-${String(i)}`,
    kind: "agent",
    keyDigest: digest(k),
    permissions: { message: true, requestHelp: false, guide: false },
  }));
  mkdirSync(join(dir, "hub"));
  const hub = new Hub(parseHubConfig({ parties }), join(dir, "hub"));
  const relay = new MaintenanceRelay(join(dir, "relay.sqlite"));
  const server = serveSharedHub(
    hub,
    { cert: readFileSync(cert), key: readFileSync(key) },
    (k) => keys.includes(k),
    relay,
  );
  const port = await server.listen(0),
    endpoint = `https://127.0.0.1:${String(port)}/v1/messages`;
  const actor = hub.authenticate(keys[0]).ref,
    target = hub.authenticate(keys[1]).ref;
  const dataDir = join(dir, "data"),
    ctx = processContext();
  init(ctx, { path: dataDir, source: "option" });
  const store = ctx.openStore(dataDir, "write");
  try {
    store.uow.transaction((tx) =>
      tx.profiles.transition(DEFAULT_PROFILE_ID, {
        from: "disabled",
        to: "ready",
        reason: "fixture only",
        at: toUtcTimestamp(new Date()),
      }),
    );
  } finally {
    store.close();
  }
  const revision = "a".repeat(40),
    policy = join(dir, "policy.json"),
    binding = join(dir, "binding.json"),
    manifest = join(dir, "manifest.json");
  writeFileSync(
    policy,
    JSON.stringify({
      target,
      sharedEndpoint: endpoint,
      grants: [{ actor, actions: ["diagnose", "relaunch_app"] }],
      releases: { approved: { revision } },
    }),
  );
  writeFileSync(binding, JSON.stringify({ endpoint, key: keys[1] }));
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      repoDir: process.cwd(),
      dataDir,
      node: process.execPath,
      desktopExe: process.execPath,
      maintenance: {
        policyFile: policy,
        bindingFile: binding,
        storeFile: join(dir, "controller.sqlite"),
      },
    }),
  );
  const quit = join(dir, "quit"),
    app = join(dir, "app.cjs"),
    wrapper = join(dir, "supervisor.mjs");
  writeFileSync(
    app,
    `const fs=require('node:fs');fs.writeFileSync(process.env.MIND_WAKE_STARTUP_RECEIPT,JSON.stringify({pid:process.pid,instance:process.env.MIND_WAKE_STARTUP_INSTANCE,executable:process.execPath,revision:'${revision}',dirty:'false'}),{flag:'wx'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(quit)}))process.exit(0);},100);`,
  );
  writeFileSync(
    wrapper,
    `import {spawn} from 'node:child_process';import {superviseDesktopMaintenance} from ${JSON.stringify(pathToFileURL(resolve("scripts/desktop-maintenance.mjs")).href)};await superviseDesktopMaintenance(process.argv[2],async(_f,_r,o)=>spawn(process.execPath,[${JSON.stringify(app)}],{windowsHide:true,stdio:'ignore',env:{...process.env,MIND_WAKE_STARTUP_RECEIPT:o.startupReceipt.file,MIND_WAKE_STARTUP_INSTANCE:o.startupReceipt.instance}}));`,
  );
  const child = spawn(process.execPath, [...NODE_ARGS, wrapper, manifest], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...minimalEnv(), NODE_EXTRA_CA_CERTS: cert },
  });
  let errors = "";
  child.stderr.on("data", (d) => {
    errors += String(d);
  });
  const request = {
    requestId: randomUUID(),
    target,
    action: "relaunch_app",
    release: "approved",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 240000).toISOString(),
  };
  try {
    relay.handle(actor, { op: "maintenance_submit", id: 1, request });
    let response: ReturnType<typeof resultSchema.parse> | undefined;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const raw = relay.db
        .prepare("SELECT result FROM maintenance WHERE id=?")
        .get(request.requestId) as { result: string | null };
      if (raw.result) {
        const value = resultSchema.parse(JSON.parse(raw.result));
        if (["verified", "refused", "failed"].includes(value.state)) {
          response = value;
          break;
        }
      }
      if (child.exitCode !== null) throw Error(`Supervisor exited: ${errors}`);
      await pause(100);
    }
    expect(response?.state, errors).toBe("verified");
    expect(response?.observation?.components.app.loadedRevision).toBe(revision);
    expect(response?.verificationScope).toEqual(["app"]);
    expect(response?.capabilities).not.toContain("relaunch_engine");
    expect(response?.observation?.components.daemon.loadedRevision).toBeNull();
    expect(JSON.stringify(response)).not.toContain(keys[1]);
    writeFileSync(quit, "");
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => {
        no(Error("Supervisor did not finish"));
      }, 10000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) yes();
        else no(Error(errors));
      });
    });
  } finally {
    if (child.exitCode === null) {
      if (process.platform === "win32" && child.pid)
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          /* already exited */
        }
      else child.kill();
    }
    await server.close();
    relay.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
