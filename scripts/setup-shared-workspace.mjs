#!/usr/bin/env node
/** Additive fragment only: never edits a user's existing MCP configuration. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadState, hash } from "../services/shared-workspace/workspace.mjs";
import { privateFile, privateTarget } from "../services/shared-workspace/private-files.mjs";
import { loadScopedCredential } from "../services/shared-workspace/scoped-client.mjs";
export { privateFile, privateTarget } from "../services/shared-workspace/private-files.mjs";

export async function setupWorkspace({ role, state, credential, output, baseConfig }) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 17) || (major === 26 && minor >= 13)))
    throw new Error("node_version");
  if (!["remote", "local", "scoped"].includes(role)) throw new Error("invalid_role");
  // Check installed dependencies before writing anything; no install or network action.
  await import("@modelcontextprotocol/server");
  await import("zod");
  const file = privateFile(role === "local" ? state : credential);
  if (role === "local") loadState(file);
  else if (role === "scoped") loadScopedCredential(file);
  else {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(config.token) || !config.capability || !config.participant)
      throw new Error("invalid_credential");
    const endpoint = new URL(config.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.pathname !== (role === "scoped" ? "/v1/scoped-workspace" : "/v1/workspace") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid_endpoint");
    privateFile(config.caFile);
  }
  if (!output || !path.isAbsolute(output)) throw new Error("output_required");
  const launcher = fileURLToPath(
    new URL(`../services/shared-workspace/mcp-${role}.mjs`, import.meta.url),
  );
  const fragment = `[mcp_servers.mind_workspace_${role}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([launcher, file])}\n`;
  let prefix = Buffer.alloc(0);
  if (baseConfig) {
    prefix = fs.readFileSync(privateFile(baseConfig));
    // Conservative collision check also covers quoted TOML keys/subtables. Never replace a server.
    if (prefix.toString("utf8").includes(`mind_workspace_${role}`))
      throw new Error("mcp_server_already_present");
    privateTarget(output); // A candidate may contain other servers' private configuration.
  }
  fs.writeFileSync(
    output,
    Buffer.concat([prefix, Buffer.from(`${baseConfig ? "\n\n" : ""}${fragment}`)]),
    { flag: "wx", mode: 0o600 },
  );
  return {
    role,
    ...(baseConfig
      ? { configCandidate: path.resolve(output), baseSha256: hash(prefix) }
      : { configFragment: path.resolve(output) }),
    note: "Prepared file only; no live MCP configuration edited, permission granted, server started or wake enabled.",
  };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        role: { type: "string" },
        state: { type: "string" },
        credential: { type: "string" },
        output: { type: "string" },
        "base-config": { type: "string" },
      },
    });
    console.log(
      JSON.stringify(await setupWorkspace({ ...values, baseConfig: values["base-config"] })),
    );
  } catch {
    console.error(
      "workspace_mcp_setup_refused (check role, absolute private files outside Git, fresh output, Node and clone dependencies)",
    );
    process.exitCode = 1;
  }
}
