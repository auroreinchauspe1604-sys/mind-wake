#!/usr/bin/env node
/** Prepare the production shared-message client from this clone. No model/daemon calls. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const repo = fs.realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function validateNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (!((major === 24 && minor >= 17) || (major === 26 && minor >= 13)))
    throw new Error("Node ^24.17.0 ou ^26.13.0 requis.");
}
export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Endpoint HTTPS /v1/messages requis.");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/v1/messages" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Endpoint HTTPS /v1/messages requis, sans identifiants ni parametres.");
  return url.href;
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
export function validateStateDir(value) {
  if (!value || !path.isAbsolute(value))
    throw new Error("--state-dir doit etre un dossier absolu dedie hors Git et hors moteur.");
  const target = path.resolve(value);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!fs.statSync(ancestor).isDirectory()) throw new Error("Parent du dossier invalide.");
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  if (inside(repo, resolved) || resolved === path.parse(resolved).root)
    throw new Error("Le dossier de cle doit etre hors du clone et ne peut pas etre une racine.");
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git")))
      throw new Error("Le dossier de cle doit etre hors de tout depot Git.");
    if (path.dirname(dir) === dir) break;
  }
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Dossier invalide.");
    const allowed = new Set([
      ".gitignore",
      ".mind-shared-messages",
      "agent.key",
      "candidate.json",
      "endpoint.json",
      "mcp-addition.toml",
    ]);
    const names = fs.readdirSync(resolved);
    if (names.length && !fs.existsSync(path.join(resolved, ".mind-shared-messages")))
      throw new Error("Choisir un dossier vide dedie, pas un profil moteur existant.");
    for (const name of names) {
      if (!allowed.has(name) || !fs.lstatSync(path.join(resolved, name)).isFile())
        throw new Error("Contenu inattendu dans le dossier dedie.");
    }
  }
  return resolved;
}
export async function setup({ endpoint, stateDir, wakeManifest }) {
  validateNode();
  endpoint = validateEndpoint(endpoint);
  stateDir = validateStateDir(stateDir);
  let ownedLaunch;
  if (wakeManifest) {
    if (!path.isAbsolute(wakeManifest)) throw Error("Absolute Wake manifest required");
    const installed = JSON.parse(fs.readFileSync(wakeManifest, "utf8"));
    if (installed.version !== 1 || typeof installed.repoDir !== "string")
      throw Error("Existing Wake installation required");
    ownedLaunch = [
      path.join(installed.repoDir, "scripts/owned-shared-mcp.mjs"),
      "--manifest",
      wakeManifest,
      "--state-dir",
      stateDir,
    ];
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  if (pkg.name !== "mind-wake") throw new Error("Clone MIND Wake requis.");
  // Resolve installed dependencies from this clone before creating any private state.
  for (const name of ["@modelcontextprotocol/server", "zod"]) {
    if (!inside(repo, fileURLToPath(import.meta.resolve(name))))
      throw new Error("Dependance hors clone: " + name);
    await import(name);
  }
  const ts = (await import("typescript")).default;
  const sources = [
    "services/mcp/shared-server-main.ts",
    "services/mcp/shared-https.ts",
    "services/mcp/protocol.ts",
    "services/advice/conversation/protocol.ts",
  ];
  const contents = sources.map((name) => fs.readFileSync(path.join(repo, name), "utf8"));
  const build = path.join(
    repo,
    "output",
    "shared-messages-client",
    digest(JSON.stringify([ts.version, contents])).slice(0, 24),
  );
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "package.json"), '{"type":"module","private":true}\n');
  for (let i = 0; i < sources.length; i++) {
    const dest = path.join(build, sources[i].replace(/\.ts$/, ".js"));
    const result = ts.transpileModule(contents[i], {
      fileName: sources[i],
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true,
      },
    });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, result.outputText);
  }
  const launcher = path.join(build, "launch.mjs");
  fs.writeFileSync(
    launcher,
    `import fs from 'node:fs';
import path from 'node:path';
const state = process.argv[2];
process.env.MIND_SHARED_LINK_KEY = fs.readFileSync(path.join(state, 'agent.key'), 'utf8');
process.env.MIND_SHARED_HUB_URL = JSON.parse(fs.readFileSync(path.join(state, 'endpoint.json'), 'utf8')).endpoint;
await import('./services/mcp/shared-server-main.js');
`,
  );
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, ".mind-shared-messages"), "mind.shared/local-state.v1\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(stateDir, ".gitignore"), "*\n", { mode: 0o600 });
  const keyFile = path.join(stateDir, "agent.key");
  let keyCreated = false;
  try {
    fs.writeFileSync(keyFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
    keyCreated = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = fs.readFileSync(keyFile, "utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error("Cle existante invalide; aucun remplacement automatique.");
  const candidate = { schema: "mind.shared/key-candidate.v1", keySha256: digest(key) };
  fs.writeFileSync(
    path.join(stateDir, "candidate.json"),
    JSON.stringify(candidate, null, 2) + "\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(stateDir, "endpoint.json"),
    JSON.stringify({ endpoint }, null, 2) + "\n",
    { mode: 0o600 },
  );
  const configFragment = path.join(stateDir, "mcp-addition.toml");
  let launchArgs = [launcher, stateDir];
  if (ownedLaunch) launchArgs = ownedLaunch;
  fs.writeFileSync(
    configFragment,
    "[mcp_servers.mind_shared_messages]\ncommand = " +
      JSON.stringify(process.execPath) +
      "\nargs = " +
      JSON.stringify(launchArgs) +
      "\n",
    { mode: 0o600 },
  );
  return {
    keyCreated,
    candidate,
    configFragment,
    build,
    note: "Seul le digest candidat est partageable. Aucun appairage, activation ou appel reseau effectue.",
  };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        endpoint: { type: "string" },
        "state-dir": { type: "string" },
        "wake-manifest": { type: "string" },
      },
    });
    console.log(
      JSON.stringify(
        await setup({
          endpoint: values.endpoint,
          stateDir: values["state-dir"],
          wakeManifest: values["wake-manifest"],
        }),
        null,
        2,
      ),
    );
  } catch {
    // Do not echo supplied arguments or lower-level exceptions that could contain credentials.
    console.error(
      "Preparation refusee. Verifier Node supporte, --endpoint HTTPS /v1/messages, --state-dir absolu vide hors Git, et npm ci dans ce clone. Aucune cle affichee.",
    );
    process.exitCode = 1;
  }
}
