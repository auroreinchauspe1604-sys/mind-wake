/** Manual one-shot diagnostic receiver. Production polling belongs to an existing supervisor. */
import { parseArgs } from "node:util";
import { MaintenanceController, readMaintenancePolicy } from "./controller.js";
import { LocalMaintenanceAdapter } from "./local-adapter.js";
import { pumpMaintenance } from "./pump.js";
import { RemoteHubLink } from "../mcp/shared-https.js";
const { values } = parseArgs({
  options: {
    policy: { type: "string" },
    store: { type: "string" },
    "data-dir": { type: "string" },
    repo: { type: "string" },
    manifest: { type: "string" },
  },
});
if (!values.policy || !values.store || !values["data-dir"] || !values.repo)
  throw Error("Explicit --policy --store --data-dir --repo required");
const endpoint = process.env["MIND_SHARED_HUB_URL"],
  key = process.env["MIND_SHARED_LINK_KEY"];
if (!endpoint || !key) throw Error("Local hub binding required");
const link = new RemoteHubLink(endpoint, key);
const identity = await link.call<{ ref: string }>({ op: "whoami" });
if (
  identity.ref !== readMaintenancePolicy(values.policy).target ||
  readMaintenancePolicy(values.policy).sharedEndpoint !== link.endpoint
)
  throw Error("Target identity binding mismatch");
const policyFile = values.policy;
const controller = new MaintenanceController(
  values.store,
  () => readMaintenancePolicy(policyFile),
  new LocalMaintenanceAdapter({
    dataDir: values["data-dir"],
    repoDir: values.repo,
    ...(values.manifest ? { manifestFile: values.manifest } : {}),
  }),
);
try {
  await pumpMaintenance(link, controller);
} finally {
  controller.close();
}
