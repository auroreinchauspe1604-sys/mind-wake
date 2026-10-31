/** Explicit local adoption; no remote grant and no runtime policy changed. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { authorizationSchema } from "../services/mcp/authorizations.ts";
import { peerTaskPolicy } from "../services/helpers/peer-tasks.ts";
import { privateFile } from "../services/shared-workspace/private-files.mjs";
const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    "data-dir": { type: "string" },
    owner: { type: "string" },
    agent: { type: "string" },
    adopt: { type: "boolean" },
    "peer-endpoint": { type: "string" },
    "peer-key-file": { type: "string" },
  },
});
if (
  !values.adopt ||
  !values.owner ||
  !values.agent ||
  !values.workspace ||
  !values["data-dir"] ||
  !path.isAbsolute(values.workspace) ||
  !path.isAbsolute(values["data-dir"])
)
  throw Error("Explicit local --adopt --owner --agent --workspace --data-dir required");
const file = path.join(values.workspace, "AUTORISATIONS.json");
const template = authorizationSchema.parse(
  JSON.parse(
    fs.readFileSync(
      new URL("../examples/AUTORISATIONS.full-access.template.json", import.meta.url),
      "utf8",
    ),
  ),
);
const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const existing = original === null ? null : authorizationSchema.parse(JSON.parse(original));
const ids = new Set(template.entries.map((e) => e.id));
const adopted = authorizationSchema.parse({
  ...template,
  context: `ADOPTÉ localement par ${values.owner}, agent ${values.agent}, ${new Date().toISOString()}. Les restrictions personnelles conservées ci-dessous restent applicables.`,
  guidance:
    template.guidance +
    (existing
      ? `\nConsignes personnelles antérieures conservées : ${existing.context}\n${existing.guidance}`
      : ""),
  entries: [...(existing?.entries ?? []).filter((e) => !ids.has(e.id)), ...template.entries],
});
let policy, policyFile, previousPolicy;
if (values["peer-endpoint"] || values["peer-key-file"]) {
  if (!values["peer-endpoint"] || !values["peer-key-file"])
    throw Error("Both peer endpoint and local key file required");
  const endpoint = new URL(values["peer-endpoint"]);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.pathname !== "/v1/messages" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error("Existing HTTPS shared hub required");
  policy = peerTaskPolicy.parse({
    enabled: true,
    localAgentRef: values.agent,
    decider: { kind: "agent", ref: values.agent },
    sharedEndpoint: endpoint.href,
    sharedKeyFile: privateFile(values["peer-key-file"]),
  });
  policyFile = path.join(values["data-dir"], "peer-task-policy.json");
  previousPolicy = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf8") : null;
}
function replace(file, original, value) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== original) throw Error("Concurrent local change");
  if (original !== null)
    fs.writeFileSync(`${file}.before-adoption-${randomUUID()}.json`, original, {
      flag: "wx",
      mode: 0o600,
    });
  const next = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(next, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null) !== original) {
    fs.unlinkSync(next);
    throw Error("Concurrent local change");
  }
  fs.renameSync(next, file);
}
replace(file, original, adopted);
if (policy) replace(policyFile, previousPolicy, policy);
console.log(
  JSON.stringify({
    adopted: true,
    autonomousPeerDecider: !!policy,
    runtimePolicyUnchanged: true,
    remoteGrantsUnchanged: true,
  }),
);
