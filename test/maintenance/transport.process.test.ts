import { it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Hub } from "../../services/mcp/hub.js";
import { parseHubConfig } from "../../services/mcp/config.js";
import { serveSharedHub, RemoteHubLink } from "../../services/mcp/shared-https.js";
import { MaintenanceRelay } from "../../services/maintenance/relay.js";
import { NODE_ARGS, minimalEnv } from "../mcp/harness.js";
import * as z from "zod";
import { maintenanceRef, resultSchema } from "../../src/communication/maintenance-protocol.js";

it("real MCP sender -> authenticated HTTPS relay -> target process -> read-only Wake diagnostic -> correlated MCP result, without a model", async () => {
  const root = resolve(".local/remote-maintenance");
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve("output/remote-maintenance"), { recursive: true });
  const dir = mkdtempSync(join(root, "transport-"));
  const keyA = randomBytes(32).toString("base64url"),
    keyB = randomBytes(32).toString("base64url");
  const digest = (v: string) => createHash("sha256").update(v).digest("hex");
  const cert = join(dir, "cert.pem"),
    tlsKey = join(dir, "key.pem");
  const openssl =
    process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
  execFileSync(
    openssl,
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
      tlsKey,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const hub = new Hub(
    parseHubConfig({
      parties: [keyA, keyB].map((key, i) => ({
        privateId: `fixture-private-${String(i)}`,
        kind: "agent",
        keyDigest: digest(key),
        permissions: { message: true, guide: false, requestHelp: false },
      })),
    }),
    dir,
  );
  const relay = new MaintenanceRelay(join(dir, "relay.sqlite"));
  let revoked = false;
  const server = serveSharedHub(
    hub,
    { cert: readFileSync(cert), key: readFileSync(tlsKey) },
    (key) => !revoked && [keyA, keyB].includes(key),
    relay,
  );
  const clients: Client[] = [];
  const port = await server.listen(0);
  const endpoint = `https://127.0.0.1:${String(port)}/v1/messages`;
  const repo = join(dir, "fixture-source");
  mkdirSync(repo);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repo, stdio: "ignore" },
  );
  async function connect(key: string) {
    const client = new Client({ name: "maintenance-fixture", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, resolve("services/mcp/shared-server-main.ts")],
        env: {
          ...minimalEnv(),
          NODE_EXTRA_CA_CERTS: cert,
          MIND_SHARED_HUB_URL: endpoint,
          MIND_SHARED_LINK_KEY: key,
          MIND_WAKE_MAINTENANCE: "1",
        },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const block = (result.content as { text: string }[])[0];
    if (!block) throw Error("Missing MCP content");
    return z.record(z.string(), z.unknown()).parse(JSON.parse(block.text));
  };
  try {
    const a = await connect(keyA),
      b = await connect(keyB);
    const actor = maintenanceRef.parse((await call(a, "whoami"))["ref"]),
      target = maintenanceRef.parse((await call(b, "whoami"))["ref"]);
    const policy = join(dir, "policy.json"),
      store = join(dir, "controller.sqlite");
    writeFileSync(
      policy,
      JSON.stringify({
        target,
        sharedEndpoint: endpoint,
        grants: [{ actor, actions: ["diagnose"] }],
        releases: {},
      }),
    );
    const request = {
      requestId: randomUUID(),
      target,
      action: "diagnose",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
    };
    // Ordinary text is never polled as a maintenance operation, even if valid JSON.
    await call(a, "send_message", {
      to: target,
      text: JSON.stringify(request),
      idempotency_key: "ordinary-text-control-1",
    });
    expect(relay.db.prepare("SELECT count(*) AS n FROM maintenance").get()).toEqual({ n: 0 });
    expect((await call(a, "request_maintenance", request))["delivery"]).toBe("relay_stored");
    expect((await call(a, "request_maintenance", request))["duplicate"]).toBe(true);
    expect(
      (await call(a, "get_maintenance_result", { requestId: request.requestId }))["delivery"],
    ).toBe("relay_stored_target_unconfirmed");
    const runTarget = () =>
      new Promise<void>((yes, no) => {
        const child = spawn(
          process.execPath,
          [
            ...NODE_ARGS,
            resolve("services/maintenance/controller-main.ts"),
            "--policy",
            policy,
            "--store",
            store,
            "--data-dir",
            join(dir, "no-profile"),
            "--repo",
            repo,
          ],
          {
            env: {
              ...minimalEnv(),
              PATH: process.env["PATH"] ?? process.env["Path"] ?? "",
              NODE_EXTRA_CA_CERTS: cert,
              MIND_SHARED_HUB_URL: endpoint,
              MIND_SHARED_LINK_KEY: keyB,
            },
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let errors = "";
        child.stderr.on("data", (d) => {
          errors += String(d);
        });
        child.on("error", no);
        child.on("exit", (code) => {
          if (code === 0) yes();
          else no(Error(errors));
        });
      });
    await runTarget();
    const response = await call(a, "get_maintenance_result", { requestId: request.requestId });
    const report = resultSchema.parse(response["result"]);
    expect(response["delivery"]).toBe("target_reported");
    expect(report.state).toBe("verified");
    expect(report.actor).toBe(actor);
    expect(report.target).toBe(target);
    if (!report.observation) throw Error("Missing diagnostic observation");
    expect(report.observation.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(report.observation.components.daemon.loadedRevision).toBeNull();
    expect(report.capabilities).toEqual(["diagnose"]);
    expect(existsSync(join(dir, "no-profile"))).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/fixture-private|Bearer|C:\\|prompt|conversation/);
    await runTarget(); // Restarted target receiver does not produce a second operation.
    expect(
      (await call(a, "get_maintenance_result", { requestId: request.requestId }))["result"],
    ).toEqual(response["result"]);
    expect(
      (await call(b, "get_maintenance_result", { requestId: request.requestId }))["error"],
    ).toBeDefined();
    const ungranted = { ...request, requestId: randomUUID(), action: "relaunch_app" };
    await call(a, "request_maintenance", ungranted);
    await runTarget();
    expect(
      resultSchema.parse(
        (await call(a, "get_maintenance_result", { requestId: ungranted.requestId }))["result"],
      ).code,
    ).toBe("unauthorized");
    // Lost result: target state durable, publication can be retried byte-for-byte.
    const stored = relay.db
      .prepare("SELECT result FROM maintenance WHERE id=?")
      .get(request.requestId) as { result: string };
    expect(
      relay.handle(target, {
        op: "maintenance_publish",
        id: 99,
        result: JSON.parse(stored.result) as unknown,
      }),
    ).toMatchObject({ delivery: "result_stored" });
    expect(() =>
      relay.handle(actor, {
        op: "maintenance_publish",
        id: 99,
        result: JSON.parse(stored.result) as unknown,
      }),
    ).toThrow();
    revoked = true;
    expect(
      (await call(a, "get_maintenance_result", { requestId: request.requestId }))["delivery"],
    ).toBe("unknown");
    // Refused transport remains ambiguous; it never fabricates executed success.
    expect(() => new RemoteHubLink("http://127.0.0.1/v1/messages", keyA)).toThrow();
    writeFileSync(
      resolve("output/remote-maintenance/diagnostic-proof.json"),
      JSON.stringify(response, null, 2),
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    relay.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
