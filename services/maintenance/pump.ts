/** Embed in an existing authorized local supervisor; never starts a model. */
import type { RemoteHubLink } from "../mcp/shared-https.js";
import type {
  MaintenanceRequest,
  MaintenanceResult,
} from "../../src/communication/maintenance-protocol.js";
import type { MaintenanceController } from "./controller.js";
export async function pumpMaintenance(
  link: RemoteHubLink,
  controller: MaintenanceController,
): Promise<void> {
  if (controller.policy().sharedEndpoint !== link.endpoint)
    throw Error("Local maintenance hub binding mismatch");
  const { requests } = await link.maintenance<{
    requests: { actor: string; request: MaintenanceRequest }[];
  }>({ op: "maintenance_poll" });
  for (const { actor, request } of requests) {
    const receipt = controller.accept(actor, request);
    await link.maintenance({ op: "maintenance_publish", result: receipt });
    if (["accepted", "running", "restart_pending"].includes(receipt.state)) {
      const result: MaintenanceResult = await controller.run(request.requestId, async (result) => {
        await link.maintenance({ op: "maintenance_publish", result });
      });
      await link.maintenance({ op: "maintenance_publish", result });
    }
  }
}
