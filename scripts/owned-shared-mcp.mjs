/** Restartable MIND shared-message MCP using an existing Wake installation and identity. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runOwnedMcp } from "./owned-mcp.mjs";
import { localRuntimeEnv, nodeArgs } from "./start-local.mjs";
const { values } = parseArgs({
  options: { manifest: { type: "string" }, "state-dir": { type: "string" } },
});
if (
  !values.manifest ||
  !values["state-dir"] ||
  !path.isAbsolute(values.manifest) ||
  !path.isAbsolute(values["state-dir"])
)
  throw Error("Existing absolute manifest and shared state directory required");
const manifestFile = values.manifest,
  state = values["state-dir"];
await runOwnedMcp(manifestFile, async () => {
  const m = { ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), manifestFile };
  return {
    m,
    nodeArgs: nodeArgs(m),
    entry: path.join(m.repoDir, "services/mcp/shared-server-main.ts"),
    env: {
      ...localRuntimeEnv(m, "agent"),
      MIND_SHARED_HUB_URL: JSON.parse(fs.readFileSync(path.join(state, "endpoint.json"), "utf8"))
        .endpoint,
      MIND_SHARED_LINK_KEY: fs.readFileSync(path.join(state, "agent.key"), "utf8").trim(),
      MIND_WAKE_MAINTENANCE: m.maintenance ? "1" : (process.env.MIND_WAKE_MAINTENANCE ?? "0"),
    },
  };
});
