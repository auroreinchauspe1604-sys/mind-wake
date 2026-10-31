/** Typed control plane. Message bodies are never parsed by this protocol. */
import * as z from "zod";
import { PROFILE_STATES } from "../contracts/lifecycle.js";
export const maintenanceRef = z.string().regex(/^(agent|human)-[a-z2-9]{10}$/);
export const maintenanceId = z.uuid();
export const maintenanceAction = z.enum([
  "diagnose",
  "pull_source",
  "relaunch_app",
  "relaunch_mcp",
  "relaunch_engine",
  "reinstall",
]);
export type MaintenanceAction = z.infer<typeof maintenanceAction>;
export const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const requestSchema = z.strictObject({
  requestId: maintenanceId,
  target: maintenanceRef,
  action: maintenanceAction,
  release: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/)
    .optional(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type MaintenanceRequest = z.infer<typeof requestSchema>;
export const componentSchema = z.strictObject({
  state: z.enum(["running", "stopped", "unknown"]),
  loadedRevision: revision.nullable(),
  // Only build identity/hash, never executable paths or process arguments.
  artifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  instance: z.uuid().nullable(),
});
export const observationSchema = z.strictObject({
  at: z.iso.datetime(),
  wake: z.enum([...PROFILE_STATES, "unknown"]),
  forceOff: z.boolean().nullable(),
  openSessions: z.int().min(0).nullable(),
  components: z.strictObject({
    app: componentSchema,
    daemon: componentSchema,
    mcp: componentSchema,
  }),
  sourceRevision: revision.nullable(),
  installedRevision: revision.nullable(),
  health: z
    .strictObject({
      sampledEvents: z.int().min(0),
      failedEvents: z.int().min(0),
      latestFailureAt: z.iso.datetime().nullable(),
      lastSessionOutcome: z.enum(["completed", "failed", "interrupted", "other"]).nullable(),
      ownerReceivedAt: z.iso.datetime().nullable(),
      ownerEmittedAt: z.iso.datetime().nullable(),
      ownerPublishedAt: z.iso.datetime().nullable(),
    })
    .optional(),
});
export type Observation = z.infer<typeof observationSchema>;
export const resultSchema = z.strictObject({
  requestId: maintenanceId,
  actor: maintenanceRef,
  target: maintenanceRef,
  action: maintenanceAction,
  at: z.iso.datetime(),
  state: z.enum(["accepted", "running", "restart_pending", "verified", "failed", "refused"]),
  code: z.enum([
    "ok",
    "unauthorized",
    "wrong_target",
    "expired",
    "paused",
    "unsupported",
    "busy",
    "interrupted",
    "verification_failed",
    "adapter_failed",
    "release_unknown",
    "cooldown",
    "source_dirty",
    "source_diverged",
    "source_mismatch",
    "revision_mismatch",
    "cancelled",
  ]),
  expectedRevision: revision.nullable(),
  verificationScope: z.array(z.enum(["diagnostic", "source", "install", "app", "daemon", "mcp"])),
  versionComparison: z.strictObject({
    app: z.enum(["matches", "differs", "unknown", "not_requested"]),
    daemon: z.enum(["matches", "differs", "unknown", "not_requested"]),
    mcp: z.enum(["matches", "differs", "unknown", "not_requested"]),
  }),
  observation: observationSchema.nullable(),
  capabilities: z.array(maintenanceAction),
  authorizedActions: z.array(maintenanceAction),
  lastOperation: z
    .strictObject({
      requestId: maintenanceId,
      action: maintenanceAction,
      state: z.enum(["accepted", "running", "restart_pending", "verified", "failed", "refused"]),
      at: z.iso.datetime(),
    })
    .nullable(),
  // No raw exception strings, logs, conversations or prompts on this surface.
  recentErrors: z.array(z.enum(["adapter_failed", "verification_failed", "interrupted"])).max(10),
  limits: z.array(
    z.enum([
      "loaded_versions_unavailable",
      "controller_required",
      "unowned_lifecycle",
      "local_release_catalog_required",
      "runtime_errors_unavailable",
    ]),
  ),
});
export type MaintenanceResult = z.infer<typeof resultSchema>;
export const maintenanceWire = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("maintenance_submit"), id: z.int(), request: requestSchema }),
  z.strictObject({ op: z.literal("maintenance_poll"), id: z.int() }),
  z.strictObject({ op: z.literal("maintenance_publish"), id: z.int(), result: resultSchema }),
  z.strictObject({ op: z.literal("maintenance_get"), id: z.int(), requestId: maintenanceId }),
]);
export type MaintenanceCall =
  z.infer<typeof maintenanceWire> extends infer T
    ? T extends { id: number }
      ? Omit<T, "id">
      : never
    : never;
