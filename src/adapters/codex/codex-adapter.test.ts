/**
 * Adapter Codex contre un faux exécutable `codex` (test/fixtures/codex/fake-codex.ts) qui
 * rejoue des flux app-server enregistrés. Aucun appel modèle, aucun réseau, aucun
 * credential : ces tests ne prouvent pas l'intégration réelle (AGENTS §5).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  PolicyRevision,
  ProfileId,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import { defaultRegistry } from "../../daemon/registry.js";
import {
  enqueueOwnerMessage,
  readOwnerReceipts,
  takeOwnerMessages,
} from "../../communication/owner-inbox.js";
import { saveStepsResult, nextWakeStep } from "../../daemon/wake-steps.js";
import { appendRepoMessage } from "../../communication/repo-conversations.js";
import { readOwnerMessages } from "../../communication/owner-messages.js";
import { canReadQuota } from "../../runner/host.js";
import type { Sandbox } from "../../sandbox/sandbox.js";
import { SpawnedCodexProcess } from "../../../test/fixtures/codex/process.js";
import {
  appContainerLauncher,
  buildAppServerCommand,
  classifyCodexError,
  CODEX_ADAPTER_ID,
  CODEX_SUPPORTED_VERSION,
  CODEX_DEFAULT_MODEL,
  codexRegistration,
  codexRegistrationFromEnv,
  CodexAdapter,
  CodexAdapterError,
  CodexConfigError,
  FileThreadStore,
  hostLauncher,
  hostPassthroughEnv,
  MemoryThreadStore,
  parseCodexVersion,
  quotaFromRateLimitsResponse,
  type CodexAdapterOptions,
  type CodexCommand,
  type CodexLauncher,
  type IsolationAttestation,
  type ProviderTransport,
  type SandboxLike,
} from "./index.js";

const FAKE = fileURLToPath(new URL("../../../test/fixtures/codex/fake-codex.ts", import.meta.url));
const FLOWS = fileURLToPath(new URL("../../../test/fixtures/codex/flows/", import.meta.url));

interface Harness {
  readonly dir: string;
  readonly logPath: string;
  readonly launches: CodexCommand[];
  flow: string;
  attestation: IsolationAttestation;
  launcher: CodexLauncher;
  log(): Record<string, unknown>[];
  requests(method: string): Record<string, unknown>[];
}

const CONFINED: IsolationAttestation = {
  confined: true,
  selfTestPassed: true,
  detail: "AppContainer de test",
};

let h: Harness;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-codex-test-"));
  const logPath = path.join(dir, "fake-codex.log");
  const launches: CodexCommand[] = [];
  const harness: Harness = {
    dir,
    logPath,
    launches,
    flow: "success.json",
    attestation: CONFINED,
    launcher: {
      isolation: () => harness.attestation,
      launch: (_sessionId, command) => {
        launches.push(command);
        return new SpawnedCodexProcess(command, {
          FAKE_CODEX_FLOW: path.join(FLOWS, harness.flow),
          FAKE_CODEX_LOG: logPath,
        });
      },
    },
    log: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
    requests: (method) => harness.log().filter((e) => e["method"] === method),
  };
  fs.mkdirSync(path.join(dir, "codex-home"));
  fs.mkdirSync(path.join(dir, "workspace"));
  h = harness;
  fs.mkdirSync(path.join(path.join(h.dir, "workspace"), "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(path.join(h.dir, "workspace"), "artifacts/projets-compteur.json"),
    JSON.stringify({
      current: "A",
      projects: {
        A: { estimate: 40, spent: 2 },
        B: { estimate: 30, spent: 0, status: "en cours" },
      },
    }),
  );
});

afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const closed: ProviderTransport = {
  open: () =>
    Promise.resolve({
      configOverrides: { model_provider: '"wake_relay"' },
      env: { WAKE_RELAY_PIPE: "mindwake-broker-test" },
      close: () => Promise.resolve(),
    }),
};

/** Surcharges ; `undefined` retire l'option (par exemple le transport). */
type Overrides = { [K in keyof CodexAdapterOptions]?: CodexAdapterOptions[K] | undefined };

function adapter(overrides: Overrides = {}): CodexAdapter {
  const options: Record<string, unknown> = {
    executable: { path: process.execPath, prefixArgs: [FAKE] },
    codexHome: path.join(h.dir, "codex-home"),
    workspaceDir: path.join(h.dir, "workspace"),
    launcher: h.launcher,
    transport: closed,
    threads: new MemoryThreadStore(),
    systemPrompt: "Tu es l'agent Wake.",
    model: "gpt-test",
    effort: "medium",
    requestTimeoutMs: 5_000,
    versionCheck: () =>
      Promise.resolve(`codex-cli ${CODEX_SUPPORTED_VERSION}
`),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(options, key);
    else options[key] = value;
  }
  return new CodexAdapter(options as unknown as CodexAdapterOptions);
}

let counter = 0;
function request(profile = "profil-1"): StartRequest {
  counter += 1;
  return {
    sessionId: `session-${String(counter)}` as SessionId,
    reservationId: `res-${String(counter)}` as ReservationId,
    policy: {
      profileId: profile as ProfileId,
      groups: { runtime: {} },
    } as unknown as PolicyRevision,
    context: "Reprends l'expérience des automates.",
    maxInputTokens: 10_000,
    deadline: "2030-01-01T00:00:00.000Z" as UtcTimestamp,
  };
}

async function collect(a: CodexAdapter, req: StartRequest): Promise<AdapterEvent[]> {
  const handle = await a.start(req);
  const events: AdapterEvent[] = [];
  for await (const event of a.events(handle)) events.push(event);
  return events;
}

