import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { codexRuntimeEnv } from "./installation.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function baseEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i.test(k) &&
        !/^MIND_WAKE_(STARTUP_RECEIPT|STARTUP_INSTANCE|OWNED_RECEIPT|OWNED_INSTANCE|OWNED_ENTRY)$/.test(
          k,
        ),
    ),
  );
}
export function nodeArgs(m) {
  return [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    pathToFileURL(path.join(m.repoDir, "test/fixtures/store-ledger/ts-hooks.ts")).href,
  ];
}
/** An explicitly reviewed desktop sidecar must not switch the running agent's CLI. */
export function desktopRuntimeEnv(m, role) {
  if (role !== "desktop" || m.desktopRepoDir === undefined) return {};
  if (typeof m.desktopRepoDir !== "string" || !path.isAbsolute(m.desktopRepoDir))
    throw Error("desktopRepoDir must be an absolute reviewed runtime directory.");
  const cli = path.join(m.desktopRepoDir, "dist/cli/main.js");
  const owner = path.join(m.desktopRepoDir, "services/mcp/owner-main.ts");
  if (!fs.statSync(cli).isFile() || !fs.statSync(owner).isFile())
    throw Error("Incomplete desktop runtime sidecar.");
  return { MIND_WAKE_REPO_DIR: m.desktopRepoDir, MIND_WAKE_CLI: cli, MIND_OWNER_CLI: owner };
}
function reachable(pipe) {
  return new Promise((resolve) => {
    const s = net.connect(pipe);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    s.setTimeout(750, () => finish(false));
  });
}
export async function ensureHub(m) {
  if (await reachable(m.pipe)) return;
  const dir = path.dirname(m.manifestFile);
  const stdout = fs.openSync(path.join(dir, "hub.stdout.log"), "a"),
    stderr = fs.openSync(path.join(dir, "hub.stderr.log"), "a");
  try {
    const child = spawn(
      m.node,
      [
        ...nodeArgs(m),
        path.join(m.repoDir, "services/mcp/hub-main.ts"),
        "--config",
        path.join(dir, "hub.json"),
        "--dir",
        path.join(dir, "hub-data"),
        "--pipe",
        m.pipe,
      ],
      {
        cwd: m.repoDir,
        env: baseEnv(),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr],
      },
    );
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    child.unref();
    for (let i = 0; i < 100 && !failed; i++) {
      if (await reachable(m.pipe)) return;
      await pause(100);
    }
    throw Error("Hub local indisponible. Consulter les journaux installation/hub.*.log.");
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}
export function localRuntimeEnv(m, role, options = {}) {
  const manifestFile = m.manifestFile;
  const keys = JSON.parse(
    fs.readFileSync(path.join(path.dirname(manifestFile), "keys.json"), "utf8"),
  );
  let peerTasks = process.env.MIND_WAKE_PEER_TASKS === "1";
  try {
    const file = path.join(m.dataDir, "peer-task-policy.json"),
      stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32768)
      peerTasks = JSON.parse(fs.readFileSync(file, "utf8")).enabled === true;
  } catch {
    /* No implicit peer-task delegation without a configured local policy. */
  }
  return {
    ...baseEnv(),
    ...codexRuntimeEnv(m),
    MIND_MCP_HUB_PIPE: m.pipe,
    MIND_MCP_LINK_KEY: role === "agent" ? keys.agent : keys.owner,
    MIND_WAKE_DATA_DIR: m.dataDir,
    MIND_WAKE_REPO_DIR: m.repoDir,
    MIND_WAKE_OWNER_MESSAGES: role === "agent" ? "1" : "0",
    MIND_WAKE_BACKGROUND_JOBS: role === "agent" ? "1" : "0",
    MIND_WAKE_PEER_TASKS: role === "agent" && peerTasks ? "1" : "0",
    MIND_WAKE_NODE: m.node,
    MIND_WAKE_DESKTOP_SUPERVISED: options.supervised ? "1" : "0",
    ...(options.startupReceipt
      ? {
          MIND_WAKE_STARTUP_RECEIPT: options.startupReceipt.file,
          MIND_WAKE_STARTUP_INSTANCE: options.startupReceipt.instance,
        }
      : {}),
    ...desktopRuntimeEnv(m, role),
  };
}
export async function startLocal(manifestFile, role, options = {}) {
  const m = { ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), manifestFile };
  if (m.version !== 1 || !["agent", "desktop"].includes(role))
    throw Error("Installation ou rôle invalide.");
  if (options.existingHubOnly === true) {
    if (!(await reachable(m.pipe))) throw Error("Hub existant indisponible ; aucun hub lancé.");
  } else await ensureHub(m);
  const env = localRuntimeEnv(m, role, options);
  if (role === "desktop") {
    // Restart only this exact desktop executable. No daemon is stopped.
    const script =
      "$existingDesktop = @(Get-Process -Name 'mind-wake-desktop' -ErrorAction SilentlyContinue); if ($existingDesktop.Count -gt 0) { $existingDesktop | Where-Object { $_.Path -eq $env:MIND_SETUP_DESKTOP } | Stop-Process -ErrorAction Stop }; exit 0";
    const stopped =
      options.restart === false
        ? { status: 0 }
        : spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...env, MIND_SETUP_DESKTOP: m.desktopExe },
            windowsHide: true,
            encoding: "utf8",
            timeout: 10000,
          });
    if (stopped.error || stopped.status !== 0)
      throw Error("Impossible de relancer le panneau existant.");
    // A reviewed local update can replace the unlocked binary before relaunching.
    if (options.stopOnly === true) return null;
    return await new Promise((resolve, reject) => {
      const child = spawn(m.desktopExe, [], {
        env,
        cwd: env.MIND_WAKE_REPO_DIR,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        if (!options.supervised) child.unref();
        resolve(child);
      });
    });
  }
  const { runOwnedMcp } = await import("./owned-mcp.mjs");
  return runOwnedMcp(manifestFile, async () => {
    const latest = { ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), manifestFile };
    await ensureHub(latest);
    return { m: latest, env: localRuntimeEnv(latest, "agent"), nodeArgs: nodeArgs(latest) };
  });
}
