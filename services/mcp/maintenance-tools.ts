import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { requestSchema, maintenanceId } from "../../src/communication/maintenance-protocol.js";
import type { RemoteHubLink } from "./shared-https.js";
export function registerMaintenanceTools(server: McpServer, link: RemoteHubLink): void {
  const output = async (work: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              delivery: "unknown",
              error: "transport_or_relay_refused",
              retry: "same_request_id_and_body",
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "request_maintenance",
    {
      description:
        "Submit typed maintenance to an explicitly authorized target controller. Relay storage is not target acceptance or execution. Never grants authority.",
      inputSchema: requestSchema,
      annotations: { openWorldHint: true },
    },
    (request) => output(() => link.maintenance({ op: "maintenance_submit", request })),
  );
  server.registerTool(
    "get_maintenance_result",
    {
      description:
        "Read the target controller report. No result means unconfirmed target, never proof of failure or success. Offline targets require a reachable local controller.",
      inputSchema: z.strictObject({ requestId: maintenanceId }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requestId }) => output(() => link.maintenance({ op: "maintenance_get", requestId })),
  );
}