describe("protocole app-server", () => {
  it("accounts for planning usage arriving before the turn/start response", async () => {
    h.flow = "steps-stop-early-usage.json";
    let captured = "none";
    const subject = adapter({
      stepsStopHook: true,
      onStepsResult: (_req, raw) => {
        captured = raw;
        return false;
      },
    });
    const req = request();
    const events = await collect(subject, req);
    expect(
      events
        .filter((e) => e.type === "usage")
        .reduce((n, e) => n + (e.quantity.unit === "tokens" ? e.quantity.amount : 0), 0),
    ).toBe(460);
    expect(await subject.reconcile(req.sessionId)).toMatchObject({
      status: "confirmed",
      usage: [{ unit: "tokens", amount: 460 }],
    });
    expect(captured).toBe("correct planning response");
  });
  it.each([
    "steps-stop-no-usage.json",
    "steps-stop-no-work-usage.json",
    "steps-stop-missing-completion-id.json",
  ])("keeps the entire usage uncertain with missing reading (%s)", async (flow) => {
    h.flow = flow;
    const subject = adapter({ stepsStopHook: true });
    const req = request();
    const events = await collect(subject, req);
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
    expect(await subject.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });
  it("leaves human messages arriving during JSON planning unclaimed", async () => {
    h.flow = "steps-stop.json";
    let saved = 0;
    const subject = adapter({
      stepsStopHook: true,
      ownerInboxDir: h.dir,
      onStepsResult: () => {
        saved++;
        return true;
      },
    });
    const req = request();
    (req.policy.groups.runtime as { nativeCapabilities?: boolean }).nativeCapabilities = true;
    const handle = await subject.start(req);
    for await (const event of subject.events(handle)) {
      if (event.type === "activity" && event.summary.includes("bilan de fin de réponse"))
        enqueueOwnerMessage(h.dir, {
          id: "during-plan",
          at: new Date().toISOString(),
          text: "Stop this project",
        });
    }
    expect(readOwnerReceipts(h.dir)["during-plan"]).toBeUndefined();
    expect(h.requests("turn/steer")).toHaveLength(0);
    expect(saved).toBe(0);
  });
  it("keeps work completed when the optional planning result fails, with uncertain usage", async () => {
    h.flow = "steps-stop-error.json";
    const subject = adapter({ stepsStopHook: true });
    const req = request();
    const events = await collect(subject, req);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
    expect(await subject.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });
  it("cancels an in-progress planning turn without saving or scheduling a retry", async () => {
    h.flow = "steps-stop-hang.json";
    let calls = 0;
    const subject = adapter({
      stepsStopHook: true,
      onStepsResult: () => {
        calls++;
        return true;
      },
    });
    const req = request();
    const handle = await subject.start(req);
    for await (const event of subject.events(handle)) {
      if (event.type === "activity" && event.summary.includes("bilan de fin de réponse")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await subject.cancel(handle, 1000);
      }
    }
    expect(calls).toBe(0);
    expect(h.requests("turn/start")).toHaveLength(2);
    expect(await subject.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });
  it.each(["rate-limited.json", "stream-cut.json"])(
    "never runs the planning hook after %s",
    async (flow) => {
      h.flow = flow;
      let calls = 0;
      await collect(
        adapter({
          stepsStopHook: true,
          onStepsResult: () => {
            calls++;
            return true;
          },
        }),
        request(),
      );
      expect(h.requests("turn/start")).toHaveLength(1);
      expect(calls).toBe(0);
    },
  );
  it("runs exactly one automatic ÉTAPES turn in the same supervised session", async () => {
    h.flow = "steps-stop.json";
    let saved = 0;
    const subject = adapter({
      stepsStopHook: true,
      onStepsResult: (req, raw) => {
        saved++;
        return saveStepsResult(
          path.join(h.dir, "workspace"),
          h.dir,
          "agent-test",
          req.sessionId,
          raw,
        );
      },
    });
    const req = request();
    const events = await collect(subject, req);
    expect(h.requests("turn/start")).toHaveLength(2);
    expect(h.launches).toHaveLength(1);
    expect(saved).toBe(1);
    expect(
      events.filter((e) => e.type === "activity").some((e) => e.summary.includes('"horizonWakes"')),
    ).toBe(false);
    expect(events.filter((e) => e.type === "ended")).toHaveLength(1);
    expect(
      events
        .filter((e) => e.type === "usage")
        .reduce((n, e) => n + (e.quantity.unit === "tokens" ? e.quantity.amount : 0), 0),
    ).toBe(460);
    expect(nextWakeStep(path.join(h.dir, "workspace"))).toContain("orientations à reprendre");
    expect(readOwnerMessages(h.dir)).toBeNull();
  });
  it("lit la version de `codex --version`", () => {
    expect(parseCodexVersion("codex-cli 0.165.0\n")).toBe("0.165.0");
    expect(parseCodexVersion("rien")).toBeNull();
  });

  it("classe les codes d'erreur officiels", () => {
    expect(classifyCodexError("unauthorized").kind).toBe("auth_failed");
    expect(classifyCodexError({ httpConnectionFailed: { httpStatusCode: 401 } }).kind).toBe(
      "auth_failed",
    );
    expect(classifyCodexError("usageLimitExceeded").kind).toBe("rate_limited");
    expect(classifyCodexError({ responseStreamDisconnected: { httpStatusCode: 429 } }).kind).toBe(
      "rate_limited",
    );
    expect(classifyCodexError("serverOverloaded").kind).toBe("transient");
    expect(classifyCodexError("modelNotFound").kind).toBe("incompatible");
    expect(classifyCodexError("cyberPolicy").kind).toBe("fatal");
    expect(classifyCodexError(null).kind).toBe("fatal");
  });

  it("convertit la jauge sans deviner une fenêtre incomplète", () => {
    const reading = quotaFromRateLimitsResponse(
      {
        rateLimits: {},
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_793_300_000 },
            secondary: { usedPercent: 7, windowDurationMins: null, resetsAt: 1_793_900_000 },
          },
        },
      },
      "2026-10-29T12:00:00.000Z" as UtcTimestamp,
    );
    expect(reading.snapshots).toEqual([
      {
        windowKey: "codex:primary",
        windowDurationMs: 18_000_000,
        usedBasisPoints: 4_200,
        resetsAt: new Date(1_793_300_000_000).toISOString(),
        observedAt: "2026-10-29T12:00:00.000Z",
        provenance: "measured",
      },
    ]);
    expect(reading.incomplete.map((w) => w.windowKey)).toEqual(["codex:secondary"]);
  });
});

