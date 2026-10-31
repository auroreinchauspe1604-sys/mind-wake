import fs from "node:fs";
import path from "node:path";

export function privateTarget(value) {
  const target = path.join(
    fs.realpathSync.native(path.dirname(path.resolve(value))),
    path.basename(value),
  );
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) throw new Error("private_file_inside_git");
    if (dir === path.dirname(dir)) break;
  }
  return target;
}
export function privateFile(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("private_file_required");
  const target = fs.realpathSync.native(value);
  if (!fs.statSync(target).isFile()) throw new Error("private_file_required");
  privateTarget(target);
  return target;
}
