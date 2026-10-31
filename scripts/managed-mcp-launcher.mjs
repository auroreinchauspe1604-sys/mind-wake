/** Stable managed launcher: resolve the currently installed release at each provider launch. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export function managedMcpLauncher(manifestFile) {
  return `import fs from 'node:fs';\nimport path from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst manifestFile=${JSON.stringify(manifestFile)};\nconst m=JSON.parse(fs.readFileSync(manifestFile,'utf8'));\nconst {startLocal}=await import(pathToFileURL(path.join(m.repoDir,'scripts/start-local.mjs')).href);\nawait startLocal(manifestFile,'agent');\n`;
}
export function refreshManagedMcpLauncher(manifestFile, previousRepo) {
  const file = path.join(path.dirname(manifestFile), "mcp.mjs");
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, "utf8"),
    next = managedMcpLauncher(manifestFile);
  const legacy = `import {startLocal} from ${JSON.stringify(pathToFileURL(path.join(previousRepo, "scripts/start-local.mjs")).href)};\nawait startLocal(${JSON.stringify(manifestFile)},'agent');\n`;
  if (original.replaceAll("\r\n", "\n") !== legacy && original !== next) return false;
  if (fs.readFileSync(file, "utf8") !== original) throw Error("MCP launcher changed concurrently");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
  try {
    if (fs.readFileSync(file, "utf8") !== original)
      throw Error("MCP launcher changed concurrently");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return true;
}
