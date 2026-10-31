import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { checkUpdate, development } from "../../scripts/app-update.mjs";

function fixture(t) {
  const scratch = path.resolve(".local/update-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "wake-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "manifest.json");
  const node = path.join(dir, "node.exe");
  fs.mkdirSync(path.join(dir, "node_modules/npm/bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules/npm/bin/npm-cli.js"), "");
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "sentinel"), "upstream");
  const m = {
    version: 1,
    development: false,
    repoDir: source,
    node,
    dataDir: dir,
    updateSource: source,
  };
  fs.writeFileSync(file, JSON.stringify(m));
  const calls = [];
  const run = async (exe, args, cwd) => {
    calls.push([exe, ...args]);
    if (exe === "git") {
      if (args[0] === "clone") fs.mkdirSync(args.at(-1), { recursive: true });
      return args[0] === "rev-parse" ? "a".repeat(40) : "";
    }
    if (exe === "cargo") {
      for (const name of [
        "dist/cli/main.js",
        "desktop/src-tauri/target/release/mind-wake-desktop.exe",
      ]) {
        const full = path.join(cwd, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "test build");
      }
    }
    return "";
  };
  return { dir, file, m, calls, run };
}
test("development defaults are fail-closed; no fetch even on demand", async (t) => {
  assert.equal(development({}, {}), true);
  assert.equal(development({ development: false }, { MIND_WAKE_DEV: "1" }), true);
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.m, development: true }));
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "disabled");
  assert.equal(f.calls.length, 0);
});
test("update migrates the managed MCP launcher so the next real Node launch selects the installed release", async (t) => {
  const f = fixture(t),
    launcher = path.join(f.dir, "mcp.mjs");
  fs.writeFileSync(
    launcher,
    `import {startLocal} from ${JSON.stringify(pathToFileURL(path.join(f.m.repoDir, "scripts/start-local.mjs")).href)};\nawait startLocal(${JSON.stringify(f.file)},'agent');\n`,
  );
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "installed");
  const current = JSON.parse(fs.readFileSync(f.file, "utf8"));
  fs.mkdirSync(path.join(current.repoDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(current.repoDir, "scripts/start-local.mjs"),
    `export async function startLocal(file,role){console.log(JSON.stringify({file,role,version:'new-release'}));}`,
  );
  const observed = JSON.parse(
    execFileSync(process.execPath, [launcher], { encoding: "utf8", windowsHide: true }),
  );
  assert.equal(observed.version, "new-release");
  assert.equal(observed.file, f.file);
  assert.equal(observed.role, "agent");
});
test("update leaves a personally modified MCP launcher intact", async (t) => {
  const f = fixture(t),
    launcher = path.join(f.dir, "mcp.mjs"),
    custom = "// custom owner launcher\n";
  fs.writeFileSync(launcher, custom);
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "installed");
  assert.equal(fs.readFileSync(launcher, "utf8"), custom);
});
test("stage a simulated release, switch only on success, skip unchanged revision", async (t) => {
  const f = fixture(t);
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "installed");
  const active = JSON.parse(fs.readFileSync(f.file));
  assert.notEqual(active.repoDir, f.m.repoDir);
  assert.equal(fs.readFileSync(path.join(f.m.repoDir, "sentinel"), "utf8"), "upstream");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "previous-manifest.json"))), f.m);
  f.calls.length = 0;
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "current");
  assert.equal(
    f.calls.some((c) => c[0] === "cargo"),
    false,
  );
});
test("failed builds preserve installation and release lock for retry", async (t) => {
  const f = fixture(t);
  const result = await checkUpdate(f.file, {
    run: async (exe, ...args) => {
      if (exe === f.m.node) throw Error("simulated npm failure");
      return f.run(exe, ...args);
    },
  });
  assert.equal(result.state, "error");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.m);
  assert.equal(fs.existsSync(path.join(f.dir, "update.lock")), false);
});
test("parallel requests do not build twice", async (t) => {
  const f = fixture(t);
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const first = checkUpdate(f.file, {
    run: async (...args) => {
      await gate;
      return f.run(...args);
    },
  });
  assert.equal((await checkUpdate(f.file, { run: f.run })).state, "busy");
  unblock();
  assert.equal((await first).state, "installed");
});

test("maintenance pin refuses a fetched but unapproved revision before builds", async (t) => {
  const f = fixture(t);
  const result = await checkUpdate(f.file, { run: f.run, expectedRevision: "b".repeat(40) });
  assert.equal(result.state, "error");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.m);
  assert.equal(
    f.calls.some(([exe]) => exe !== "git"),
    false,
  );
});

test("maintenance guard rechecks before manifest switch and preserves active install on revocation", async (t) => {
  const f = fixture(t);
  let revoked = false;
  const result = await checkUpdate(f.file, {
    run: async (...args) => {
      const value = await f.run(...args);
      if (args[0] === "cargo") revoked = true;
      return value;
    },
    expectedRevision: "a".repeat(40),
    beforeStep: () => {
      if (revoked) throw Error("local maintenance grant revoked");
    },
  });
  assert.equal(result.state, "error");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.m);
  assert.equal(fs.existsSync(path.join(f.dir, "previous-manifest.json")), false);
});