describe("commande", () => {
  it("the active policy model is retained when starting with the default registry", () => {
    expect(
      defaultRegistry({ adapterId: "codex", model: "gpt-6.1-sol" })
        .get("codex" as never)
        ?.runtime().model,
    ).toBe("gpt-6.1-sol");
  });
  it("native host runtime uses its configured CLI profile and keeps native settings", async () => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "host" };
    const home = path.join(h.dir, "native-home");
    fs.mkdirSync(home);
    enqueueOwnerMessage(h.dir, {
      id: "switch-pending",
      at: new Date().toISOString(),
      text: "Pending message during switch",
    });
    const subject = adapter({
      transport: undefined,
      nativeCodexHome: home,
      nativeCapabilities: true,
      ownerInboxDir: h.dir,
    });
    const req = request();
    const policy = {
      ...req.policy,
      groups: { runtime: { hostUnsandboxedAcknowledged: true, nativeCapabilities: true } },
    } as unknown as PolicyRevision;
    await collect(subject, { ...req, policy });
    expect(h.launches[0]?.env["CODEX_HOME"]).toBe(home);
    expect(h.launches[0]?.args).not.toContain('shell_environment_policy.inherit="none"');
    expect(JSON.stringify(h.requests("turn/start")[0])).toContain("Pending message during switch");
    expect(readOwnerReceipts(h.dir)["switch-pending"]).toBeTruthy();
  });

  it("CODEX_HOME dédié, aucune variable au nom de secret, réglages Wake prioritaires", () => {
    const base = {
      executable: { path: "C:\\codex\\codex.exe" },
      codexHome: path.join(h.dir, "codex-home"),
      workspaceDir: path.join(h.dir, "workspace"),
    };
    const command = buildAppServerCommand({
      ...base,
      channel: {
        configOverrides: { request_max_retries: "9", model_provider: '"wake_relay"' },
        env: {},
        close: () => Promise.resolve(),
      },
    });
    expect(command.env).toEqual({ CODEX_HOME: base.codexHome });
    expect(command.args.slice(-3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(command.args).toContain("request_max_retries=1");
    expect(command.args).not.toContain("request_max_retries=9");
    expect(command.args).toContain('shell_environment_policy.inherit="none"');
    expect(() =>
      buildAppServerCommand({
        ...base,
        channel: {
          configOverrides: {},
          env: { OPENAI_API_KEY: "x" },
          close: () => Promise.resolve(),
        },
      }),
    ).toThrow(CodexConfigError);
    expect(() =>
      buildAppServerCommand({
        ...base,
        codexHome: path.join(os.homedir(), ".codex"),
        channel: null,
      }),
    ).toThrow(/dossier Codex de l'utilisateur/);
  });
});

describe("sonde et capacités", () => {
  it("version de référence disponible, capacités honnêtes", async () => {
    const a = adapter({ versionCheck: undefined });
    const probe = await a.probe();
    expect(probe).toMatchObject({
      adapterId: CODEX_ADAPTER_ID,
      version: CODEX_SUPPORTED_VERSION,
      available: true,
      simulated: false,
    });
    const caps = await a.capabilities();
    expect(caps).toMatchObject({
      tokenCapEnforcement: "provider_quota_guard",
      providerQuotaReading: "official",
      cancellation: "graceful",
      residualUsageBound: null,
    });
  });

  it("une version plus récente compatible est disponible sans réinstallation", async () => {
    const a = adapter({ versionCheck: () => Promise.resolve("codex-cli 0.200.1") });
    expect(await a.probe()).toMatchObject({ available: true, version: "0.200.1" });
    const events = await collect(a, request());
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
  });
  it("refuse une rupture du protocole même pour une version de référence", async () => {
    const a = adapter({
      executable: { path: process.execPath, prefixArgs: [FAKE, "--fixture-no-interrupt"] },
    });
    const probe = await a.probe();
    expect(probe.available).toBe(false);
    expect(probe.unavailableReason).toContain("turn/interrupt");
    await expect(a.start(request())).rejects.toMatchObject({ code: "protocol_incompatible" });
    expect(h.launches).toHaveLength(0);
  });
  it("une sortie de version invalide ne lance aucun serveur", async () => {
    const a = adapter({
      versionCheck: () => Promise.resolve("unexpected codex-cli 0.165.0 trailing"),
    });
    expect(await a.probe()).toMatchObject({ available: false });
    await expect(a.start(request())).rejects.toMatchObject({ code: "version_unsupported" });
    expect(h.launches).toHaveLength(0);
  });

  it("sans turn/steer, avertit et conserve les nouveaux messages sans fausse injection", async () => {
    const a = adapter({
      ownerInboxDir: h.dir,
      executable: { path: process.execPath, prefixArgs: [FAKE, "--fixture-no-steer"] },
    });
    expect(await a.probe()).toMatchObject({ available: true });
    const req = request();
    (req.policy.groups.runtime as { nativeCapabilities?: boolean }).nativeCapabilities = true;
    const handle = await a.start(req);
    const events: AdapterEvent[] = [];
    for await (const event of a.events(handle)) {
      events.push(event);
      if (event.type === "started")
        enqueueOwnerMessage(h.dir, {
          id: "late-no-steer",
          at: new Date().toISOString(),
          text: "next wake",
        });
    }
    expect(
      events.some((e) => e.type === "activity" && e.summary.includes("turn/steer absent")),
    ).toBe(true);
    expect(h.requests("turn/steer")).toHaveLength(0);
    expect(readOwnerReceipts(h.dir)["late-no-steer"]).toBeUndefined();
  });

  it("binaire absent : indisponible", async () => {
    const a = adapter({ versionCheck: () => Promise.reject(new Error("ENOENT")) });
    expect(await a.probe()).toMatchObject({ available: false });
  });
});

describe("lancement et isolation", () => {
  it("refuse le mode autonome hors sandbox vérifiée", async () => {
    h.attestation = { confined: true, selfTestPassed: false, detail: "autotest absent" };
    await expect(adapter().start(request())).rejects.toBeInstanceOf(CodexAdapterError);
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    await expect(adapter().start(request())).rejects.toMatchObject({ code: "isolation_required" });
    expect(h.launches).toHaveLength(0);
  });

  it("refuse un conteneur sans transport fournisseur", async () => {
    await expect(adapter({ transport: undefined }).start(request())).rejects.toMatchObject({
      code: "transport_required",
    });
  });

  it("sous AppContainer vérifié : sans approbation, sans sandbox Codex", async () => {
    await collect(adapter(), request());
    const [thread] = h.requests("thread/start");
    expect(thread?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "Tu es l'agent Wake.",
      model: "gpt-test",
    });
    // Environnement demandé par l'adapter : rien d'hérité, seulement CODEX_HOME et le relais.
    // (Le lanceur de test, un `spawn` ordinaire, laisse libuv ajouter PATH, USERPROFILE…
    // les lanceurs de production construisent un bloc d'environnement explicite.)
    expect(Object.keys(h.launches[0]?.env ?? {}).sort()).toEqual([
      "CODEX_HOME",
      "MIND_WAKE_SESSION",
      "WAKE_RELAY_PIPE",
    ]);
    const launch = h.log().find((e) => e["kind"] === "launch");
    expect(launch?.["envKeys"]).toEqual(
      expect.arrayContaining(["CODEX_HOME", "MIND_WAKE_SESSION", "WAKE_RELAY_PIPE"]),
    );
    expect(h.launches[0]?.args).toContain('model_provider="wake_relay"');
  });

  it("mode manuel hors conteneur : approbations coupées mais sandbox Codex conservée", async () => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    await collect(adapter({ mode: "manual", transport: undefined }), request());
    const [thread] = h.requests("thread/start");
    expect(thread?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  });
});

