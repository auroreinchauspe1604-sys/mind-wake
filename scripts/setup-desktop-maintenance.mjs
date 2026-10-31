/** Configure an existing supervisor from locally approved files; never grants authority. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { privateFile, privateTarget } from "../services/shared-workspace/private-files.mjs";

export function configureDesktopMaintenance({ manifest, policy, binding, store }) {
  for (const file of [manifest, policy, binding, store])
    if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("Absolute paths required");
  const original = fs.readFileSync(manifest, "utf8"),
    m = JSON.parse(original);
  if (m.version !== 1 || !m.dataDir || !m.repoDir) throw Error("Existing installation required");
  policy = privateFile(policy);
  binding = privateFile(binding);
  store = privateTarget(store);
  if (fs.existsSync(store)) privateFile(store);
  // Full schema and authenticated target binding are checked by the running controller.
  const p = JSON.parse(fs.readFileSync(policy, "utf8")),
    b = JSON.parse(fs.readFileSync(binding, "utf8"));
  const url = new URL(b.endpoint);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/v1/messages" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    p.sharedEndpoint !== b.endpoint ||
    !/^(agent|human)-[a-z2-9]{10}$/.test(p.target) ||
    !Array.isArray(p.grants) ||
    typeof b.key !== "string" ||
    !b.key
  )
    throw Error("Invalid local policy/binding");
  const configured = {
    ...m,
    maintenance: { policyFile: policy, bindingFile: binding, storeFile: store },
  };
  const backup = `${manifest}.before-maintenance-${randomUUID()}.json`;
  fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  if (fs.readFileSync(manifest, "utf8") !== original) throw Error("Installation changed");
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(configured, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    if (fs.readFileSync(manifest, "utf8") !== original) throw Error("Installation changed");
    fs.renameSync(temporary, manifest);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return {
    configured: true,
    active: false,
    backup,
    actions: "local_policy_only",
    restart: "existing_desktop_supervisor",
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      policy: { type: "string" },
      binding: { type: "string" },
      store: { type: "string" },
    },
  });
  console.log(JSON.stringify(configureDesktopMaintenance(values)));
}
