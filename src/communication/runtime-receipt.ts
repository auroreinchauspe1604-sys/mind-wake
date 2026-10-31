/** Startup evidence emitted by the actual initialized Node component. Private local file only. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function writeRuntimeReceipt(role: "daemon" | "mcp"): void {
  const file = process.env["MIND_WAKE_OWNED_RECEIPT"];
  if (!file) return;
  try {
    const root = process.env["MIND_WAKE_REPO_DIR"],
      entry = process.env["MIND_WAKE_OWNED_ENTRY"],
      instance = process.env["MIND_WAKE_OWNED_INSTANCE"];
    if (
      !root ||
      !entry ||
      !instance ||
      !path.isAbsolute(root) ||
      !path.isAbsolute(file) ||
      !path.isAbsolute(entry) ||
      !/^[a-f0-9-]{36}$/.test(instance)
    )
      return;
    const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    let revision: string | null = null;
    try {
      const stamp = JSON.parse(
        fs.readFileSync(path.join(root, "dist/runtime-build.json"), "utf8"),
      ) as { version: number; revision: string; dirty: boolean; files: Record<string, string> };
      if (
        stamp.version === 1 &&
        !stamp.dirty &&
        /^[a-f0-9]{40,64}$/.test(stamp.revision) &&
        Object.keys(stamp.files).length > 0 &&
        stamp.files[path.relative(root, entry).split(path.sep).join("/")] === sha(entry) &&
        Object.entries(stamp.files).every(
          ([relative, hash]) =>
            !path.isAbsolute(relative) &&
            !relative.split("/").includes("..") &&
            sha(path.join(root, relative)) === hash,
        )
      )
        revision = stamp.revision;
    } catch {
      /* Source edits, stale/missing build stamp, or archives remain unknown. */
    }
    const receipt = {
      pid: process.pid,
      instance,
      role,
      entry,
      loadedRevision: revision,
      artifactSha256: sha(entry),
    };
    fs.writeFileSync(file, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  } catch {
    /* Receipt failure cannot stop the local runtime; its version stays unknown. */
  } finally {
    delete process.env["MIND_WAKE_OWNED_RECEIPT"];
    delete process.env["MIND_WAKE_OWNED_ENTRY"];
    delete process.env["MIND_WAKE_OWNED_INSTANCE"];
  }
}
