/** Build immutable releases; only switch the manifest after a successful build. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const UPDATE_INTERVAL = 5 * 60 * 1000;
export function development(m, env = process.env) {
  return env.MIND_WAKE_DEV === "1" || m.development !== false;
}
function write(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
export function updateStatus(file) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const state = path.join(path.dirname(file), "update.json");
  const result = fs.existsSync(state)
    ? JSON.parse(fs.readFileSync(state, "utf8"))
    : { state: "idle" };
  if (["current", "installed"].includes(result.state) && process.env.MIND_WAKE_REPO_DIR) {
    result.state =
      path.resolve(process.env.MIND_WAKE_REPO_DIR) === path.resolve(m.repoDir)
        ? "current"
        : "installed";
  }
  return { ...result, development: development(m) };
}
export async function checkUpdate(
  file,
  { run: runner = command, expectedRevision, beforeStep = () => {} } = {},
) {
  // Maintenance callers supply a supervisor-owned cancellable runner and a local
  // authorization/stop guard. Existing desktop callers retain their behavior.
  const run = async (...args) => {
    await beforeStep();
    return runner(...args);
  };
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (development(m)) return { state: "disabled", development: true };
  const dir = path.dirname(file),
    lock = path.join(dir, "update.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") return { state: "busy" };
    throw error;
  }
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const stateFile = path.join(dir, "update.json");
  const report = (state) => {
    const value = { ...state, checkedAt: new Date().toISOString() };
    write(stateFile, value);
    return value;
  };
  const log = fs.openSync(path.join(dir, "update.log"), "a");
  try {
    report({ state: "checking" });
    const cache = path.join(dir, "update-source");
    const source = m.updateSource || "https://github.com/mind-protocol/mind-wake.git";
    const branch = m.updateBranch || "main";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes(".."))
      throw Error("Invalid update branch");
    if (!fs.existsSync(cache)) await run("git", ["clone", "--bare", "--", source, cache], dir, log);
    await run(
      "git",
      ["fetch", "--prune", "origin", `+refs/heads/${branch}:refs/heads/wake-update`],
      cache,
      log,
    );
    const revision = (await run("git", ["rev-parse", "refs/heads/wake-update"], cache, log)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw Error("Invalid revision");
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw Error("Fetched revision differs from locally approved release");
    if (m.revision === revision) return report({ state: "current", revision });
    report({ state: "building", revision });
    const releases = path.join(dir, "releases");
    fs.mkdirSync(releases, { recursive: true });
    const target = fs.mkdtempSync(path.join(releases, `${revision.slice(0, 12)}-`));
    await run("git", ["clone", "--no-hardlinks", "--", cache, target], dir, log);
    await run("git", ["checkout", "--detach", revision], target, log);
    // npm's JS entry avoids shell interpolation and .cmd execution on Windows.
    const npm = path.join(path.dirname(m.node), "node_modules/npm/bin/npm-cli.js");
    if (!fs.existsSync(npm)) throw Error("npm CLI missing beside Node");
    await run(m.node, [npm, "ci"], target, log);
    await run(m.node, [npm, "run", "build"], target, log);
    await run(m.node, [npm, "run", "desktop:ui"], target, log);
    await run(
      "cargo",
      ["build", "--locked", "--release", "--manifest-path", "desktop/src-tauri/Cargo.toml"],
      target,
      log,
    );
    const desktopExe = path.join(target, "desktop/src-tauri/target/release/mind-wake-desktop.exe");
    if (!fs.existsSync(desktopExe) || !fs.existsSync(path.join(target, "dist/cli/main.js")))
      throw Error("Incomplete build");
    // Refuse to overwrite a concurrent installation change.
    await beforeStep();
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(m))
      throw Error("Installation changed during update");
    write(path.join(dir, "previous-manifest.json"), m);
    write(file, { ...m, repoDir: target, desktopExe, revision });
    return report({ state: "installed", revision, restartRequired: true });
  } catch (error) {
    return report({ state: "error", message: error.message });
  } finally {
    fs.closeSync(log);
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
}
function command(exe, args, cwd, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", log] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      fs.writeSync(log, chunk);
      output = (output + chunk).slice(-8192);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(Error(`${path.basename(exe)} failed (${code}); see update.log`)),
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = path.join(
    process.env.MIND_WAKE_DATA_DIR || path.join(process.env.LOCALAPPDATA || "", "mind-wake"),
    "installation/manifest.json",
  );
  const action = process.argv[2];
  if (!["status", "check"].includes(action)) throw Error("Unknown update action");
  console.log(JSON.stringify(action === "check" ? await checkUpdate(file) : updateStatus(file)));
}
