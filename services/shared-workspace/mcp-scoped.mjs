/** Recipient stdio surface. Only a participant credential and trusted CA; no owner state. */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { callScopedWorkspace } from "./workspace.mjs";
import { registerScopedWorkspaceTools } from "./scoped-mcp.mjs";
import { loadScopedCredential } from "./scoped-client.mjs";

const file = process.argv[2];
if (!file) throw new Error("workspace_remote_credential_file_required");
const server = new McpServer({ name: "mind-workspace-scoped", version: "0.3.0" });
registerScopedWorkspaceTools(server, {
  call(body) {
    return callScopedWorkspace(loadScopedCredential(file), body);
  },
});
await server.connect(new StdioServerTransport());
