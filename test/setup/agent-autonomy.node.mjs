import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NODE_ARGS } from "../mcp/harness.ts";
import { authorizationSchema } from "../../services/mcp/authorizations.ts";
import { localRuntimeEnv } from "../../scripts/start-local.mjs";
test("explicit full access adoption preserves private restrictions and exposes autonomous local peer tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-full-access-")),
    workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const file = path.join(workspace, "AUTORISATIONS.json"),
    keyFile = path.join(root, "peer.key");
  const old = {
    version: 1,
    title: "Existing owner",
    context: "existing",
    example: "example",
    guidance: "guidance",
    entries: [
      {
        id: "keep-private",
        action: "Do not publish my notes",
        decision: "forbidden",
        scope: "Private notes",
        category: "connect",
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(old));
  fs.writeFileSync(keyFile, "fixture-only-key");
  fs.writeFileSync(
    path.join(root, "keys.json"),
    JSON.stringify({ agent: "fixture-local-agent", owner: "fixture-local-owner" }),
  );
  const args = [
    ...NODE_ARGS,
    path.resolve("scripts/setup-agent-autonomy.mjs"),
    "--workspace",
    workspace,
    "--data-dir",
    root,
    "--owner",
    "Fixture owner",
    "--agent",
    "agent-bbbbbbbbbb",
    "--peer-endpoint",
    "https://hub.example.invalid/v1/messages",
    "--peer-key-file",
    keyFile,
  ];
  try {
    const refused = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
    assert.notEqual(refused.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), old);
    const adopted = spawnSync(process.execPath, [...args, "--adopt"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(adopted.status, 0, adopted.stderr);
    const result = authorizationSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.ok(
      result.entries.some((e) => e.id === "filesystem-complet" && e.decision === "authorized"),
    );
    assert.ok(
      result.entries.some((e) => e.id === "sessions-locales" && e.decision === "authorized"),
    );
    assert.ok(result.entries.some((e) => e.id === "keep-private" && e.decision === "forbidden"));
    const peer = JSON.parse(fs.readFileSync(path.join(root, "peer-task-policy.json"), "utf8"));
    assert.deepEqual(peer.decider, { kind: "agent", ref: "agent-bbbbbbbbbb" });
    assert.equal(
      localRuntimeEnv(
        { manifestFile: path.join(root, "manifest.json"), dataDir: root, repoDir: process.cwd() },
        "agent",
      ).MIND_WAKE_PEER_TASKS,
      "1",
    );
    assert.equal(JSON.parse(adopted.stdout).runtimePolicyUnchanged, true);
    assert.equal(fs.readdirSync(workspace).filter((n) => n.includes("before-adoption")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