describe("flux d'événements", () => {
  it("tour réussi : début, activité, usage par catégorie, fin ; rapprochement mesuré", async () => {
    const quota: unknown[] = [];
    const a = adapter({ onQuota: (r) => quota.push(r) });
    const req = request();
    const events = await collect(a, req);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("ended");
    const usage = events.filter((e) => e.type === "usage");
    // Le relevé d'un autre tour (turn_0) sert de point de départ, sans compter.
    expect(usage.map((u) => u.quantity)).toEqual([
      { unit: "tokens", amount: 150 },
      { unit: "tokens", amount: 60 },
    ]);
    expect(usage[0]).toMatchObject({
      provenance: "measured",
      tokenBreakdown: { input: 80, cached_input: 20, output: 40, reasoning: 10 },
    });
    const summaries = events.flatMap((e) => (e.type === "activity" ? [e.summary] : []));
    expect(summaries).toContain("commande : python sim.py");
    expect(summaries).toContain("message : J'ai lancé la simulation.");
    expect(summaries.join(" ")).not.toContain("pensée privée");
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
    expect(quota).toHaveLength(1);
    expect(await a.reconcile(req.sessionId)).toEqual({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: 210 }],
      provenance: "measured",
    });
    expect(h.requests("turn/start")[0]?.["params"]).toMatchObject({
      threadId: "thr_1",
      effort: "medium",
      input: [{ type: "text", text: "Reprends l'expérience des automates." }],
    });
  });

  it("limitation fournisseur : rate_limited avec le délai officiel de remise à zéro", async () => {
    h.flow = "rate-limited.json";
    const now = new Date(1_793_299_000_000);
    const a = adapter({ clock: () => now });
    const req = request();
    const events = await collect(a, req);
    const limited = events.find((e) => e.type === "rate_limited");
    expect(limited).toMatchObject({ retryAfterMs: 1_000_000 });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "failed" });
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("aucun compte connecté : auth_failed avant tout fil ni tour", async () => {
    h.flow = "auth-missing.json";
    const events = await collect(adapter(), request());
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "auth_failed" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "auth_required" });
    expect(h.requests("thread/start")).toHaveLength(0);
    expect(h.requests("turn/start")).toHaveLength(0);
  });

  it("401 en cours de tour : auth_failed ; une erreur retentée reste une activité", async () => {
    h.flow = "auth-unauthorized.json";
    const events = await collect(adapter(), request());
    expect(events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ code: "auth_failed", message: "401 Unauthorized" }),
    ]);
    expect(
      events.some((e) => e.type === "activity" && e.summary.includes("nouvelle tentative")),
    ).toBe(true);
  });

  it("flux coupé : erreur transitoire, fin, usage incertain", async () => {
    h.flow = "stream-cut.json";
    const a = adapter();
    const req = request();
    const events = await collect(a, req);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "transient" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "stream_cut" });
    const reconcile = await a.reconcile(req.sessionId);
    expect(reconcile).toMatchObject({ status: "uncertain" });
    expect(reconcile.status === "uncertain" && reconcile.detail).toContain("150 tokens mesurés");
  });

  it("refuse les requêtes du serveur (approbations)", async () => {
    h.flow = "approval-request.json";
    await collect(adapter(), request());
    const replies = h.log().filter((e) => e["kind"] === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.["message"]).toMatchObject({ error: { code: -32601 } });
  });
});

