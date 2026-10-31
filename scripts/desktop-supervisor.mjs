/** The installed shortcuts own this watcher. Exit 0 means intentional quit/second instance. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { startLocal, nodeArgs } from "./start-local.mjs";
import { codexRuntimeEnv } from "./installation.mjs";

export function restartDelay(code, signal, failures) {
  if (code === 75 && !signal) return 0; // Explicit app restart, not a crash.
  return code === 0 && !signal ? null : Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
}
export function canStartScheduled(status) {
  return (
    status?.ok === true &&
    !status.data?.profile?.emergencyStopLocked &&
    ["ready", "hibernating"].includes(status.data?.profile?.state) &&
    status.data?.daemon?.state !== "running"
  );
}
export async function startSupervised(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const log = fs.openSync(path.join(path.dirname(manifestFile), "desktop-supervisor.log"), "a");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        m.node,
        [
          ...nodeArgs(m),
          path.join(m.repoDir, "scripts/desktop-supervisor.mjs"),
          "--manifest",
          manifestFile,
        ],
        {
          cwd: m.repoDir,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
        },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    fs.closeSync(log);
  }
}
export function startScheduled(m) {
  const args = [path.join(m.repoDir, "dist/cli/main.js")];
  const env = { ...process.env, ...codexRuntimeEnv(m), MIND_WAKE_DATA_DIR: m.dataDir };
  const command = (verb) =>
    spawnSync(m.node, [...args, verb, "--json"], {
      env,
      cwd: m.repoDir,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
  const status = command("status");
  if (status.status !== 0 || !canStartScheduled(JSON.parse(status.stdout))) return;
  const on = command("on");
  if (on.status !== 0) throw Error("Scheduled startup refused");
  const log = fs.openSync(path.join(m.dataDir, "daemon.log"), "a");
  try {
    const daemon = spawn(
      m.node,
      [
        ...nodeArgs(m),
        path.join(m.repoDir, "scripts/engine-supervisor.mjs"),
        "--manifest",
        path.join(m.dataDir, "installation/manifest.json"),
      ],
      {
        env,
        cwd: m.repoDir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      },
    );
    daemon.on("error", (error) =>
      fs.appendFileSync(
        path.join(m.dataDir, "installation/desktop-supervisor.log"),
        `${new Date().toISOString()} daemon: ${error.message}\n`,
      ),
    );
    daemon.unref();
  } finally {
    fs.closeSync(log);
  }
}
export async function supervise(manifestFile, startup, launch = startLocal) {
  const log = (message) =>
    fs.appendFileSync(
      path.join(path.dirname(manifestFile), "desktop-supervisor.log"),
      `${new Date().toISOString()} ${message}\n`,
    );
  if (startup) {
    try {
      startScheduled(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
    } catch (error) {
      log(`startup: ${error.message}`);
    }
  }
  const configured = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (configured.maintenance) {
    const { superviseDesktopMaintenance } = await import("./desktop-maintenance.mjs");
    return superviseDesktopMaintenance(manifestFile, launch);
  }
  let failures = 0;
  for (;;) {
    const started = Date.now();
    let delay;
    try {
      const child = await launch(manifestFile, "desktop", { restart: false, supervised: true });
      const { code, signal } = await new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      if (Date.now() - started > 60000) failures = 0;
      delay = restartDelay(code, signal, failures++);
      if (delay === null) return;
      log(`desktop exited (${code ?? signal}); restarting in ${delay}ms`);
    } catch (error) {
      delay = restartDelay(null, null, failures++);
      log(`launch failed: ${error.message}; retry in ${delay}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { manifest: { type: "string" }, startup: { type: "boolean" } },
  });
  if (!values.manifest) throw Error("--manifest required");
  await supervise(path.resolve(values.manifest), values.startup === true);
}
