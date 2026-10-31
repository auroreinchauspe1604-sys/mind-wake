import path from "node:path";
import { parseArgs } from "node:util";
import { ownedComponents } from "./owned-runtime.mjs";
const { values } = parseArgs({
  options: { manifest: { type: "string" }, role: { type: "string" }, action: { type: "string" } },
});
if (
  !values.manifest ||
  !["daemon", "mcp"].includes(values.role) ||
  !["observe", "restart"].includes(values.action)
)
  throw Error("Explicit manifest, role and action required");
const file = path.resolve(values.manifest);
try {
  const before = await ownedComponents(file, values.role);
  if (!before.members.length)
    console.log(JSON.stringify({ ok: false, owned: false, code: "no_owned_runtime" }));
  else {
    const result =
      values.action === "restart"
        ? await ownedComponents(file, values.role, "restart", new AbortController().signal)
        : before;
    console.log(JSON.stringify({ ok: true, owned: true, component: result.component }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, owned: true, code: "owned_operation_refused" }));
  process.exitCode = 1;
}