describe("annulation", () => {
  it("tour interrompu : turn/interrupt coopératif, puis arrêt du serveur", async () => {
    h.flow = "interrupted.json";
    const a = adapter({ stepsStopHook: true });
    const req = request();
    const handle = await a.start(req);
    const events: AdapterEvent[] = [];
    for await (const event of a.events(handle)) {
      events.push(event);
      if (event.type === "usage") {
        expect(await a.cancel(handle, 2_000)).toMatchObject({ status: "cancelled" });
      }
    }
    expect(h.requests("turn/interrupt")[0]?.["params"]).toEqual({
      threadId: "thr_1",
      turnId: "turn_1",
    });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "interrupted" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
    expect(h.requests("turn/start")).toHaveLength(1);
  });

  it("serveur qui ignore l'interruption : terminaison forcée dans le délai", async () => {
    h.flow = "stubborn.json";
    const a = adapter();
    const handle = await a.start(request());
    const events: AdapterEvent[] = [];
    for await (const event of a.events(handle)) {
      events.push(event);
      if (event.type === "started") {
        const result = await a.cancel(handle, 400);
        expect(result.status).toBe("forced");
        expect(result.status === "forced" && result.within).toBeLessThan(1_000);
      }
    }
    expect(events.at(-1)).toMatchObject({ type: "ended" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("session inconnue : annulation et rapprochement non confirmés", async () => {
    const a = adapter();
    const handle = {
      adapterId: CODEX_ADAPTER_ID,
      sessionId: "x" as SessionId,
      startedAt: "2026-10-29T00:00:00.000Z" as UtcTimestamp,
    };
    expect(await a.cancel(handle, 100)).toMatchObject({ status: "unconfirmed" });
    expect(await a.reconcile("x" as SessionId)).toMatchObject({ status: "uncertain" });
  });
});

describe("continuité", () => {
  it("garde la configuration durable dans le système et les nouveautés dans le tour", async () => {
    const threads = new FileThreadStore(path.join(h.dir, "environment-threads"));
    const req = {
      ...request(),
      systemContext: "Durable runtime environment",
      context: "Where was I?\nTime: provider limits only.",
    };
    await collect(adapter({ threads }), req);
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({
      developerInstructions: expect.stringContaining("Durable runtime environment"),
    });
    expect(JSON.stringify(h.requests("turn/start")[0]?.["params"])).not.toContain(
      "Durable runtime environment",
    );
    await collect(adapter({ threads }), {
      ...req,
      context: "Let's continue.\nTime: provider limits only.",
    });
    expect(h.requests("thread/resume")[0]?.["params"]).not.toHaveProperty("developerInstructions");
  });
  it("fil persisté et repris ; prompt système réinjecté seulement s'il change", async () => {
    const threads = new FileThreadStore(path.join(h.dir, "threads"));
    await collect(adapter({ threads }), request());
    expect(h.requests("thread/start")).toHaveLength(1);

    await collect(adapter({ threads }), request());
    const resumes = h.requests("thread/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.["params"]).toMatchObject({ threadId: "thr_1" });
    expect(resumes[0]?.["params"]).not.toHaveProperty("developerInstructions");

    await collect(adapter({ threads, systemPrompt: "Prompt révisé." }), request());
    expect(h.requests("thread/resume")[1]?.["params"]).toMatchObject({
      developerInstructions: "Prompt révisé.",
    });
    await collect(adapter({ threads, systemPrompt: "Prompt révisé." }), request());
    expect(h.requests("thread/resume")[2]?.["params"]).not.toHaveProperty("developerInstructions");
    expect(h.requests("thread/start")).toHaveLength(1);
  });

  it("fil refusé : nouveau fil avec le prompt système", async () => {
    const threads = new MemoryThreadStore();
    threads.save("profil-1", {
      threadId: "thr_old",
      promptFingerprint: "0".repeat(64),
      updatedAt: "2026-10-28T00:00:00.000Z" as UtcTimestamp,
    });
    h.flow = "resume-refused.json";
    const events = await collect(adapter({ threads }), request());
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({
      developerInstructions: "Tu es l'agent Wake.",
    });
    expect(threads.load("profil-1")?.threadId).toBe("thr_1");
    expect(events.at(-1)).toMatchObject({ exitReason: "completed" });
  });

  it("un fichier de fil altéré est ignoré", () => {
    const store = new FileThreadStore(path.join(h.dir, "threads"));
    store.save("k", {
      threadId: "thr_9",
      promptFingerprint: "a".repeat(64),
      updatedAt: "2026-10-29T00:00:00.000Z" as UtcTimestamp,
    });
    expect(store.load("k")?.threadId).toBe("thr_9");
    const file = fs.readdirSync(path.join(h.dir, "threads"))[0] ?? "";
    fs.writeFileSync(path.join(h.dir, "threads", file), '{"threadId":"../../x"}');
    expect(store.load("k")).toBeNull();
  });
});

describe("jauge de quota", () => {
  it("lecture officielle sans fil ni tour", async () => {
    const reading = await adapter().readProviderQuota();
    expect(reading.snapshots.map((s) => [s.windowKey, s.usedBasisPoints])).toEqual([
      ["codex:primary", 4_200],
    ]);
    expect(reading.incomplete.map((w) => w.windowKey)).toEqual(["codex:secondary"]);
    expect(h.requests("account/rateLimits/read")).toHaveLength(1);
    expect(h.requests("thread/start")).toHaveLength(0);
    expect(h.requests("turn/start")).toHaveLength(0);
  });
});

describe("lanceur AppContainer", () => {
  it("n'atteste l'autotest que pour le lanceur testé", () => {
    const sandbox: SandboxLike = {
      health: () => ({ operational: true, detail: "ok" }),
      launch: () => {
        throw new Error("non lancé");
      },
    };
    const make = (digest: string | null) =>
      appContainerLauncher({
        sandbox,
        launcherDigest: "abc",
        selfTest: digest === null ? null : { passed: true, launcherDigest: digest },
        jobName: (s) => `job-${s}`,
        readWriteRoots: [],
        readOnlyRoots: [],
        protectedPaths: [],
      }).isolation("s" as SessionId);
    expect(make("abc")).toMatchObject({ confined: true, selfTestPassed: true });
    expect(make("old")).toMatchObject({ confined: true, selfTestPassed: false });
    expect(make(null)).toMatchObject({ selfTestPassed: false });
  });

  it("la Sandbox de production satisfait le port", () => {
    const check = (sandbox: Sandbox): SandboxLike => sandbox;
    expect(typeof check).toBe("function");
  });
});

describe("flux réels enregistrés (codex-cli 0.147.0, expurgés)", () => {
  const manual = (quota: unknown[] = []): CodexAdapter => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    return adapter({
      mode: "manual",
      hostSandbox: "read-only",
      transport: undefined,
      versionCheck: () => Promise.resolve("codex-cli 0.147.0"),
      onQuota: (r) => quota.push(r),
    });
  };

  it("tour « OK » : usage mesuré, jauge reçue pendant le tour, rapprochement confirmé", async () => {
    h.flow = "real-0.147.0-ok.json";
    const quota: unknown[] = [];
    const a = manual(quota);
    const req = request();
    const events = await collect(a, req);
    expect(events.map((e) => e.type)).toEqual(["started", "activity", "usage", "ended"]);
    expect(events[1]).toMatchObject({ summary: "message : OK" });
    expect(events[2]).toMatchObject({
      quantity: { unit: "tokens", amount: 8_196 },
      provenance: "measured",
      tokenBreakdown: { input: 8_191, cached_input: 0, output: 5, reasoning: 0 },
    });
    expect(quota).toEqual([
      expect.objectContaining({
        snapshots: [
          expect.objectContaining({
            windowKey: "codex:primary",
            windowDurationMs: 604_800_000,
            usedBasisPoints: 2_800,
            resetsAt: "2026-11-04T06:38:41.000Z",
          }),
        ],
      }),
    ]);
    expect(await a.reconcile(req.sessionId)).toMatchObject({
      status: "confirmed",
      usage: [{ unit: "tokens", amount: 8_196 }],
    });
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({ sandbox: "read-only" });
  });

  it("modèle refusé (`codexErrorInfo: other`, 400 model_not_found) : incompatible", async () => {
    h.flow = "real-0.147.0-model-not-found.json";
    const a = manual();
    const req = request();
    const events = await collect(a, req);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "incompatible" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "failed" });
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("la version historique compatible est aussi admise en mode autonome isolé", async () => {
    const a = adapter({
      versionCheck: () => Promise.resolve("codex-cli 0.147.0"),
    });
    expect(await a.probe()).toMatchObject({ available: true });
    expect((await collect(a, request())).at(-1)).toMatchObject({ exitReason: "completed" });
  });

  it("le CODEX_HOME de l'utilisateur n'est admis qu'en mode manuel", async () => {
    const userHome = path.join(os.homedir(), ".codex");
    await expect(
      adapter({ codexHome: userHome, allowUserCodexHome: true }).start(request()),
    ).rejects.toThrow(/dossier Codex de l'utilisateur/);
    expect(h.launches).toHaveLength(0);
  });
});

describe("alignement ADR-006 et câblage", () => {
  const HOST: IsolationAttestation = { confined: false, selfTestPassed: false, detail: "hôte" };

  it("hôte non isolé avec consentement ADR-006 : sans approbation, signalé au journal", async () => {
    h.attestation = HOST;
    const a = adapter({ transport: undefined, hostUnattendedConsent: () => true });
    const events = await collect(a, request());
    expect(h.launches[0]?.unattended).toBe(true);
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(events[0]).toMatchObject({
      type: "activity",
      summary: expect.stringContaining("NON ISOLÉ") as unknown,
    });
  });

  it("hôte non isolé sans consentement : refus en autonome, rien de lancé", async () => {
    h.attestation = HOST;
    const a = adapter({ transport: undefined, hostUnattendedConsent: () => false });
    await expect(a.start(request())).rejects.toMatchObject({ code: "isolation_required" });
    expect(h.launches).toHaveLength(0);
  });

  it("readQuota : lecture hors session par quotaLauncher, sans mode sans approbation", async () => {
    h.attestation = HOST;
    const quotaLaunches: string[] = [];
    const a = adapter({
      transport: undefined,
      quotaLauncher: {
        isolation: () => HOST,
        launch: (sessionId, command) => {
          quotaLaunches.push(sessionId);
          expect(command.unattended).toBe(false);
          return h.launcher.launch(sessionId, command);
        },
      },
    });
    const snapshots = await a.readQuota();
    expect(snapshots.map((s) => s.usedBasisPoints)).toEqual([4_200]);
    expect(quotaLaunches).toHaveLength(1);
  });

  it("readQuota : lecture impossible = tableau vide (quota inconnu)", async () => {
    const a = adapter({ versionCheck: () => Promise.resolve("invalid") });
    expect(await a.readQuota()).toEqual([]);
  });

  it("hostLauncher : isolation du runner par session, `unattended` transmis", () => {
    const spawned: unknown[] = [];
    const host = {
      spawnContained: (_s: SessionId, command: unknown) => {
        spawned.push(command);
        return {} as never;
      },
      authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
      isolation: (s: SessionId) => (s === ("confinée" as SessionId) ? "sandbox" : "none") as never,
    };
    const launcher = hostLauncher(host);
    expect(launcher.isolation("confinée" as SessionId)).toMatchObject({ confined: true });
    expect(launcher.isolation("autre" as SessionId)).toMatchObject({ confined: false });
    launcher.launch("autre" as SessionId, {
      executable: "codex.exe",
      args: [],
      env: {},
      cwd: h.dir,
      unattended: true,
    });
    expect(spawned[0]).toMatchObject({ executable: "codex.exe", unattended: true });
  });

  it("codexRegistration : runtime déclaré, facturation par quota, fabrique", () => {
    const registration = codexRegistration({
      executable: { path: path.join(h.dir, "bin", "codex.exe") },
      codexHome: path.join(h.dir, "codex-home"),
      model: "gpt-5.6-luna",
      systemPrompt: "p",
      threadsDir: path.join(h.dir, "threads"),
    });
    expect(registration).toMatchObject({ id: CODEX_ADAPTER_ID, simulated: false });
    expect(registration.runtime()).toEqual({
      adapterId: CODEX_ADAPTER_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      authMode: "chatgpt",
    });
    expect(registration.billing()).toEqual({ kind: "subscription_quota" });
    expect(registration.runtimeRoots?.()).toEqual([path.join(h.dir, "bin")]);
    const created = registration.create({
      host: {
        spawnContained: () => {
          throw new Error("aucun lancement");
        },
        authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
        isolation: () => "none",
      },
      dataDir: h.dir,
      workspaceDir: path.join(h.dir, "workspace"),
      experimentFor: () => null,
      onProposal: () => undefined,
      fakeScenario: () => undefined,
    });
    expect(created).toBeInstanceOf(CodexAdapter);
    expect(canReadQuota(created)).toBe(true);
  });

  it("registre par défaut : Codex enregistré, configuration lue dans l'environnement", () => {
    expect(defaultRegistry().realIds()).toContain(CODEX_ADAPTER_ID);
    const fromEnv = codexRegistrationFromEnv({
      MIND_WAKE_CODEX_BIN: path.join(h.dir, "codex.exe"),
      MIND_WAKE_CODEX_MODEL: "gpt-6-luna",
      MIND_WAKE_CODEX_EFFORT: "low",
    });
    expect(fromEnv.runtime().model).toBe("gpt-6-luna");
    expect(fromEnv.runtimeRoots?.()).toEqual([h.dir]);
    expect(codexRegistrationFromEnv({}).runtime().model).toBe(CODEX_DEFAULT_MODEL);
  });

  it("consentement ADR-006 lu par défaut dans runtime.hostUnsandboxedAcknowledged", async () => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    const consented = {
      ...request(),
      policy: {
        profileId: "profil-1" as ProfileId,
        groups: { runtime: { hostUnsandboxedAcknowledged: true } },
      } as unknown as PolicyRevision,
    };
    const events = await collect(adapter({ transport: undefined }), consented);
    expect(h.launches[0]?.unattended).toBe(true);
    expect(events.at(-1)).toMatchObject({ exitReason: "completed" });
    await expect(adapter({ transport: undefined }).start(request())).rejects.toMatchObject({
      code: "isolation_required",
    });
  });

  it("sur l'hôte, le lanceur ajoute le profil Windows ; dans la sandbox, non", () => {
    const spawned: { env?: Record<string, string> }[] = [];
    const make = (mode: "sandbox" | "host_unsandboxed") =>
      hostLauncher({
        spawnContained: (_s, command) => {
          spawned.push(command);
          return {} as never;
        },
        authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
        isolation: () => mode,
      });
    const command = { executable: "codex.exe", args: [], env: { CODEX_HOME: h.dir }, cwd: h.dir };
    make("host_unsandboxed").launch("s" as SessionId, command);
    make("sandbox").launch("s" as SessionId, command);
    expect(Object.keys(spawned[0]?.env ?? {})).toEqual(
      expect.arrayContaining(["CODEX_HOME", ...Object.keys(hostPassthroughEnv())]),
    );
    expect(spawned[1]?.env).toEqual({ CODEX_HOME: h.dir });
  });

  it("pendant une session, readQuota réutilise la jauge reçue en fin de tour", async () => {
    const a = adapter();
    const handle = await a.start(request());
    for await (const event of a.events(handle)) {
      if (event.type === "usage") break;
    }
    const before = h.launches.length;
    // Jauge du flux enregistré : reçue à l'instant, donc réutilisée sans nouveau processus.
    const snapshots = await a.readQuota();
    expect(snapshots.map((s) => s.windowKey)).toEqual(["codex:primary"]);
    expect(h.launches.length).toBe(before);
    await a.cancel(handle, 500);
  });
});

it.each(["stable", "roundtrip", "missing"])(
  "does not coordinate for %s endpoint IDs",
  async (mode) => {
    h.flow = "steps-stop.json";
    const req = { ...request(), context: "project-action:" + mode };
    await collect(adapter({ stepsStopHook: true }), req);
    expect(h.requests("turn/start")).toHaveLength(1);
  },
);
it("native proposal plus explicit main decision persists once; child usage remains uncertain", async () => {
  h.flow = "steps-stop-accepted.json";
  const req = request();
  const a = adapter({
    stepsStopHook: true,
    onStepsResult: (req, raw) =>
      saveStepsResult(path.join(h.dir, "workspace"), h.dir, "agent", req.sessionId, raw),
  });
  await collect(a, req);
  expect(h.requests("turn/start")).toHaveLength(2);
  expect(readOwnerMessages(h.dir)).toHaveLength(1);
  expect(nextWakeStep(path.join(h.dir, "workspace"))).toContain("Vérifier la reprise réelle");
  expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  expect(h.launches[0]?.env["MIND_WAKE_SESSION"]).toBe(req.sessionId);
});

it("applies a late repo proposal on an ordinary stable-project response without another coordination turn", async () => {
  h.flow = "steps-stop-repo.json";
  const workspace = path.join(h.dir, "workspace");
  const a = adapter({
    stepsStopHook: true,
    ownerInboxDir: h.dir,
    onStepsResult: (req, raw) => saveStepsResult(workspace, h.dir, "agent", req.sessionId, raw),
  });
  await collect(a, request());
  expect(h.requests("turn/start")).toHaveLength(2);
  expect(readOwnerMessages(h.dir)).toBeNull();
  const thread = {
    id: "direct_" + "a".repeat(32),
    repo: "C:/fixture",
    runtime: "codex",
    sessionId: "peer",
    transcript: "fixture",
  };
  appendRepoMessage(h.dir, {
    thread,
    message: {
      id: "answer",
      at: new Date().toISOString(),
      from: "repo",
      text: "Comparer deux directions ; vérifier la reprise en2wakes TOTAL.",
    },
  });
  expect(nextWakeStep(workspace)).toContain("proposal_ready");
  h.flow = "steps-repo-decision.json";
  await collect(a, request());
  expect(h.requests("turn/start")).toHaveLength(3);
  expect(readOwnerMessages(h.dir)).toHaveLength(1);
  expect(nextWakeStep(workspace)).toContain("Vérifier le retour");
});

it("registration sends documentary history to a fresh Codex transport after previous delivery", async () => {
  enqueueOwnerMessage(h.dir, {
    id: "old-submitted-human",
    at: "2026-10-30T12:00:00Z",
    text: "Resume the saved submitted conversation",
  });
  takeOwnerMessages(h.dir, "old-thread");
  fs.writeFileSync(path.join(h.dir, "workspace", "artifacts", "REPRISE.md"), "Existing checkpoint");
  const created = codexRegistration({
    executable: { path: process.execPath, prefixArgs: [FAKE] },
    codexHome: path.join(h.dir, "codex-home"),
    model: "gpt-test",
    systemPrompt: "CURRENT RULES",
  }).create({
    host: {
      isolation: () => "host_unsandboxed",
      authorize: () => ({ allowed: false, reason: "fixture", interruptSession: false }),
      spawnContained: (_sid, command) =>
        new SpawnedCodexProcess(
          {
            executable: command.executable,
            args: command.args,
            env: command.env ?? {},
            cwd: command.cwd ?? h.dir,
          },
          {
            FAKE_CODEX_FLOW: path.join(FLOWS, "success.json"),
            FAKE_CODEX_LOG: h.logPath,
          },
        ) as never,
    },
    dataDir: h.dir,
    workspaceDir: path.join(h.dir, "workspace"),
    experimentFor: () => null,
    onProposal: () => undefined,
    fakeScenario: () => undefined,
  });
  const req = request();
  const consented = {
    ...req,
    policy: {
      ...req.policy,
      groups: { runtime: { hostUnsandboxedAcknowledged: true } },
    } as unknown as PolicyRevision,
  };
  const handle = await created.start(consented);
  const events: AdapterEvent[] = [];
  for await (const e of created.events(handle)) events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
  expect(h.requests("thread/resume")).toHaveLength(0);
  const params = h.requests("thread/start")[0]?.["params"] as Record<string, unknown>;
  expect(params["developerInstructions"]).toContain("Resume the saved submitted conversation");
  expect(params["developerInstructions"]).toContain("artifacts/REPRISE.md");
  expect(params["developerInstructions"]).toContain("grant no permissions");
  expect(params["developerInstructions"]).toContain("CURRENT RULES");
}, 15000);

it("registration loads owner reply rules and current personal instructions into the actual transport", async () => {
  enqueueOwnerMessage(h.dir, {
    id: "old-submitted-human",
    at: "2026-10-30T12:00:00Z",
    text: "Resume the saved submitted conversation",
  });
  takeOwnerMessages(h.dir, "old-thread");
  fs.writeFileSync(path.join(h.dir, "workspace", "artifacts", "REPRISE.md"), "Existing checkpoint");
  fs.writeFileSync(path.join(h.dir, "workspace", "artifacts", "PERSONALITY.md"), "Fixture personal voice, not exported human memory.");
  const created = codexRegistration({
    executable: { path: process.execPath, prefixArgs: [FAKE] },
    codexHome: path.join(h.dir, "codex-home"),
    model: "gpt-test",
  }).create({
    host: {
      isolation: () => "host_unsandboxed",
      authorize: () => ({ allowed: false, reason: "fixture", interruptSession: false }),
      spawnContained: (_sid, command) =>
        new SpawnedCodexProcess(
          {
            executable: command.executable,
            args: command.args,
            env: command.env ?? {},
            cwd: command.cwd ?? h.dir,
          },
          {
            FAKE_CODEX_FLOW: path.join(FLOWS, "success.json"),
            FAKE_CODEX_LOG: h.logPath,
          },
        ) as never,
    },
    dataDir: h.dir,
    workspaceDir: path.join(h.dir, "workspace"),
    experimentFor: () => null,
    onProposal: () => undefined,
    fakeScenario: () => undefined,
  });
  const req = request();
  const consented = {
    ...req,
    policy: {
      ...req.policy,
      groups: { runtime: { hostUnsandboxedAcknowledged: true } },
    } as unknown as PolicyRevision,
  };
  const handle = await created.start(consented);
  const events: AdapterEvent[] = [];
  for await (const e of created.events(handle)) events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
  expect(h.requests("thread/resume")).toHaveLength(0);
  const params = h.requests("thread/start")[0]?.["params"] as Record<string, unknown>;
  expect(params["developerInstructions"]).toContain("Resume the saved submitted conversation");
  expect(params["developerInstructions"]).toContain("artifacts/REPRISE.md");
  expect(params["developerInstructions"]).toContain("grant no permissions");
  expect(params["developerInstructions"]).toContain("When you receive an actual new human message");
  expect(params["developerInstructions"]).toContain("before starting long execution or delegation");
  expect(params["developerInstructions"]).toContain("terminal output is not publication in the Wake conversation");
  expect(params["developerInstructions"]).toContain("Fixture personal voice, not exported human memory.");
}, 15000);
