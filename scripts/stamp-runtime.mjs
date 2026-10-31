/** Bind a clean source revision to the code actually distributed to Node runtimes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const files = {};
function walk(relative) {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, item.name);
    if (item.isDirectory()) walk(file);
    else if (item.isFile() && /\.(?:js|mjs|ts)$/.test(file) && !/(?:\.test\.|\.d\.ts$)/.test(file))
      files[file] = createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex");
  }
}
for (const dir of ["dist", "src", "services", "scripts"]) walk(dir);
let revision = null,
  dirty = true;
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim() !== "";
} catch {
  /* A source archive without a verified commit cannot claim a revision. */
}
fs.writeFileSync(
  path.join(root, "dist/runtime-build.json"),
  JSON.stringify({ version: 1, revision, dirty, files }, null, 2) + "\n",
);
