import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { init } from "../../src/cli/commands/init.js";
import { processContext, DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { toUtcTimestamp, prepareJournalEvent } from "../../src/journal/index.js";
import { StopFlag } from "../../src/runner/controls.js";
import {
  MaintenanceController,
  type MaintenanceAdapter,
  type MaintenancePolicy,
} from "../../services/maintenance/controller.js";
import { LocalMaintenanceAdapter } from "../../services/maintenance/local-adapter.js";
import {
  requestSchema,
  type MaintenanceRequest,
  type Observation,
} from "../../src/communication/maintenance-protocol.js";
const actor = "agent-aaaaaaaaaa",
  target = "agent-bbbbbbbbbb",
  rev = "a".repeat(40);
const unknown = () => ({
  state: "unknown" as const,
  loadedRevision: null,
  artifactSha256: null,
  instance: null,
});
const snapshot = (): Observation => ({
  at: new Date().toISOString(),
  wake: "ready",
  forceOff: false,
  openSessions: 0,
  components: { app: unknown(), daemon: unknown(), mcp: unknown() },
  sourceRevision: null,
  installedRevision: null,
});
function request(action: MaintenanceRequest["action"] = "diagnose"): MaintenanceRequest {
  return {
    requestId: randomUUID(),
    target,
    action,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
function fixture() {
  const root = resolve(".local/remote-maintenance");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "controller-"));
  let observation = snapshot(),
    calls = 0;
  const policy: MaintenancePolicy = {
    target,
    sharedEndpoint: "https://fixture.invalid/v1/messages",
    grants: [{ actor, actions: ["diagnose", "relaunch_app", "reinstall", "pull_source"] }],
    releases: { stable: { revision: rev } },
  };
  const adapter: MaintenanceAdapter = {
    capabilities: () => ["diagnose", "relaunch_app", "reinstall", "pull_source"],
    observe: () => Promise.resolve(structuredClone(observation)),
    execute: () => {
      calls++;
      observation.components.app = {
        state: "running",
        loadedRevision: rev,
        artifactSha256: "b".repeat(64),
        instance: randomUUID(),
      };
      return Promise.resolve();
    },
  };
  const file = join(dir, "controller.sqlite");
  const c = new MaintenanceController(file, () => policy, adapter);
  return {
    dir,
    file,
    c,
    adapter,
    policy,
    get calls() {
      return calls;
    },
    get o() {
      return observation;
    },
    set o(value: Observation) {
      observation = value;
    },
    close() {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
it("diagnostic reads real read-only Wake status, never claims HEAD as a loaded version", async () => {
  const f = fixture();
  try {
    const local = new LocalMaintenanceAdapter({
      dataDir: join(f.dir, "no-profile"),
      repoDir: process.cwd(),
    });
    const o = await local.observe();
    expect(o.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(o.wake).toBe("unknown");
    expect(o.components.app.loadedRevision).toBeNull();
    expect(o.components.daemon.loadedRevision).toBeNull();
    expect(local.capabilities()).toEqual(["diagnose"]);
    expect(JSON.stringify(o)).not.toContain(process.cwd());
  } finally {
    f.close();
  }
});
it.each([true, false])(
  "reinstall verifies all previously owned components, stale engine=%s",
  async (stale) => {
    const f = fixture();
    try {
      f.policy.grants[0]?.actions.push("relaunch_engine", "relaunch_mcp");
      f.adapter.capabilities = () => [
        "diagnose",
        "reinstall",
        "relaunch_app",
        "relaunch_engine",
        "relaunch_mcp",
      ];
      const old = {
        state: "running" as const,
        instance: randomUUID(),
        loadedRevision: "c".repeat(40),
        artifactSha256: "d".repeat(64),
      };
      f.o.components.daemon = { ...old };
      f.o.components.mcp = { ...old, instance: randomUUID() };
      f.adapter.execute = () => {
        f.o.installedRevision = rev;
        for (const component of ["app", "mcp", ...(!stale ? ["daemon" as const] : [])] as const)
          f.o.components[component] = {
            state: "running",
            instance: randomUUID(),
            loadedRevision: rev,
            artifactSha256: "e".repeat(64),
          };
        return Promise.resolve();
      };
      const r = { ...request("reinstall"), release: "stable" };
      f.c.accept(actor, r);
      const result = await f.c.run(r.requestId);
      expect(result.state).toBe(stale ? "failed" : "verified");
      expect(result.verificationScope).toEqual(stale ? [] : ["install", "app", "daemon", "mcp"]);
    } finally {
      f.close();
    }
  },
);

it("real SQLite fixture profile is readable when disabled and paused without starting a model", async () => {
  const f = fixture();
  try {
    const dataDir = join(f.dir, "profile"),
      ctx = processContext();
    init(ctx, { path: dataDir, source: "option" });
    const local = new LocalMaintenanceAdapter({ dataDir, repoDir: process.cwd() });
    expect((await local.observe()).wake).toBe("disabled");
    const store = ctx.openStore(dataDir, "write");
    try {
      store.uow.transaction((tx) => {
        const at = toUtcTimestamp(new Date());
        tx.profiles.transition(DEFAULT_PROFILE_ID, {
          from: "disabled",
          to: "ready",
          reason: "fixture setup only",
          at,
        });
        tx.profiles.transition(DEFAULT_PROFILE_ID, {
          from: "ready",
          to: "paused",
          reason: "fixture pause",
          at,
        });
      });
    } finally {
      store.close();
    }
    const paused = await local.observe();
    expect(paused.wake).toBe("paused");
    expect(paused.openSessions).toBe(0);
    expect(paused.forceOff).toBe(false);
    new StopFlag(dataDir).write("fixture emergency stop", toUtcTimestamp(new Date()));
    expect(local.controlState().forceOff).toBe(true);
    expect((await local.observe()).forceOff).toBe(true);
  } finally {
    f.close();
  }
});
it("diagnostic counts real runtime failures without exporting their private reasons", async () => {
  const f = fixture();
  try {
    const dataDir = join(f.dir, "health"),
      ctx = processContext();
    init(ctx, { path: dataDir, source: "option" });
    const store = ctx.openStore(dataDir, "write");
    try {
      store.uow.journal.append(
        prepareJournalEvent({
          profileId: DEFAULT_PROFILE_ID,
          type: "session_ended",
          at: toUtcTimestamp(new Date()),
          reason: "fixture-private-error-body",
          metadata: { outcome: "failed" },
        }),
      );
    } finally {
      store.close();
    }
    const health = await new LocalMaintenanceAdapter({ dataDir, repoDir: process.cwd() }).observe();
    expect(health.health?.failedEvents).toBe(1);
    expect(health.health?.latestFailureAt).toBeTruthy();
    expect(JSON.stringify(health)).not.toContain("fixture-private-error-body");
  } finally {
    f.close();
  }
});
it("refuses ungranted actor, message-only, wrong target, expired/future/oversize TTL and arbitrary input", () => {
  const f = fixture();
  try {
    expect(f.c.accept("agent-cccccccccc", request()).code).toBe("unauthorized");
    f.policy.grants = [];
    expect(f.c.accept(actor, request()).code).toBe("unauthorized");
    expect(f.c.accept(actor, { ...request(), target: actor }).code).toBe("wrong_target");
    f.policy.grants = [{ actor, actions: ["diagnose"] }];
    expect(
      f.c.accept(actor, { ...request(), expiresAt: new Date(Date.now() - 1000).toISOString() })
        .code,
    ).toBe("expired");
    expect(
      f.c.accept(actor, { ...request(), issuedAt: new Date(Date.now() + 50_000).toISOString() })
        .code,
    ).toBe("expired");
    expect(
      f.c.accept(actor, { ...request(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
        .code,
    ).toBe("expired");
    expect(() => requestSchema.parse({ ...request(), shell: "restart everything" })).toThrow();
    expect(() => f.c.accept(actor, "relaunch_app")).toThrow();
    expect(f.calls).toBe(0);
  } finally {
    f.close();
  }
});
it("durable idempotence, correlation conflict, one operation, concurrent run and cooldown", async () => {
  const f = fixture();
  try {
    const r = request("relaunch_app");
    expect(f.c.accept(actor, r).state).toBe("accepted");
    expect(f.c.accept(actor, request()).code).toBe("busy");
    expect(() => f.c.accept(actor, { ...r, action: "diagnose" })).toThrow("request_conflict");
    const [a, b] = await Promise.all([f.c.run(r.requestId), f.c.run(r.requestId)]);
    expect(a.state).toBe("verified");
    expect(b).toEqual(a);
    expect(f.calls).toBe(1);
    const second = new MaintenanceController(f.file, () => f.policy, f.adapter);
    try {
      expect(second.accept(actor, r)).toEqual(a);
      expect(await second.run(r.requestId)).toEqual(a);
    } finally {
      second.close();
    }
    expect(f.c.accept(actor, request("relaunch_app")).code).toBe("cooldown");
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});
it("Pause permits granted diagnostic but blocks mutations; revocation is checked after queuing", async () => {
  const f = fixture();
  try {
    f.o.wake = "paused";
    const d = request();
    f.c.accept(actor, d);
    expect((await f.c.run(d.requestId)).state).toBe("verified");
    const m = request("relaunch_app");
    f.c.accept(actor, m);
    expect((await f.c.run(m.requestId)).code).toBe("paused");
    f.o.wake = "ready";
    f.o.forceOff = true;
    const stop = request("relaunch_app");
    f.c.accept(actor, stop);
    expect((await f.c.run(stop.requestId)).code).toBe("paused");
    f.o.forceOff = false;
    const revoked = request("relaunch_app");
    f.c.accept(actor, revoked);
    f.policy.grants = [];
    expect((await f.c.run(revoked.requestId)).code).toBe("unauthorized");
    expect(f.calls).toBe(0);
  } finally {
    f.close();
  }
});

it("existing instance lock excludes a second live controller and store binds identity to its hub", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = new MaintenanceController(f.file, () => f.policy, f.adapter);
  try {
    f.adapter.execute = () => gate;
    const r = request("relaunch_app");
    f.c.accept(actor, r);
    const running = f.c.run(r.requestId);
    expect(() => other.run(r.requestId)).toThrow();
    release?.();
    await running;
    const moved = { ...f.policy, sharedEndpoint: "https://other.invalid/v1/messages" };
    expect(() => new MaintenanceController(f.file, () => moved, f.adapter)).toThrow(
      "binding mismatch",
    );
  } finally {
    other.close();
    f.close();
  }
});
it("does not confuse exit0, source revision, old process or wrong loaded version with success", async () => {
  for (const mode of ["no_action", "same_instance", "wrong_revision"] as const) {
    const f = fixture();
    try {
      f.o.components.app = {
        state: "running",
        loadedRevision: rev,
        artifactSha256: null,
        instance: randomUUID(),
      };
      f.o.sourceRevision = rev;
      f.adapter.execute = () => {
        if (mode === "wrong_revision")
          f.o.components.app = {
            ...f.o.components.app,
            loadedRevision: "b".repeat(40),
            instance: randomUUID(),
          };
        return Promise.resolve();
      };
      const r = { ...request("relaunch_app"), release: "stable" };
      f.c.accept(actor, r);
      expect((await f.c.run(r.requestId)).code).toBe("verification_failed");
    } finally {
      f.close();
    }
  }
});
it("recovers handoff from durable state without executing twice; uncertain running is not replayed", async () => {
  const f = fixture();
  try {
    const r = request("relaunch_app");
    const receipt = f.c.accept(actor, r);
    const old = snapshot();
    f.c.db
      .prepare("UPDATE operations SET state='restart_pending',result=?,before_state=? WHERE id=?")
      .run(
        JSON.stringify({ ...receipt, state: "restart_pending" }),
        JSON.stringify(old),
        r.requestId,
      );
    f.o.components.app = {
      state: "running",
      loadedRevision: rev,
      artifactSha256: null,
      instance: randomUUID(),
    };
    const resumed = new MaintenanceController(f.file, () => f.policy, f.adapter);
    try {
      expect((await resumed.run(r.requestId)).state).toBe("verified");
    } finally {
      resumed.close();
    }
    expect(f.calls).toBe(0);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    const r = request("pull_source"),
      receipt = g.c.accept(actor, { ...r, release: "stable" });
    g.c.db
      .prepare("UPDATE operations SET state='running',result=? WHERE id=?")
      .run(JSON.stringify({ ...receipt, state: "running" }), r.requestId);
    expect((await g.c.run(r.requestId)).code).toBe("interrupted");
    expect(g.calls).toBe(0);
  } finally {
    g.close();
  }
});
it("revocation during adapter work aborts it and strips raw errors", async () => {
  const f = fixture();
  try {
    f.adapter.execute = async (_r, _v, signal) => {
      f.policy.grants = [];
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      throw Error("PRIVATE_SECRET C:/Users/private/token prompt");
    };
    const r = request("relaunch_app");
    f.c.accept(actor, r);
    const result = await f.c.run(r.requestId);
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
  } finally {
    f.close();
  }
});
