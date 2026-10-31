import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { OwnedRuntime, ownedComponents } from "../../scripts/owned-runtime.mjs";
import { writeRuntimeReceipt } from "../../src/communication/runtime-receipt.ts";
import { startHarness } from "../mcp/harness.ts";

test("actual engine owner authenticates local restart, changes instance, ignores stale owners and respects local stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-engine-owner-")),
    manifest = path.join(dir, "manifest.json"),
    entry = path.join(dir, "engine.cjs");
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, dataDir: dir, repoDir: dir }));
  fs.writeFileSync(path.join(dir, "keys.json"), JSON.stringify({ owner: "fixture-owner-key" }));
  fs.writeFileSync(
    entry,
    `const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(process.env.MIND_WAKE_OWNED_RECEIPT,JSON.stringify({role:'daemon',pid:process.pid,instance:process.env.MIND_WAKE_OWNED_INSTANCE,entry:__filename,loadedRevision:'${"a".repeat(40)}',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}));process.on('message',()=>process.exit(0));setInterval(()=>{},1000);`,
  );
  let allowed = true,
    launches = 0;
  const owner = new OwnedRuntime(
    manifest,
    "daemon",
    async ({ file, instance }) => {
      launches++;
      return {
        entry,
        child: spawn(process.execPath, [entry], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            MIND_WAKE_OWNED_RECEIPT: file,
            MIND_WAKE_OWNED_INSTANCE: instance,
          },
        }),
      };
    },
    {
      guard: () => {
        if (!allowed) throw Error("Paused");
      },
      readyTimeout: 2000,
    },
  );
  try {
    await owner.start();
    const first = await ownedComponents(manifest, "daemon");
    assert.equal(first.members.length, 1);
    const next = await ownedComponents(manifest, "daemon", "restart", new AbortController().signal);
    assert.notEqual(first.component.instance, next.component.instance);
    assert.equal(next.component.loadedRevision, "a".repeat(40));
    assert.equal(launches, 2);
    let edge = 0;
    owner.guard = () => {
      if (++edge === 2) throw Error("Paused after stop");
    };
    await assert.rejects(
      ownedComponents(manifest, "daemon", "restart", new AbortController().signal),
    );
    assert.equal((await owner.observe()).state, "stopped");
    owner.guard = () => {};
    await ownedComponents(manifest, "daemon", "restart", new AbortController().signal);
    assert.equal(launches, 3);
    owner.guard = () => {
      throw Error("Paused");
    };
    await assert.rejects(
      ownedComponents(manifest, "daemon", "restart", new AbortController().signal),
    );
    assert.equal(launches, 3);
  } finally {
    await owner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("actual MCP client retains its initialized stdio connection through owned backend restart", async () => {
  const h = await startHarness();
  const install = path.join(h.dir, "installation");
  fs.mkdirSync(install);
  const manifest = path.join(install, "manifest.json"),
    launcher = path.join(install, "launch.mjs");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      dataDir: h.dir,
      repoDir: process.cwd(),
      node: process.execPath,
      pipe: h.pipe,
    }),
  );
  fs.writeFileSync(
    path.join(install, "keys.json"),
    JSON.stringify({ agent: h.keys.agent, owner: h.keys.guide }),
  );
  // Maintenance is already authorized by the parent test. Use real ready profile for owner stop checks.
  const { init } = await import("../../src/cli/commands/init.ts");
  const { processContext, DEFAULT_PROFILE_ID } = await import("../../src/cli/context.ts");
  const { toUtcTimestamp } = await import("../../src/journal/index.ts");
  const ctx = processContext();
  init(ctx, { path: h.dir, source: "option" });
  const store = ctx.openStore(h.dir, "write");
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
  fs.writeFileSync(
    launcher,
    `import {startLocal} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/start-local.mjs")).href)};await startLocal(${JSON.stringify(manifest)},'agent');`,
  );
  const client = new Client({ name: "owned-restart-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [launcher],
        stderr: "pipe",
      }),
    );
    const before = await client.callTool({ name: "whoami", arguments: {} });
    assert.equal(before.isError, undefined);
    const toolsBefore = await client.listTools();
    let first;
    const deadline = Date.now() + 5000;
    do {
      first = await ownedComponents(manifest, "mcp");
      if (first.component.instance) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    assert.ok(first.component.instance);
    const ref = JSON.parse(before.content[0].text).ref,
      keyFile = path.join(h.dir, "peer.key");
    fs.writeFileSync(keyFile, "fixture-shared-peer-key");
    fs.writeFileSync(
      path.join(h.dir, "peer-task-policy.json"),
      JSON.stringify({
        enabled: true,
        localAgentRef: ref,
        decider: { kind: "agent", ref },
        sharedEndpoint: "https://fixture.invalid/v1/messages",
        sharedKeyFile: keyFile,
      }),
    );
    const result = await ownedComponents(manifest, "mcp", "restart", new AbortController().signal);
    assert.notEqual(result.component.instance, first.component.instance);
    const after = await client.callTool({ name: "whoami", arguments: {} });
    assert.deepEqual(after, before);
    const updatedTools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(updatedTools.includes("decide_peer_task"));
    assert.ok(updatedTools.length > toolsBefore.tools.length);
    assert.equal(result.component.loadedRevision, first.component.loadedRevision);
  } finally {
    await client.close();
    await h.close();
  }
});

