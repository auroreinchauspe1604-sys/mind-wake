import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { OwnedDesktop, readDesktopMaintenance } from "../../scripts/desktop-maintenance.mjs";
import { configureDesktopMaintenance } from "../../scripts/setup-desktop-maintenance.mjs";
const revision = "a".repeat(40);

test("owned app handoff requires fresh process receipt; manifest revision cannot forge loaded version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-owner-"));
  const manifest = path.join(root, "manifest.json"),
    app = path.join(root, "app.cjs");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ version: 1, desktopExe: process.execPath, revision: "b".repeat(40) }),
  );
  fs.writeFileSync(
    app,
    `const fs=require('node:fs');fs.writeFileSync(process.env.MIND_WAKE_STARTUP_RECEIPT,JSON.stringify({pid:process.pid,instance:process.env.MIND_WAKE_STARTUP_INSTANCE,executable:process.execPath,revision:'${revision}',dirty:'false'}),{flag:'wx'});setInterval(()=>{},1000);`,
  );
  const children = [];
  const launch = async (_manifest, _role, options) => {
    const child = spawn(process.execPath, [app], {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        MIND_WAKE_STARTUP_RECEIPT: options.startupReceipt.file,
        MIND_WAKE_STARTUP_INSTANCE: options.startupReceipt.instance,
      },
    });
    children.push(child);
    return child;
  };
  const owner = new OwnedDesktop(manifest, launch, { receiptTimeout: 2000 });
  try {
    await owner.start();
    const before = (await owner.observe()).app;
    assert.equal(before.loadedRevision, revision);
    assert.equal(before.state, "running");
    assert.match(before.artifactSha256, /^[a-f0-9]{64}$/);
    await owner.handoff("relaunch_app", new AbortController().signal);
    const after = (await owner.observe()).app;
    assert.notEqual(after.instance, before.instance);
    assert.notEqual(children[0].pid, children[1].pid);
    assert.equal(after.loadedRevision, revision);
    assert.equal(children[0].exitCode !== null || children[0].signalCode !== null, true);
    await assert.rejects(owner.handoff("relaunch_engine", new AbortController().signal), /Unowned/);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(owner.handoff("relaunch_app", stopped.signal));
    assert.equal(children.length, 2);
    let guards = 0;
    owner.guard = () => {
      if (++guards === 2) throw Error("Authority withdrawn before restart");
    };
    await assert.rejects(
      owner.handoff("relaunch_app", new AbortController().signal),
      /Authority withdrawn/,
    );
    assert.equal(children.length, 2); // Local stop between termination and restart never relaunches.
  } finally {
    await owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("old app without startup receipt remains unknown and cannot verify a maintenance restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-no-receipt-")),
    manifest = path.join(root, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ desktopExe: process.execPath, revision }));
  const owner = new OwnedDesktop(
    manifest,
    async () =>
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        windowsHide: true,
        stdio: "ignore",
      }),
    { receiptTimeout: 100 },
  );
  try {
    await owner.start();
    assert.equal((await owner.observe()).app.loadedRevision, null);
    await assert.rejects(
      owner.handoff("relaunch_app", new AbortController().signal),
      /receipt missing/,
    );
  } finally {
    await owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup preserves pairing and workspace, grants no rights and requires private matching binding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-maintenance-setup-"));
  const manifest = path.join(root, "manifest.json"),
    policy = path.join(root, "policy.json"),
    binding = path.join(root, "binding.json"),
    store = path.join(root, "control.sqlite");
  const old = {
    version: 1,
    repoDir: "reviewed-source",
    dataDir: "existing-workspace",
    codex: { existing: true },
    pipe: "existing-pipe",
  };
  fs.writeFileSync(manifest, JSON.stringify(old));
  fs.writeFileSync(
    policy,
    JSON.stringify({
      target: "agent-bbbbbbbbbb",
      sharedEndpoint: "https://hub.example.invalid/v1/messages",
      grants: [],
      releases: {},
    }),
  );
  fs.writeFileSync(
    binding,
    JSON.stringify({ endpoint: "https://hub.example.invalid/v1/messages", key: "fixture-only" }),
  );
  try {
    const result = configureDesktopMaintenance({ manifest, policy, binding, store });
    assert.equal(result.active, false);
    const updated = JSON.parse(fs.readFileSync(manifest, "utf8"));
    delete updated.maintenance;
    assert.deepEqual(updated, old);
    assert.equal(readDesktopMaintenance(manifest).config.storeFile, store);
    assert.deepEqual(JSON.parse(fs.readFileSync(policy, "utf8")).grants, []);
    fs.writeFileSync(
      binding,
      JSON.stringify({
        endpoint: "https://other.example.invalid/v1/messages",
        key: "fixture-only",
      }),
    );
    assert.throws(
      () => configureDesktopMaintenance({ manifest, policy, binding, store }),
      /binding/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
