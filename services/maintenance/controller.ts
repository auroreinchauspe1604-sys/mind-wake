import Database from "better-sqlite3";
import * as z from "zod";
import { readFileSync } from "node:fs";
import { acquireInstanceLock } from "../../src/scheduler/instance-lock.js";
import {
  maintenanceAction,
  maintenanceRef,
  requestSchema,
  resultSchema,
  observationSchema,
  revision,
  type MaintenanceRequest,
  type MaintenanceResult,
  type MaintenanceAction,
  type Observation,
} from "../../src/communication/maintenance-protocol.js";

export const localPolicySchema = z.strictObject({
  target: maintenanceRef,
  sharedEndpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/v1/messages" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  grants: z.array(z.strictObject({ actor: maintenanceRef, actions: z.array(maintenanceAction) })),
  releases: z.record(
    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    z.strictObject({ revision }),
  ),
});
export type MaintenancePolicy = z.infer<typeof localPolicySchema>;
export class MaintenanceAdapterError extends Error {
  constructor(
    readonly code: "source_dirty" | "source_diverged" | "source_mismatch" | "revision_mismatch",
    message: string,
  ) {
    super(message);
  }
}
export const readMaintenancePolicy = (file: string): MaintenancePolicy =>
  localPolicySchema.parse(JSON.parse(readFileSync(file, "utf8")));
