/** Concrete sender for the same typed MCP control protocol. Keys stay in a private local file. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { privateFile } from "../services/shared-workspace/private-files.mjs";
import { RemoteHubLink } from "../services/mcp/shared-https.ts";
import {
  requestSchema,
  resultSchema,
  maintenanceId,
} from "../src/communication/maintenance-protocol.ts";
const { values } = parseArgs({
  options: {
    binding: { type: "string" },
    target: { type: "string" },
    action: { type: "string" },
    release: { type: "string" },
    "request-id": { type: "string" },
    wait: { type: "boolean" },
    result: { type: "string" },
  },
});
if (!values.binding) throw Error("Private --binding file required");
const bindingFile = privateFile(values.binding);
const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
const link = new RemoteHubLink(binding.endpoint, binding.key);
const id = values.result
  ? maintenanceId.parse(values.result)
  : values["request-id"]
    ? maintenanceId.parse(values["request-id"])
    : randomUUID();
try {
  if (!values.result) {
    const spool = path.join(path.dirname(bindingFile), `maintenance-request-${id}.json`);
    const request = requestSchema.parse(
      fs.existsSync(spool)
        ? JSON.parse(fs.readFileSync(privateFile(spool), "utf8"))
        : {
            requestId: id,
            target: values.target,
            action: values.action,
            ...(values.release ? { release: values.release } : {}),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
    );
    if (
      (values.target && values.target !== request.target) ||
      (values.action && values.action !== request.action) ||
      (values.release && values.release !== request.release)
    )
      throw Error("Request identity conflict");
    if (!fs.existsSync(spool))
      fs.writeFileSync(spool, JSON.stringify(request, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(await link.maintenance({ op: "maintenance_submit", request })));
  }
  if (values.result || values.wait) {
    const deadline = Date.now() + (values.wait ? 300000 : 0);
    for (;;) {
      const response = await link.maintenance({ op: "maintenance_get", requestId: id });
      const result = response.result ? resultSchema.parse(response.result) : null;
      if (result && ["verified", "failed", "refused"].includes(result.state)) {
        console.log(JSON.stringify(response));
        if (result.state !== "verified") process.exitCode = 1;
        break;
      }
      if (!values.wait || Date.now() >= deadline) {
        console.log(JSON.stringify(response));
        process.exitCode = 2;
        break;
      }
      await pause(1000);
    }
  }
} catch {
  console.log(
    JSON.stringify({
      requestId: id,
      delivery: "unknown",
      error: "transport_or_relay_refused",
      retry: "query_result_before_resubmitting",
    }),
  );
  process.exitCode = 1;
}
