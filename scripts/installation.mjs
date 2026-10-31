/** Shared local installation files. No model call or daemon activation. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { managedMcpLauncher } from "./managed-mcp-launcher.mjs";
export function desktopExecutable(repoDir) {
  const portable = path.join(repoDir, "bin/mind-wake-desktop.exe");
  return fs.existsSync(portable)
    ? portable
    : path.join(repoDir, "desktop/src-tauri/target/debug/mind-wake-desktop.exe");
}
export function codexRuntimeEnv(manifest) {
  return manifest.codex
    ? {
        CODEX_HOME: manifest.codex.codexHome,
        MIND_WAKE_CODEX_BIN:
          manifest.codex.executable.prefixArgs?.[0] || manifest.codex.executable.path,
      }
    : {};
}
export function prepareInstallation(repoDir, dataDir, codex) {
  repoDir = path.resolve(repoDir);
  dataDir = path.resolve(dataDir);
  const dir = path.join(dataDir, "installation");
  const manifestFile = path.join(dir, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const old = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (old.version !== 1 || old.repoDir !== repoDir || old.dataDir !== dataDir)
      throw Error("Installation existante incompatible : rien remplacé.");
  }
  fs.mkdirSync(dir, { recursive: true });
  const keysFile = path.join(dir, "keys.json");
  if (!fs.existsSync(keysFile))
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        agent: randomBytes(32).toString("base64url"),
        owner: randomBytes(32).toString("base64url"),
      }),
      { flag: "wx", mode: 0o600 },
    );
  const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  if (!["agent", "owner"].every((k) => typeof keys[k] === "string" && keys[k].length >= 32))
    throw Error("Clés locales invalides : aucune rotation automatique.");
  const pipe =
    "\\\\.\\pipe\\mind-wake-" +
    createHash("sha256").update(dataDir.toLowerCase()).digest("hex").slice(0, 16);
  const config = {
    parties: [
      ["agent", "agent"],
      ["owner", "human"],
    ].map(([id, kind]) => ({
      privateId: "wake-local-" + id,
      kind,
      keyDigest: createHash("sha256").update(keys[id]).digest("hex"),
      permissions: { message: true, requestHelp: false, guide: false },
    })),
  };
  const configFile = path.join(dir, "hub.json");
  if (fs.existsSync(configFile)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(configFile, "utf8"))) !== JSON.stringify(config))
      throw Error("Configuration du hub modifiée : conservation, réconciliation manuelle requise.");
  } else fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
  const manifest = {
    version: 1,
    ...(codex ? { codex } : {}),
    repoDir,
    dataDir,
    pipe,
    node: process.execPath,
    desktopExe: desktopExecutable(repoDir),
    development: !fs.existsSync(path.join(repoDir, "bin/mind-wake-desktop.exe")),
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  // The launcher reads the local key file; no credential in the Codex registration.
  const launcher = path.join(dir, "mcp.mjs");
  fs.writeFileSync(launcher, managedMcpLauncher(manifestFile));
  const mcpFile = path.join(dir, "claude-mcp.json");
  fs.writeFileSync(
    mcpFile,
    JSON.stringify(
      { mcpServers: { mind: { command: process.execPath, args: [launcher] } } },
      null,
      2,
    ),
  );
  return { ...manifest, manifestFile, launcher, mcpFile };
}