export interface MaintenanceAdapter {
  /** Must describe only lifecycles actually owned by the embedding supervisor. */
  capabilities(): MaintenanceAction[];
  observe(): Promise<Observation>;
  controlState?(): Pick<Observation, "wake" | "forceOff">;
  /** Called only for mutations. Abort must stop owned work, never resume Wake. */
  execute(request: MaintenanceRequest, expected: string | null, signal: AbortSignal): Promise<void>;
}
type RecordRow = { actor: string; request: string; result: string; before_state: string | null };
const active = "('accepted','running','restart_pending')";
export class MaintenanceController {
  readonly db: Database.Database;
  readonly binding: string;
  readonly inFlight = new Map<string, Promise<MaintenanceResult>>();
  constructor(
    readonly file: string,
    readonly policy: () => MaintenancePolicy,
    readonly adapter: MaintenanceAdapter,
  ) {
    const local = localPolicySchema.parse(policy());
    this.binding = JSON.stringify([local.sharedEndpoint, local.target]);
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, actor TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, state TEXT NOT NULL, before_state TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active ON operations((1)) WHERE state IN ${active}`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS controller_binding(id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL)",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO controller_binding(id,binding) VALUES(1,?)")
      .run(this.binding);
    const stored = this.db.prepare("SELECT binding FROM controller_binding WHERE id=1").get() as {
      binding: string;
    };
    if (stored.binding !== this.binding) {
      this.db.close();
      throw Error("Maintenance store identity/endpoint binding mismatch");
    }
  }
  close(): void {
    this.db.close();
  }
  private row(id: string): RecordRow | undefined {
    return this.db.prepare("SELECT * FROM operations WHERE id=?").get(id) as RecordRow | undefined;
  }
  private authorized(actor: string, r: MaintenanceRequest): boolean {
    const p = localPolicySchema.parse(this.policy());
    return (
      JSON.stringify([p.sharedEndpoint, p.target]) === this.binding &&
      p.target === r.target &&
      p.grants.some((g) => g.actor === actor && g.actions.includes(r.action))
    );
  }
  private fresh(r: MaintenanceRequest): boolean {
    const now = Date.now(),
      start = Date.parse(r.issuedAt),
      end = Date.parse(r.expiresAt);
    return start <= now + 30_000 && end > now && end > start && end - start <= 300_000;
  }
  private base(actor: string, r: MaintenanceRequest): MaintenanceResult {
    return {
      requestId: r.requestId,
      actor,
      target: r.target,
      action: r.action,
      at: new Date().toISOString(),
      state: "accepted",
      code: "ok",
      expectedRevision: null,
      verificationScope: [],
      versionComparison: { app: "not_requested", daemon: "not_requested", mcp: "not_requested" },
      observation: null,
      capabilities: [],
      recentErrors: [],
      limits: [
        "loaded_versions_unavailable",
        "controller_required",
        "unowned_lifecycle",
        "local_release_catalog_required",
        "runtime_errors_unavailable",
      ],
      authorizedActions: [],
      lastOperation: null,
    };
  }
  private save(result: MaintenanceResult): MaintenanceResult {
    for (const component of ["app", "daemon", "mcp"] as const) {
      const loaded = result.observation?.components[component].loadedRevision;
      result.versionComparison[component] = !result.expectedRevision
        ? "not_requested"
        : !loaded
          ? "unknown"
          : loaded === result.expectedRevision
            ? "matches"
            : "differs";
    }
    const value = resultSchema.parse({ ...result, at: new Date().toISOString() });
    this.db
      .prepare("UPDATE operations SET state=?, result=? WHERE id=?")
      .run(value.state, JSON.stringify(value), value.requestId);
    return value;
  }
  accept(actor: string, input: unknown): MaintenanceResult {
    const r = requestSchema.parse(input);
    maintenanceRef.parse(actor);
    return this.db
      .transaction(() => {
        const prior = this.row(r.requestId);
        if (prior && (prior.actor !== actor || prior.request !== JSON.stringify(r)))
          throw Error("request_conflict");
        if (prior) return resultSchema.parse(JSON.parse(prior.result));
        const result = this.base(actor, r);
        let p: MaintenancePolicy;
        try {
          p = localPolicySchema.parse(this.policy());
        } catch {
          p = {
            target: r.target,
            sharedEndpoint: "https://invalid.invalid/v1/messages",
            grants: [],
            releases: {},
          };
        }
        if (JSON.stringify([p.sharedEndpoint, p.target]) !== this.binding) {
          result.state = "refused";
          result.code = "unauthorized";
        } else if (p.target !== r.target) {
          result.state = "refused";
          result.code = "wrong_target";
        } else if (!p.grants.some((g) => g.actor === actor && g.actions.includes(r.action))) {
          result.state = "refused";
          result.code = "unauthorized";
        } else if (!this.fresh(r)) {
          result.state = "refused";
          result.code = "expired";
        } else if (this.db.prepare(`SELECT 1 FROM operations WHERE state IN ${active}`).get()) {
          result.state = "refused";
          result.code = "busy";
        } else if (
          r.action !== "diagnose" &&
          this.db
            .prepare(
              "SELECT 1 FROM operations WHERE json_extract(request,'$.action') <> 'diagnose' AND state IN ('verified','failed') AND json_extract(result,'$.at') > ?",
            )
            .get(new Date(Date.now() - 10_000).toISOString())
        ) {
          result.state = "refused";
          result.code = "cooldown";
        }
        if (result.state === "accepted" && r.release) {
          result.expectedRevision = p.releases[r.release]?.revision ?? null;
          if (!result.expectedRevision) {
            result.state = "refused";
            result.code = "release_unknown";
          }
        }
        if (
          result.state === "accepted" &&
          ["pull_source", "reinstall"].includes(r.action) &&
          !result.expectedRevision
        ) {
          result.state = "refused";
          result.code = "release_unknown";
        }
        this.db
          .prepare("INSERT INTO operations(id,actor,request,result,state) VALUES(?,?,?,?,?)")
          .run(r.requestId, actor, JSON.stringify(r), JSON.stringify(result), result.state);
        return result;
      })
      .immediate();
  }
  run(
    id: string,
    progress?: (result: MaintenanceResult) => Promise<void>,
  ): Promise<MaintenanceResult> {
    const prior = this.inFlight.get(id);
    if (prior) return prior;
    // Existing OS-released SQLite instance lock: no stale PID lock after crash,
    // and a second controller cannot prematurely reconcile a live handoff.
    const lock = acquireInstanceLock(`${this.file}.controller-lock`);
    const work = this.runOnce(id, progress).finally(() => {
      lock.release();
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, work);
    return work;
  }
  private async runOnce(
    id: string,
    progress?: (result: MaintenanceResult) => Promise<void>,
  ): Promise<MaintenanceResult> {
    const row = this.row(id);
    if (!row) throw Error("unknown_request");
    const r = requestSchema.parse(JSON.parse(row.request));
    let result = resultSchema.parse(JSON.parse(row.result));
    if (["verified", "failed", "refused"].includes(result.state)) return result;
    const fail = (code: MaintenanceResult["code"], state: "failed" | "refused" = "refused") =>
      this.save({ ...result, state, code });
    try {
      if (!this.authorized(row.actor, r)) return fail("unauthorized");
      if (r.release && this.policy().releases[r.release]?.revision !== result.expectedRevision)
        return fail("release_unknown");
      // TTL gates starting actions; recovery of an already handed-off restart only observes.
      if (result.state === "accepted" && !this.fresh(r)) return fail("expired");
      result.observation = observationSchema.parse(await this.adapter.observe());
      result.capabilities = this.adapter.capabilities();
      result.authorizedActions = result.capabilities.filter((a) =>
        this.policy().grants.some((g) => g.actor === row.actor && g.actions.includes(a)),
      );
      const recent = this.db
        .prepare("SELECT result FROM operations WHERE id<>? ORDER BY rowid DESC LIMIT 10")
        .all(id) as { result: string }[];
      const history = recent.map((r) => resultSchema.parse(JSON.parse(r.result)));
      const last = history[0];
      result.lastOperation = last
        ? { requestId: last.requestId, action: last.action, state: last.state, at: last.at }
        : null;
      result.recentErrors = history
        .flatMap((r) =>
          r.code === "adapter_failed" ||
          r.code === "verification_failed" ||
          r.code === "interrupted"
            ? [r.code]
            : [],
        )
        .slice(0, 10);
      if (r.action === "diagnose")
        return this.save({ ...result, state: "verified", verificationScope: ["diagnostic"] });
      if (
        !["ready", "running", "hibernating"].includes(result.observation.wake) ||
        result.observation.forceOff !== false
      )
        return fail("paused");
      if (!result.capabilities.includes(r.action)) return fail("unsupported");
      if (result.state === "running") return fail("interrupted", "failed");
      if (result.state === "restart_pending") return await this.verify(result, r, row.before_state);
      const before = JSON.stringify(result.observation);
      // Atomic claim prevents two ticks/processes from executing the same operation.
      const claimed = this.db
        .prepare(
          "UPDATE operations SET state='running',result=?,before_state=? WHERE id=? AND state='accepted'",
        )
        .run(JSON.stringify({ ...result, state: "running" }), before, id);
      if (claimed.changes !== 1) {
        const current = this.row(id);
        if (!current) throw Error("unknown_request");
        return resultSchema.parse(JSON.parse(current.result));
      }
      result = { ...result, state: "running" };
      // Persist intent BEFORE handoff. On interruption only verify, never blindly restart.
      if (r.action.startsWith("relaunch_") || r.action === "reinstall")
        result = this.save({ ...result, state: "restart_pending" });
      await progress?.(result);
      const stop = new AbortController();
      const permitted = async () => {
        if (!this.authorized(row.actor, r)) throw Error("revoked");
        if (r.release && this.policy().releases[r.release]?.revision !== result.expectedRevision)
          throw Error("release revoked");
        const o =
          this.adapter.controlState?.() ?? observationSchema.parse(await this.adapter.observe());
        if (!["ready", "running", "hibernating"].includes(o.wake) || o.forceOff !== false)
          throw Error("stopped");
      };
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void permitted()
          .catch(() => {
            stop.abort();
          })
          .finally(() => {
            checking = false;
          });
      }, 50);
      try {
        await permitted();
        await this.adapter.execute(r, result.expectedRevision, stop.signal);
        await permitted();
        if (stop.signal.aborted) throw Error("stopped");
      } finally {
        clearInterval(timer);
      }
      return await this.verify(result, r, before);
    } catch (error) {
      return this.save({
        ...result,
        state: "failed",
        code: error instanceof MaintenanceAdapterError ? error.code : "adapter_failed",
        recentErrors: ["adapter_failed"],
      });
    }
  }
  private async verify(
    result: MaintenanceResult,
    r: MaintenanceRequest,
    before: string | null,
  ): Promise<MaintenanceResult> {
    const observation = observationSchema.parse(await this.adapter.observe());
    if (!this.authorized(result.actor, r))
      return this.save({
        ...result,
        observation,
        state: "failed",
        code: "unauthorized",
        verificationScope: [],
      });
    if (
      !["ready", "running", "hibernating"].includes(observation.wake) ||
      observation.forceOff !== false
    )
      return this.save({
        ...result,
        observation,
        state: "failed",
        code: "paused",
        verificationScope: [],
      });
    const old = before ? observationSchema.parse(JSON.parse(before)) : null;
    let ok = false;
    if (r.action === "pull_source")
      ok =
        result.expectedRevision !== null && observation.sourceRevision === result.expectedRevision;
    const key = {
      relaunch_app: "app",
      relaunch_mcp: "mcp",
      relaunch_engine: "daemon",
      reinstall: "app",
    }[r.action as "relaunch_app"] as "app" | "mcp" | "daemon" | undefined;
    if (key) {
      const c = observation.components[key];
      ok =
        c.state === "running" &&
        c.instance !== null &&
        c.instance !== old?.components[key].instance &&
        c.loadedRevision !== null &&
        (!result.expectedRevision || c.loadedRevision === result.expectedRevision);
      if (r.action === "reinstall")
        ok = ok && observation.installedRevision === result.expectedRevision;
    }
    return this.save({
      ...result,
      observation,
      verificationScope: ok
        ? r.action === "pull_source"
          ? ["source"]
          : r.action === "reinstall"
            ? ["install", "app"]
            : key
              ? [key]
              : []
        : [],
      state: ok ? "verified" : "failed",
      code: ok ? "ok" : "verification_failed",
      recentErrors: ok ? [] : ["verification_failed"],
    });
  }
  /** Re-publish durable results after a network/process interruption. */
  pending(): { actor: string; request: MaintenanceRequest }[] {
    return (
      this.db
        .prepare(`SELECT actor,request FROM operations WHERE state IN ${active}`)
        .all() as RecordRow[]
    ).map((r) => ({ actor: r.actor, request: requestSchema.parse(JSON.parse(r.request)) }));
  }
}