test("real Wake daemon on a simulated paused-by-activity fixture stops through owner IPC and restarts without any model session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-real-engine-")),
    manifest = path.join(dir, "manifest.json");
  const { seedSimulatedProfile, setUserActive } = await import("../demo/harness.ts");
  const { wakeReader } = await import("../../services/mcp/wake.ts");
  seedSimulatedProfile(dir);
  setUserActive(dir, true);
  fs.writeFileSync(
    manifest,
    JSON.stringify({ version: 1, dataDir: dir, repoDir: process.cwd(), node: process.execPath }),
  );
  fs.writeFileSync(path.join(dir, "keys.json"), JSON.stringify({ owner: "fixture-engine-owner" }));
  const { createEngineOwner } = await import("../../scripts/engine-supervisor.mjs");
  const owner = createEngineOwner(manifest, {
    daemonArgs: ["--simulated", "--recheck-ms", "1000"],
  });
  owner.guard = () => {};
  try {
    await owner.start();
    const first = await owner.observe();
    assert.ok(first.instance);
    const after = await ownedComponents(
      manifest,
      "daemon",
      "restart",
      new AbortController().signal,
    );
    assert.notEqual(after.component.instance, first.instance);
    const status = wakeReader({ MIND_WAKE_DATA_DIR: dir }).status();
    assert.equal(status.daemon.state, "running");
    assert.equal(status.lastSession, null);
  } finally {
    await owner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loaded runtime receipt binds the startup entry and all stamped dependency bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-runtime-stamp-")),
    entry = path.join(dir, "entry.js"),
    dependency = path.join(dir, "dependency.js"),
    file = path.join(dir, "receipt.json");
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(entry, "// actual loaded entry");
  fs.writeFileSync(dependency, "// dependency");
  const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  fs.writeFileSync(
    path.join(dir, "dist/runtime-build.json"),
    JSON.stringify({
      version: 1,
      dirty: false,
      revision: "b".repeat(40),
      files: { "entry.js": sha(entry), "dependency.js": sha(dependency) },
    }),
  );
  const names = [
      "MIND_WAKE_OWNED_RECEIPT",
      "MIND_WAKE_REPO_DIR",
      "MIND_WAKE_OWNED_ENTRY",
      "MIND_WAKE_OWNED_INSTANCE",
    ],
    old = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const receiptEnv = {
    MIND_WAKE_OWNED_RECEIPT: file,
    MIND_WAKE_REPO_DIR: dir,
    MIND_WAKE_OWNED_ENTRY: entry,
    MIND_WAKE_OWNED_INSTANCE: randomUUID(),
  };
  Object.assign(process.env, receiptEnv);
  try {
    writeRuntimeReceipt("daemon");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).loadedRevision, "b".repeat(40));
    fs.unlinkSync(file);
    fs.writeFileSync(dependency, "// changed after build");
    Object.assign(process.env, receiptEnv);
    writeRuntimeReceipt("daemon");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).loadedRevision, null);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shared-message MCP can use the same owned restart path while preserving its private identity", async () => {
  const h = await startHarness(),
    install = path.join(h.dir, "installation");
  fs.mkdirSync(install);
  const manifest = path.join(install, "manifest.json"),
    state = path.join(h.dir, "shared"),
    cert = path.join(h.dir, "cert.pem"),
    key = path.join(h.dir, "key.pem");
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
  const server = https.createServer(
    { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: 1,
          ok: false,
          error: { code: "not_authenticated", message: "fixture refusal", retryable: false },
        }),
      );
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `https://127.0.0.1:${server.address().port}/v1/messages`;
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      repoDir: process.cwd(),
      dataDir: h.dir,
      node: process.execPath,
      pipe: h.pipe,
    }),
  );
  fs.writeFileSync(
    path.join(install, "keys.json"),
    JSON.stringify({ agent: h.keys.agent, owner: h.keys.guide }),
  );
  const { init } = await import("../../src/cli/commands/init.ts"),
    { processContext, DEFAULT_PROFILE_ID } = await import("../../src/cli/context.ts"),
    { toUtcTimestamp } = await import("../../src/journal/index.ts");
  const ctx = processContext();
  init(ctx, { path: h.dir, source: "option" });
  const store = ctx.openStore(h.dir, "write");
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
  const { setup } = await import("../../scripts/setup-shared-messages.mjs");
  const prepared = await setup({ endpoint, stateDir: state, wakeManifest: manifest });
  const identity = fs.readFileSync(path.join(state, "agent.key"), "utf8");
  assert.match(fs.readFileSync(prepared.configFragment, "utf8"), /owned-shared-mcp/);
  const client = new Client({ name: "shared-owned-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve("scripts/owned-shared-mcp.mjs"),
          "--manifest",
          manifest,
          "--state-dir",
          state,
        ],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(tools.length, 5);
    const deadline = Date.now() + 5000;
    let before;
    do {
      before = await ownedComponents(manifest, "mcp");
      if (before.component.instance) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    assert.ok(before.component.instance);
    const after = await ownedComponents(manifest, "mcp", "restart", new AbortController().signal);
    assert.notEqual(after.component.instance, before.component.instance);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      tools,
    );
    assert.equal((await client.callTool({ name: "whoami", arguments: {} })).isError, true);
    assert.equal(fs.readFileSync(path.join(state, "agent.key"), "utf8"), identity);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});
