/** Durable relay only. The hub cannot grant maintenance authority on a target. */
import Database from "better-sqlite3";
import {
  maintenanceWire,
  type MaintenanceResult,
  type MaintenanceRequest,
} from "../../src/communication/maintenance-protocol.js";
import { HubError } from "../mcp/protocol.js";

export class MaintenanceRelay {
  readonly db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS maintenance(id TEXT PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, request TEXT NOT NULL, result TEXT)",
    );
  }
  close(): void {
    this.db.close();
  }
  parse(raw: unknown): { id: number } | null {
    const parsed = maintenanceWire.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  handle(actor: string, raw: unknown): unknown {
    const call = maintenanceWire.parse(raw);
    return this.db
      .transaction(() => {
        if (call.op === "maintenance_submit") {
          const prior = this.row(call.request.requestId);
          if (prior) {
            if (prior.actor !== actor || prior.request !== JSON.stringify(call.request))
              throw new HubError("bad_request", "Maintenance request conflict.");
            return { delivery: "relay_stored", requestId: call.request.requestId, duplicate: true };
          }
          const now = Date.now(),
            start = Date.parse(call.request.issuedAt),
            end = Date.parse(call.request.expiresAt);
          if (start > now + 30_000 || end <= now || end <= start || end - start > 300_000)
            throw new HubError("bad_request", "Maintenance request expired or invalid TTL.");
          const pending = this.db
            .prepare(
              "SELECT count(*) AS n FROM maintenance WHERE actor=? AND (result IS NULL OR json_extract(result,'$.state') IN ('accepted','running','restart_pending'))",
            )
            .get(actor) as { n: number };
          if (pending.n >= 100) throw new HubError("rate_limited", "Maintenance queue full.");
          this.db
            .prepare("INSERT INTO maintenance(id,actor,target,request) VALUES(?,?,?,?)")
            .run(call.request.requestId, actor, call.request.target, JSON.stringify(call.request));
          return { delivery: "relay_stored", requestId: call.request.requestId, duplicate: false };
        }
        if (call.op === "maintenance_poll") {
          const rows = this.db
            .prepare(
              "SELECT actor,request FROM maintenance WHERE target=? AND (result IS NULL OR json_extract(result,'$.state') IN ('accepted','running','restart_pending')) ORDER BY rowid LIMIT 20",
            )
            .all(actor) as { actor: string; request: string }[];
          return {
            requests: rows.map((r) => ({
              actor: r.actor,
              request: JSON.parse(r.request) as MaintenanceRequest,
            })),
          };
        }
        const id = call.op === "maintenance_get" ? call.requestId : call.result.requestId;
        const row = this.row(id);
        if (!row || (call.op === "maintenance_get" ? row.actor !== actor : row.target !== actor))
          throw new HubError("permission_denied", "Maintenance request unavailable.");
        if (call.op === "maintenance_get")
          return {
            delivery: row.result ? "target_reported" : "relay_stored_target_unconfirmed",
            result: row.result ? (JSON.parse(row.result) as MaintenanceResult) : null,
          };
        const request = JSON.parse(row.request) as MaintenanceRequest;
        if (
          call.result.actor !== row.actor ||
          call.result.target !== actor ||
          call.result.action !== request.action
        )
          throw new HubError("bad_request", "Maintenance result correlation mismatch.");
        if (row.result) {
          const prior = JSON.parse(row.result) as MaintenanceResult;
          const rank = {
            accepted: 0,
            running: 1,
            restart_pending: 2,
            verified: 3,
            failed: 3,
            refused: 3,
          };
          if (rank[call.result.state] < rank[prior.state])
            throw new HubError("bad_request", "Maintenance state regression.");
        }
        if (
          row.result &&
          ["verified", "failed", "refused"].includes(
            (JSON.parse(row.result) as MaintenanceResult).state,
          )
        ) {
          if (row.result !== JSON.stringify(call.result))
            throw new HubError("bad_request", "Terminal result is immutable.");
        } else
          this.db
            .prepare("UPDATE maintenance SET result=? WHERE id=?")
            .run(JSON.stringify(call.result), id);
        return { delivery: "result_stored", requestId: id };
      })
      .immediate();
  }
  private row(
    id: string,
  ): { actor: string; target: string; request: string; result: string | null } | undefined {
    return this.db.prepare("SELECT * FROM maintenance WHERE id=?").get(id) as ReturnType<
      MaintenanceRelay["row"]
    >;
  }
}
