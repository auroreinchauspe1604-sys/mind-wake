import { KeyboardContextCollector } from "./keyboard-context.js";
import { writeRuntimeReceipt } from "../communication/runtime-receipt.js";
import { collectAgentScreenshot } from "./agent-screenshot-policy.js";
import {
  captureWakeScreenshot,
  configuredWakeScreenshot,
  type WakeScreenshotChoice,
} from "./wake-screenshot.js";
/**
 * Daemon Wake au premier plan (AGENTS §5 « Daemon », SPEC §5 et §8).
 *
 * Démarrage : ouvre la base de contrôle, prend le verrou d'instance du profil (un seul
 * daemon par profil), applique un arrêt d'urgence resté en marqueur de secours,
 * réconcilie les sessions orphelines et les artefacts, puis boucle sur le scheduler.
 * Le runner (S7) exécute chaque session lancée par le scheduler (S6) ; les checkpoints
 * candidats sont autorisés par le policy engine puis publiés par `src/checkpoint/`.
 *
 * Aucun port réseau. Le canal de contrôle est la base SQLite : `pause`, `resume` et
 * `stop` de la CLI y persistent l'état ; le watchdog du runner le relit toutes les
 * 50 ms pendant une session, le scheduler à chaque tour. `stop` termine aussi le Job
 * Object de la session par son nom, sans passer par le daemon.
 *
 * Le runtime est celui que désigne la policy, pris dans le registre d'adapters
 * (`registry.ts`), sans repli. Mode simulé (`simulated: true`) : adapter factice, Job
 * Object seul, tout est marqué SIMULÉ. Mode réel : adapter enregistré et disponible
 * selon `probe`, sessions lancées dans la sandbox AppContainer + Job Object seulement
 * après un autotest de refus réussi au démarrage du daemon (ADR-003, ADR-005).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { activateWorkspace } from "./workspace-config.js";
import { WorkspaceGitSync } from "./workspace-git-sync.js";
import { FAKE_ADAPTER_ID, emergenceScenario, type FakeScenario } from "../adapters/fake/index.js";
import {
  utf8TokenBound,
  loadWakeMemory,
  openRoot,
  publishCheckpoint,
  reconcileArtifacts,
  type ConfinedRoot,
  type WakeMemory,
} from "../checkpoint/index.js";
import type {
  AdapterId,
  CheckpointCandidate,
  ExperimentId,
  PolicyRevisionId,
  ProbeResult,
  ProfileId,
  RuntimeAdapter,
  SessionId,
  SessionRecord,
  SubscriptionQuotaGuard,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import { decideAction, decisionJournalEvent, resolvePolicy } from "../policy/index.js";
import type { BillingFacts, SessionChecks } from "../policy/index.js";
import {
  ProcessTreeSupervisor,
  SessionRunner,
  StopFlag,
  runtimeDirFor,
  type RunnerSandbox,
  type SandboxReadiness,
  type SessionResult,
} from "../runner/index.js";
import {
  Sandbox,
  runIsolationSelfTest,
  sandboxSourceDigest,
  type IsolationSelfTestReport,
} from "../sandbox/index.js";
import {
  InstanceLockError,
  Scheduler,
  WatchedPrioritySignal,
  windowsIdleWatcher,
  type IdleWatcher,
  SqliteSchedulerStateRepository,
  acquireInstanceLock,
  instanceLockPath,
  type InstanceLock,
  type LaunchTicket,
  type SessionFailure,
  type SessionLauncher,
  type SessionReport,
} from "../scheduler/index.js";
import { openStore, type Store } from "../store/index.js";
import {
  RuntimeEnvironment,
  SimulatedActivitySignal,
  SimulatedEnvironment,
  runtimeLiveChecks,
  simulatedLiveChecks,
} from "./environment.js";
import { registerProposal } from "./experiments.js";
import { recordSelfTest, selfTestRecordFor, selfTestValidFor } from "./isolation.js";
import {
  ARTIFACTS_SEGMENT,
  artifactsDirFor,
  controlDbPath,
  simulatedActivityFlagFor,
  workspaceDirFor,
} from "./paths.js";
import { defaultRegistry, type AdapterRegistration, type AdapterRegistry } from "./registry.js";
import { closeAbandonedRuns, recordDaemonEnd, recordDaemonStart } from "./runs.js";
import {
  composeWake,
  loadWakeTemplates,
  previousNudge,
  recordWakePrompt,
  type WakeTemplates,
} from "./wake-prompt.js";
import { AgentWakeups, type QuotaSource } from "./wakeups.js";
import { executionMode } from "./execution-mode.js";
import { consumeHumanWake, pendingHumanWake } from "./human-wake.js";
import { currentContextEvent } from "./current-context.js";
import { openSharedInboxSession, type SharedInboxSession } from "../communication/shared-inbox.js";
import { ownerMessagePending } from "../communication/owner-inbox.js";
import { recordOwnerAttachmentRuntime } from "../communication/owner-attachment-runtime.js";
import { BackgroundJobs } from "./background-jobs.js";
import { QuotaPacingStore } from "./pacing.js";

export class DaemonError extends Error {
  override readonly name = "DaemonError";
  constructor(
    readonly code:
      | "real_adapter_missing"
      | "adapter_unavailable"
      | "sandbox_unavailable"
      | "no_profile"
      | "already_running"
      | "runtime_mismatch"
      | "termination_unavailable",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Isolation du mode réel. Par défaut : profil AppContainer de production
 * (`mindwake.sandbox`, créé s'il manque) et autotest de refus complet au démarrage.
 */
export interface DaemonIsolation {
  readonly sandbox: Sandbox;
  readonly selfTest?: () => Promise<IsolationSelfTestReport>;
  /** Racines runtime supplémentaires en lecture et exécution (tests). */
  readonly runtimeRoots?: readonly string[];
}

export interface DaemonOptions {
  /** Surface visuelle explicitement autorisée pour cette exécution ; absente = aucune capture. */
  readonly wakeScreenshot?: WakeScreenshotChoice;
  readonly dataDir: string;
  readonly profileId: ProfileId;
  /** Adapter factice, tout est marqué SIMULÉ ; sinon l'adapter réel de la policy. */
  readonly simulated: boolean;
  /** Registre d'adapters ; par défaut celui de ce build. */
  readonly registry?: AdapterRegistry;
  /**
   * Inactivité du poste en mode réel ; par défaut `windowsIdleWatcher()` (GetLastInputInfo).
   * Injectable pour les tests. Ignorée en mode simulé (fichier `simulated-user-activity`).
   */
  readonly idleWatcher?: IdleWatcher;
  /** Isolation du mode réel ; ignorée en mode simulé. */
  readonly isolation?: DaemonIsolation;
  /** Thème facultatif suggéré par l'humain (`{{theme}}`) ; sinon « none ». */
  readonly theme?: string;
  /** Dossier des prompts de réveil ; par défaut `prompts/wake/` du dépôt. */
  readonly promptsDir?: string;
  /** Veille maximale du scheduler entre deux tours (≥ 1 000 ms). */
  readonly recheckIntervalMs?: number;
  /** Arrêt propre après ce nombre de sessions terminées (démo, tests). */
  readonly exitAfterSessions?: number;
  /** Lanceur Job Object compilé ; par défaut `<dataDir>/runtime`. */
  readonly runtimeDir?: string;
  /** Scénario imposé à chaque session (tests) ; sinon l'agent factice de la démo. */
  readonly scenario?: FakeScenario;
  readonly log?: (line: string) => void;
}

export interface DaemonSummary {
  readonly runId: string;
  readonly sessions: readonly SessionResult[];
  readonly reason: string;
}

const DEFAULT_RECHECK_MS = 2_000;

function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

/** Ce que le scheduler doit savoir de la fin d'une session menée par le runner. */
export function reportFor(result: SessionResult): SessionReport {
  const failure = ((): SessionFailure | undefined => {
    if (result.reason === "provider.rate_limited") {
      return { kind: "rate_limited", retryAfterMs: null };
    }
    if (result.reason.startsWith("adapter.auth_failed")) {
      return { kind: "auth_failed", detail: result.reason };
    }
    if (result.reason.startsWith("adapter.incompatible")) {
      return { kind: "incompatible", detail: result.reason };
    }
    if (result.outcome === "failed" || result.outcome === "orphaned") {
      return { kind: "transient", detail: result.reason };
    }
    return undefined;
  })();
  return {
    sessionId: result.sessionId,
    outcome: result.outcome,
    ...(failure === undefined ? {} : { failure }),
  };
}

interface SessionContext {
  readonly revisionId: PolicyRevisionId;
  experimentId: ExperimentId | null;
  scenario: FakeScenario | undefined;
}

/**
 * Mode réel : adapter enregistré, sandbox et autotest à exécuter au démarrage, ou
 * `sandbox: null` en mode NON ISOLÉ consenti par la policy (ADR-006).
 */
interface RealMode {
  readonly registration: AdapterRegistration;
  readonly probe: ProbeResult;
  readonly sandbox: Sandbox | null;
  readonly selfTest: () => Promise<IsolationSelfTestReport>;
  readonly runtimeRoots: readonly string[];
}

export class WakeDaemon implements SessionLauncher {
  readonly runId = `run-${randomUUID()}`;
  readonly #o: DaemonOptions;
  readonly #store: Store;
  readonly #lock: InstanceLock;
  readonly #runner: SessionRunner;
  /** Mode simulé : fichier ; mode réel : inactivité réelle du poste (`GetLastInputInfo`). */
  readonly #signal: SimulatedActivitySignal | WatchedPrioritySignal;
  readonly #idleWatcher: IdleWatcher | null;
  readonly #root: ConfinedRoot;
  readonly #sessions = new Map<SessionId, SessionContext>();
  readonly #results: SessionResult[] = [];
  readonly #abort = new AbortController();
  readonly #registration: AdapterRegistration;
  readonly #real: RealMode | null;
  /** Isolation prête : autotest de refus réussi pour ce lanceur (mode réel). */
  #readiness: SandboxReadiness = { ok: false, detail: "autotest de refus non exécuté" };
  #stopReason = "arrêt demandé";
  #scheduler: Scheduler | null = null;
  #backgroundJobs: BackgroundJobs | null = null;
  #workspaceSync: WorkspaceGitSync | null = null;
  readonly #templates: WakeTemplates;
  readonly #wakeups: AgentWakeups;
  #quota: QuotaSource | undefined;
  readonly #pacing: QuotaPacingStore;
  readonly #keyboardContext: KeyboardContextCollector;

  private constructor(
    options: DaemonOptions,
    store: Store,
    lock: InstanceLock,
    supervisor: ProcessTreeSupervisor,
    registration: AdapterRegistration,
    real: RealMode | null,
  ) {
    this.#o = options;
    this.#store = store;
    this.#lock = lock;
    this.#registration = registration;
    this.#real = real;
    this.#keyboardContext = new KeyboardContextCollector(options.dataDir, () => {
      if (real === null) return false;
      const profile = store.uow.profiles.get(options.profileId);
      return (
        profile !== null &&
        !profile.emergencyStopLocked &&
        ["ready", "running", "hibernating"].includes(profile.state)
      );
    });
    // Le fichier simulé reste réservé au mode `--simulated` ; en mode réel, l'inactivité
    // du poste est lue en continu et comparée au seuil de la révision effective.
    this.#idleWatcher = real === null ? null : (options.idleWatcher ?? windowsIdleWatcher());
    this.#signal =
      this.#idleWatcher === null
        ? new SimulatedActivitySignal(simulatedActivityFlagFor(options.dataDir))
        : new WatchedPrioritySignal(this.#idleWatcher, () => {
            const resolution = resolvePolicy(store.uow.policies, options.profileId);
            if (resolution.status !== "active") return null;
            const priority = resolution.revision.groups.humanPriority;
            // `none` : choix explicite de l'humain, l'agent travaille aussi pendant qu'il
            // utilise le poste (seuil nul) ; pause, arrêt et garde de quota restent imposés.
            return priority.activitySignal === "none" ? 0 : priority.idleThresholdMs;
          });
    fs.mkdirSync(artifactsDirFor(options.dataDir), { recursive: true });
    this.#root = openRoot(artifactsDirFor(options.dataDir));
    const workspaceDir = workspaceDirFor(options.dataDir);
    this.#templates = loadWakeTemplates(options.promptsDir);
    this.#pacing = new QuotaPacingStore(store.db, store.uow, options.profileId, registration.id);
    this.#wakeups = new AgentWakeups({
      uow: store.uow,
      db: store.db,
      profileId: options.profileId,
      workspaceDir,
      schemaText: this.#templates.wakeupSchema,
    });
    this.#runner = new SessionRunner({
      uow: store.uow,
      profileId: options.profileId,
      supervisor,
      ...(real?.sandbox == null
        ? {}
        : { sandbox: this.#runnerSandbox(real.sandbox, real, workspaceDir) }),
      stopFlag: new StopFlag(options.dataDir),
      adapter: (host) =>
        registration.create({
          host,
          dataDir: options.dataDir,
          workspaceDir,
          nativeCapabilities: (() => { const profile = store.uow.profiles.get(options.profileId); return profile?.activePolicyRevisionId != null && store.uow.policies.getRevision(profile.activePolicyRevisionId)?.groups.runtime.nativeCapabilities === true; })(),
          experimentFor: (sessionId) => this.#sessions.get(sessionId)?.experimentId ?? null,
          onProposal: (sessionId, proposal) => {
            this.#onProposal(sessionId, proposal);
          },
          fakeScenario: (sessionId) => this.#sessions.get(sessionId)?.scenario,
        }),
      liveChecks: () => this.#liveChecks(),
      onCheckpointCandidate: (candidate) => {
        this.#onCheckpoint(candidate);
      },
    });
  }

  #runnerSandbox(sandbox: Sandbox, real: RealMode, workspaceDir: string): RunnerSandbox {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      ready: () => this.#readiness,
      launch: (spec) => sandbox.launch(spec),
      workspaceDir,
      runtimeRoots: real.runtimeRoots,
      // Base de contrôle et dossier de données : jamais dans une racine accordée.
      protectedPaths: [controlDbPath(this.#o.dataDir), this.#o.dataDir],
    };
  }

  #liveChecks(): Omit<SessionChecks, "now"> {
    return this.#signal instanceof SimulatedActivitySignal
      ? simulatedLiveChecks(this.#signal)
      : runtimeLiveChecks(this.#signal, () => this.#readiness.ok);
  }

  get simulated(): boolean {
    return this.#real === null;
  }

  /**
   * Prépare le daemon sans rien lancer. Lève `DaemonError` si le profil est absent, si un
   * autre daemon tient le verrou, si le mode demandé ne correspond pas à l'adapter de la
   * policy, ou, en mode réel, si cet adapter n'est pas enregistré, si `probe` le dit
   * indisponible ou si le lanceur confiné ne peut pas être construit.
   */
  static async open(options: DaemonOptions): Promise<WakeDaemon> {
    const dbPath = controlDbPath(options.dataDir);
    if (!fs.existsSync(dbPath)) {
      throw new DaemonError("no_profile", "aucune base de contrôle : lancer `mind-wake init`");
    }
    const store = openStore(dbPath);
    let lock: InstanceLock | null = null;
    try {
      if (store.uow.profiles.get(options.profileId) === null) {
        throw new DaemonError("no_profile", `profil ${options.profileId} absent`);
      }
      try {
        lock = acquireInstanceLock(instanceLockPath(options.dataDir, options.profileId));
      } catch (error) {
        if (error instanceof InstanceLockError) {
          throw new DaemonError(
            "already_running",
            "un daemon tient déjà le verrou d'instance de ce profil",
          );
        }
        throw error;
      }
      activateWorkspace(options.dataDir);
      const resolution = resolvePolicy(store.uow.policies, options.profileId);
      const registry = options.registry ?? defaultRegistry(resolution.status==="active"?resolution.revision.groups.runtime:undefined);
      const wanted: AdapterId | null =
        resolution.status === "active" ? resolution.revision.groups.runtime.adapterId : null;
      const runtimeDir = options.runtimeDir ?? runtimeDirFor(options.dataDir);
      let registration: AdapterRegistration;
      let real: RealMode | null = null;
      if (options.simulated) {
        if (wanted !== null && wanted !== FAKE_ADAPTER_ID) {
          throw new DaemonError(
            "runtime_mismatch",
            `la policy désigne l'adapter « ${wanted} » : le mode simulé n'exécute que l'adapter factice`,
          );
        }
        const fake = registry.get(FAKE_ADAPTER_ID);
        if (fake === null) throw new DaemonError("real_adapter_missing", "adapter factice absent");
        registration = fake;
      } else {
        registration = realRegistration(registry, wanted);
        const hostUnsandboxed =
          resolution.status === "active" &&
          resolution.revision.groups.runtime.hostUnsandboxedAcknowledged === true;
        real = await realMode(options, registration, runtimeDir, hostUnsandboxed);
      }
      const supervisor = new ProcessTreeSupervisor(runtimeDir);
      if (!supervisor.status.available) {
        throw new DaemonError("termination_unavailable", supervisor.status.reason);
      }
      return new WakeDaemon(options, store, lock, supervisor, registration, real);
    } catch (error) {
      lock?.release();
      store.close();
      throw error;
    }
  }

  get store(): Store {
    return this.#store;
  }

  #log(line: string): void {
    const prefix =
      this.#real === null ? "[SIMULÉ] " : this.#real.sandbox === null ? "[NON ISOLÉ] " : "";
    this.#o.log?.(`${prefix}${line}`);
  }

  /**
   * Mode réel : profil AppContainer présent (créé s'il manque), puis autotest de refus.
   * L'isolation n'est prête que si l'autotest réussit, nettoyage vérifié, pour
   * l'empreinte du lanceur en service ; sinon tout lancement est refusé avec motif.
   */
  async #prepareIsolation(real: RealMode): Promise<void> {
    const { db, uow } = this.#store;
    const at = utcNow();
    const sandbox = real.sandbox;
    if (sandbox === null) {
      this.#readiness = {
        ok: false,
        detail:
          "mode NON ISOLÉ (ADR-006) : runtimes réels sur le poste hôte, accès complet au compte Windows ; sandbox non utilisée",
      };
      this.#log(`ATTENTION : ${this.#readiness.detail}`);
      return;
    }
    let report: IsolationSelfTestReport;
    try {
      const profile = sandbox.ensureProfile();
      if (profile.created) this.#log(`profil AppContainer ${sandbox.profile} créé`);
      report = await real.selfTest();
    } catch (error) {
      this.#readiness = {
        ok: false,
        detail: `isolation indisponible : ${error instanceof Error ? error.message : String(error)}`,
      };
      this.#log(this.#readiness.detail);
      return;
    }
    const digest = sandbox.status.available ? sandbox.status.sourceDigest : null;
    const record = selfTestRecordFor(this.#o.profileId, report, sandboxSourceDigest(), at);
    recordSelfTest(db, record);
    this.#readiness = selfTestValidFor(record, digest);
    uow.journal.append(
      prepareJournalEvent({
        type: record.passed ? "action_allowed" : "action_denied",
        at,
        profileId: this.#o.profileId,
        reason: record.passed ? "isolation.self_test_passed" : "sandbox_unavailable",
        metadata: {
          action: "isolation_self_test",
          passed: record.passed,
          checks: record.checks,
          failed: [...record.failed],
          cleanupVerified: record.cleanupVerified,
          sourceDigest: record.sourceDigest,
          terminationMs: record.terminationMs,
        },
      }),
    );
    this.#log(this.#readiness.detail);
  }

  /** Arrêt propre : plus aucun réveil ; la session en cours, s'il y en a une, se termine. */
  requestStop(reason: string): void {
    this.#stopReason = reason;
    this.#abort.abort();
  }

  async run(): Promise<DaemonSummary> {
    const { uow, db } = this.#store;
    const { profileId } = this.#o;
    const at = utcNow();
    const real = this.#real;
    const mode = real === null ? "simulated" : "real";
    const adapterId = this.#registration.id;
    recordOwnerAttachmentRuntime(this.#o.dataDir, this.runId);
    const abandoned = closeAbandonedRuns(db, profileId, at);
    recordDaemonStart(db, {
      id: this.runId,
      profileId,
      pid: process.pid,
      mode,
      adapterId,
      startedAt: at,
      endedAt: null,
      endReason: null,
    });
    writeRuntimeReceipt('daemon');
    uow.journal.append(
      prepareJournalEvent({
        type: "daemon_started",
        at,
        profileId,
        reason:
          real === null
            ? "daemon démarré au premier plan (SIMULÉ : adapter factice, aucun appel modèle)"
            : `daemon démarré au premier plan (adapter réel « ${adapterId} », sessions confinées)`,
        metadata: {
          runId: this.runId,
          pid: process.pid,
          mode,
          adapterId,
          prioritySignal:
            real === null
              ? "simulated_file"
              : this.#o.idleWatcher === undefined
                ? "windows_last_input"
                : "injected",
          isolation:
            real === null ? "job_only" : real.sandbox === null ? "host_unsandboxed" : "sandbox",
          ...(real === null ? {} : { adapterVersion: real.probe.version }),
          abandonedRuns: abandoned.map((r) => r.id),
        },
      }),
    );
    this.#log(`daemon démarré (pid ${String(process.pid)}, exécution ${this.runId})`);
    if (abandoned.length > 0) {
      this.#log(`${String(abandoned.length)} exécution(s) précédente(s) arrêtée(s) brutalement`);
    }

    const startup = this.#runner.reconcileAtStartup();
    if (startup.emergencyStopRecovered) this.#log("arrêt d'urgence non persisté : appliqué");
    for (const orphan of startup.orphans) {
      this.#log(
        `session orpheline ${orphan.sessionId} : close, réservation ${orphan.reservationStatus ?? "inconnue"}, rien n'est rejoué`,
      );
    }
    this.#reconcileArtifacts();
    if (real !== null) await this.#prepareIsolation(real);

    this.#wakeups.prepare();
    if (real !== null) this.#keyboardContext.start();
    const environment =
      real === null
        ? new SimulatedEnvironment(this.#runner.adapter, this.#registration.runtime())
        : new RuntimeEnvironment(
            this.#runner.adapter,
            this.#registration.runtime(),
            this.#registration.billing(),
            () => this.#readiness.ok,
            {
              observe: (snapshots) => {
                const guard = this.#activeGuard();
                if (guard !== null) this.#pacing.observe(guard, snapshots, Date.now());
              },
              estimates: () => this.#pacing.estimates(),
            },
          );
    this.#quota =
      environment instanceof RuntimeEnvironment ? () => environment.quotaSnapshots() : undefined;
    const scheduler = new Scheduler({
      maintenance: () => {
        void this.#workspaceSync?.tick().catch(() => {
          this.#log("Workspace Git settings unavailable; inspect Settings.");
        });
      },
      profileId,
      uow: this.#store.uow,
      state: new SqliteSchedulerStateRepository(db),
      clock: { now: () => Date.now(), monotonic: () => performance.now() },
      environment,
      // Réveils demandés par l'agent ou par l'humain (`wake`) : échéances candidates,
      // jamais des autorisations.
      wakeRequests: {
        nextRequestedWake: async (now) => {
          if (this.#backgroundJobs?.store.events().length) return now;
          if (this.#registration.id === "claude" && ownerMessagePending(this.#o.dataDir, true)) return now;
          if (executionMode(this.#o.dataDir) === "always-on") return now;
          const agent = await this.#wakeups.nextDue(now, this.#quota);
          const human = pendingHumanWake(this.#o.dataDir, now);
          return agent === null ? human : human === null ? agent : Math.min(agent, human);
        },
      },
      humanWakePending: (now) => pendingHumanWake(this.#o.dataDir, now) !== null || executionMode(this.#o.dataDir) === "always-on" || (this.#registration.id === "claude" && ownerMessagePending(this.#o.dataDir, true)),
      alwaysOn: () => executionMode(this.#o.dataDir) === "always-on",
      priority: this.#signal,
      launcher: this,
      lock: this.#lock,
      recheckIntervalMs: this.#o.recheckIntervalMs ?? DEFAULT_RECHECK_MS,
    });
    this.#scheduler = scheduler;
    try {
      if (real !== null && real.sandbox === null) {
        this.#workspaceSync = new WorkspaceGitSync(this.#o.dataDir, () => {
          const profile = uow.profiles.get(profileId);
          const policy = resolvePolicy(uow.policies, profileId);
          return policy.status === "active" &&
            policy.revision.groups.runtime.hostUnsandboxedAcknowledged === true &&
            !this.#abort.signal.aborted && !new StopFlag(this.#o.dataDir).exists() &&
            profile !== null && !profile.emergencyStopLocked &&
            !["paused", "checkpointing", "stopped", "disabled"].includes(profile.state);
        });
      }
      if (real !== null && real.sandbox === null) {
        this.#backgroundJobs = new BackgroundJobs(this.#o.dataDir, () => {
          const profile = uow.profiles.get(profileId);
          const policy = resolvePolicy(uow.policies,profileId);
          return !this.#abort.signal.aborted && !new StopFlag(this.#o.dataDir).exists() && profile !== null && !profile.emergencyStopLocked &&
            !["paused","checkpointing","stopped","disabled"].includes(profile.state) &&
            policy.status === "active" && policy.revision.groups.runtime.hostUnsandboxedAcknowledged === true;
        });
        this.#backgroundJobs.start();
      }
      await scheduler.run(this.#abort.signal);
    } finally {
      await this.#workspaceSync?.close();
      await this.#backgroundJobs?.close();
      this.#close();
    }
    return { runId: this.runId, sessions: [...this.#results], reason: this.#stopReason };
  }

  #close(): void {
    this.#keyboardContext.close();
    const at = utcNow();
    try {
      recordDaemonEnd(this.#store.db, this.runId, at, this.#stopReason);
      this.#store.uow.journal.append(
        prepareJournalEvent({
          type: "daemon_stopped",
          at,
          profileId: this.#o.profileId,
          reason: `daemon arrêté : ${this.#stopReason}`,
          metadata: {
            runId: this.runId,
            sessions: this.#results.length,
            mode: this.#real === null ? "simulated" : "real",
          },
        }),
      );
    } finally {
      this.#idleWatcher?.close();
      this.#lock.release();
      this.#store.close();
    }
    this.#log(`daemon arrêté : ${this.#stopReason}`);
  }

  #reconcileArtifacts(): void {
    const report = reconcileArtifacts(this.#store.db, this.#root, this.#o.profileId);
    if (report.anomalies.length === 0 && !report.truncated) return;
    this.#store.uow.journal.append(
      prepareJournalEvent({
        type: "orphan_reconciled",
        at: utcNow(),
        profileId: this.#o.profileId,
        reason: "artefacts : anomalies constatées au démarrage (rapport seulement, rien supprimé)",
        metadata: {
          kind: "artifacts",
          referenced: report.referenced,
          scannedFiles: report.scannedFiles,
          truncated: report.truncated,
          anomalies: report.anomalies.map((a) => ({ kind: a.kind, path: a.path })),
        },
      }),
    );
    this.#log(`artefacts : ${String(report.anomalies.length)} anomalie(s) journalisée(s)`);
  }

  // ── SessionLauncher ────────────────────────────────────────────────────────────

  reconcileOrphans(): Promise<void> {
    this.#runner.reconcileAtStartup();
    return Promise.resolve();
  }

  async launch(ticket: LaunchTicket): Promise<SessionReport> {
    const { uow } = this.#store;
    const record = uow.sessions.get(ticket.sessionId);
    const experimentId = record?.experimentId ?? null;
    // Contexte borné à la moitié de l'enveloppe ; sur abonnement (aucune enveloppe de
    // tokens), à la moitié du plafond de session de la policy, simple borne de contexte.
    const tokens = ticket.maxima.find((q) => q.unit === "tokens");
    const sessionTokens =
      tokens?.unit === "tokens"
        ? tokens.amount
        : (uow.policies.getRevision(ticket.policyRevisionId)?.groups.budget.tokensPerSession ?? 0);
    const maxInputTokens =
      sessionTokens === 0 ? 32_000 : Math.max(1, Math.floor(sessionTokens / 2));
    // La consigne de réveil occupe une part du contexte ; la mémoire prend le reste. Le
    // factice ignore le contexte : sa mémoire garde toute l'enveloppe (démo inchangée).
    const keyboardContext = this.#keyboardContext.takeContext(
      Math.max(512, Math.floor(maxInputTokens / 3)),
    );
    const promptBound =
      utf8TokenBound(this.#templates.base) + 2_048 + utf8TokenBound(keyboardContext ?? "");
    const memory = this.#memory(
      experimentId,
      this.#real === null ? maxInputTokens : Math.max(1, maxInputTokens - promptBound),
    );
    const scenario: FakeScenario | undefined =
      this.#real !== null
        ? undefined
        : (this.#o.scenario ??
          emergenceScenario({
            artifactRoot: this.#root.real,
            artifactsSegment: ARTIFACTS_SEGMENT,
            memory: memory?.included ?? [],
            lastCheckpoint: memory?.checkpoint?.sequence ?? null,
          }));
    const billing: BillingFacts = this.#registration.billing();
    // Lu avant `#composeWake`, qui consomme la demande.
    const humanRequested = pendingHumanWake(this.#o.dataDir, Date.now()) !== null || executionMode(this.#o.dataDir) === "always-on" || (this.#registration.id === "claude" && ownerMessagePending(this.#o.dataDir, true));
    const wake = await this.#composeWake(ticket, memory, billing, keyboardContext === null ? [] : [keyboardContext]);
    this.#sessions.set(ticket.sessionId, {
      revisionId: ticket.policyRevisionId,
      experimentId,
      scenario,
    });
    this.#log(
      `session ${ticket.sessionId} lancée (${scenario === undefined ? `adapter ${this.#registration.id}` : `scénario ${scenario.name}`}, mémoire ${memory?.status ?? "aucune expérience"}${memory?.interruption == null ? "" : ` — ${memory.interruption}`})`,
    );
    // Pilotage : jauge lue au début et à la fin pour mesurer le débit de la session.
    const guard = billing.kind === "subscription_quota" ? this.#activeGuard() : null;
    const quotaAtStart = guard === null ? undefined : await this.#quota?.().catch(() => undefined);
    const startedAtMs = Date.now();
    let result: SessionResult;
    let sharedInbox: SharedInboxSession | null = null;
    try {
      const visual = await collectAgentScreenshot({
        artifactsDir: this.#root.real,
        stateDir: this.#o.dataDir,
        authorizedSurface: () => configuredWakeScreenshot(this.#o.dataDir, this.#o.wakeScreenshot),
        observation: () => this.#idleWatcher?.latest() ?? null,
        capture: (surface) => this.#real !== null &&
          (this.#registration.id === "claude" || this.#registration.id === "codex")
          ? captureWakeScreenshot(surface) : Promise.resolve(undefined),
      });
      const screenshotDecision = visual.decision;
      const screenshotSurface = screenshotDecision.surface;
      const wakeImage = visual.image;
      this.#log(`capture ambiante : ${screenshotDecision.mode}, ${screenshotDecision.reason}${visual.discardedAfterCapture ? " (image écartée après relecture)" : ""}`);
      this.#store.uow.journal.append(prepareJournalEvent({
        type: "wake_screenshot_decided", at: utcNow(), profileId: this.#o.profileId,
        sessionId: ticket.sessionId, reason: screenshotDecision.reason,
        metadata: { mode: screenshotDecision.mode, reason: screenshotDecision.reason,
          ...(screenshotSurface === undefined ? {} : { surface: screenshotSurface }),
          imageAttached: wakeImage !== undefined, discardedAfterCapture: visual.discardedAfterCapture },
      }));
      if (screenshotSurface !== undefined)
        this.#log(
          wakeImage === undefined
            ? "contexte visuel indisponible : réveil sans image"
            : `contexte visuel ${wakeImage.width}x${wakeImage.height}, ${wakeImage.capturedAt} (${wakeImage.surface})`,
        );
      // Collect only for this already-authorised session, never from the scheduler.
      if (this.#real !== null && this.#real.sandbox === null) {
        const inboxActive = (): boolean => {
          const profile = uow.profiles.get(ticket.profileId);
          const policy = resolvePolicy(uow.policies, ticket.profileId);
          return !this.#abort.signal.aborted && !new StopFlag(this.#o.dataDir).exists() &&
            this.#sessions.has(ticket.sessionId) && profile !== null && !profile.emergencyStopLocked &&
            !["paused", "checkpointing", "stopped", "disabled"].includes(profile.state) &&
            policy.status === "active" && policy.revision.groups.runtime.hostUnsandboxedAcknowledged === true;
        };
        try {
          sharedInbox = openSharedInboxSession(this.#o.dataDir, ticket.profileId, inboxActive);
          sharedInbox?.start(() => this.#log("shared inbox unavailable; retry remains inside the active session"));
          await sharedInbox?.sync();
        } catch {
          this.#log("shared inbox unavailable; Wake continues without importing remote messages");
        }
      }
      const running = await this.#runner.launch({
        profileId: ticket.profileId,
        sessionId: ticket.sessionId,
        experimentId,
        reservationId: ticket.reservationId,
        decision: {
          verdict: "allow",
          revisionId: ticket.policyRevisionId,
          reason: "launch.allowed",
        },
        context: wake.text,
        systemContext: wake.systemContext,
        ...(wakeImage === undefined ? {} : { wakeImage }),
        maxInputTokens,
        sessionPrepared: true,
        onSubscription: billing.kind === "subscription_quota",
        ...(humanRequested ? { humanRequested: true } : {}),
      });
      result = await running.done;
    } catch (error) {
      // Lancement impossible (arrêt survenu entre-temps…) : la session préparée devient
      // orpheline, sa réservation reste incertaine ; rien n'est relancé.
      this.#runner.reconcileAtStartup();
      const detail = error instanceof Error ? error.message : String(error);
      this.#log(`session ${ticket.sessionId} non lancée : ${detail}`);
      this.#sessions.delete(ticket.sessionId);
      return {
        sessionId: ticket.sessionId,
        outcome: "orphaned",
        failure: { kind: "fatal", detail },
      };
    } finally {
      sharedInbox?.stop();
    }
    this.#sessions.delete(ticket.sessionId);
    this.#results.push(result);
    if (guard !== null && quotaAtStart !== undefined) {
      const quotaAtEnd = await this.#quota?.().catch(() => undefined);
      if (quotaAtEnd !== undefined) {
        this.#pacing.recordSession(guard, quotaAtStart, quotaAtEnd, startedAtMs, Date.now());
      }
    }
    this.#log(
      `session ${result.sessionId} terminée : ${result.outcome} (${result.reason}), ${String(result.tokens)} tokens ${result.provenance}, profil ${result.profileState ?? "inconnu"}`,
    );
    const limit = this.#o.exitAfterSessions;
    if (limit !== undefined && this.#results.length >= limit) {
      this.requestStop(`${String(limit)} session(s) terminée(s) (--exit-after-sessions)`);
    }
    return reportFor(result);
  }

  /** Remise à zéro de la fenêtre pilotée (la plus proche), d'après une lecture officielle. */
  async #pilotedResetAt(billing: BillingFacts): Promise<UtcTimestamp | null> {
    if (billing.kind !== "subscription_quota" || this.#quota === undefined) return null;
    const snapshots = await this.#quota().catch(() => undefined);
    const now = Date.now();
    const resets = (snapshots ?? [])
      .filter((s) => s.provenance === "measured")
      .map((s) => Date.parse(s.resetsAt))
      .filter((ms) => Number.isFinite(ms) && ms > now);
    return resets.length === 0
      ? null
      : (new Date(Math.min(...resets)).toISOString() as UtcTimestamp);
  }

  /** Garde de quota de la révision active, si elle est activée. */
  #activeGuard(): Extract<SubscriptionQuotaGuard, { enabled: true }> | null {
    const resolution = resolvePolicy(this.#store.uow.policies, this.#o.profileId);
    const guard =
      resolution.status === "active"
        ? resolution.revision.groups.budget.subscriptionQuota
        : undefined;
    return guard?.enabled === true ? guard : null;
  }

  /**
   * Prompt de réveil : `base.md` rempli depuis la policy effective et la session, une
   * relance (ou la note d'une demande de réveil de l'agent), puis le bloc de mémoire.
   */
  async #composeWake(
    ticket: LaunchTicket,
    memory: WakeMemory | null,
    billing: BillingFacts,
    events: readonly string[] = [],
  ): Promise<ReturnType<typeof composeWake>> {
    const { uow, db } = this.#store;
    const revision = uow.policies.getRevision(ticket.policyRevisionId);
    if (revision === null) throw new Error("Wake policy revision missing");
    const agentWakeup = await this.#wakeups.takeDue(Date.now(), this.#quota);
    if (pendingHumanWake(this.#o.dataDir, Date.now()) !== null) {
      consumeHumanWake(this.#o.dataDir);
      this.#log("réveil : demande de l'humain servie");
    }
    const isolation =
      this.#real === null
        ? "job_only"
        : revision.groups.runtime.hostUnsandboxedAcknowledged === true
          ? "host_unsandboxed"
          : "sandbox";
    const composition = composeWake({
      templates: this.#templates,
      events: [
        ...events,
        ...(this.#backgroundJobs?.store.events(true) ?? []),
        // Contexte en cours noté par l'agent : rappel de son projet et de ses réveils budgétés.
        ...[currentContextEvent(artifactsDirFor(this.#o.dataDir))].filter((e) => e !== null),
      ],
      revision,
      isolation,
      onSubscription: billing.kind === "subscription_quota",
      workspaceDir: workspaceDirFor(this.#o.dataDir),
      wakeupsDir: this.#wakeups.dir,
      wakeupsSchema: this.#wakeups.schemaPath,
      sessionEnd: ticket.deadline,
      quotaResetAt: await this.#pilotedResetAt(billing),
      theme: this.#o.theme ?? null,
      memory: memory === null || memory.status === "empty" ? null : memory.text,
      nextAction: memory?.included.find((i) => i.section === "next_action")?.text ?? null,
      previousNudge: previousNudge(db, this.#o.profileId),
      agentWakeup,
    });
    recordWakePrompt(db, this.#o.profileId, ticket.sessionId, composition, utcNow());
    this.#log(
      composition.agentWakeupId === null
        ? `réveil : relance « ${composition.nudge ?? "—"} » (${composition.source})`
        : `réveil : demande de l'agent « ${composition.agentWakeupId} » à la place de la relance`,
    );
    return composition;
  }

  #memory(experimentId: ExperimentId | null, maxInputTokens: number): WakeMemory | null {
    if (experimentId === null) return null;
    const { db, uow } = this.#store;
    const last = db
      .prepare<[string], { id: string }>(
        `SELECT id FROM sessions WHERE experiment_id = ? AND outcome IS NOT NULL
         ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get(experimentId);
    const lastSession: SessionRecord | null =
      last === undefined ? null : uow.sessions.get(last.id as SessionId);
    return loadWakeMemory({ uow, experimentId, maxInputTokens, lastSession });
  }

  // ── Contenu proposé par l'agent (non fiable) ──────────────────────────────────

  #onProposal(sessionId: SessionId, proposal: unknown): void {
    const context = this.#sessions.get(sessionId);
    const revision =
      context === undefined ? null : this.#store.uow.policies.getRevision(context.revisionId);
    if (context === undefined || revision === null) return;
    const outcome = registerProposal(
      {
        uow: this.#store.uow,
        db: this.#store.db,
        profileId: this.#o.profileId,
        sessionId,
        revision,
        now: utcNow,
        simulated: this.#real === null,
      },
      proposal,
    );
    if (outcome.status === "accepted") {
      context.experimentId = outcome.experiment.id;
      this.#log(`expérience choisie par l'agent : ${outcome.experiment.title}`);
    } else {
      // Une expérience déjà active reste celle de la session.
      context.experimentId ??= this.#store.uow.experiments.getActive(this.#o.profileId)?.id ?? null;
      this.#log(`proposition refusée : ${outcome.reason}`);
    }
  }

  #onCheckpoint(candidate: CheckpointCandidate): void {
    const { uow } = this.#store;
    const context = this.#sessions.get(candidate.sessionId);
    const profile = uow.profiles.get(this.#o.profileId);
    if (context === undefined || profile === null) return;
    const at = utcNow();
    const action = { kind: "publish_checkpoint" };
    const decision = decideAction(
      uow.policies,
      { state: profile.state, emergencyStopLocked: profile.emergencyStopLocked },
      {
        profileId: this.#o.profileId,
        sessionId: candidate.sessionId,
        policyRevisionId: context.revisionId,
      },
      { ...this.#liveChecks(), onSubscription: false, now: at },
      action,
    );
    uow.journal.append(
      prepareJournalEvent(
        decisionJournalEvent(decision, {
          profileId: this.#o.profileId,
          at,
          action,
          sessionId: candidate.sessionId,
        }),
      ),
    );
    if (decision.verdict !== "allow") {
      this.#log(`checkpoint refusé par la policy : ${decision.reason}`);
      return;
    }
    const published = publishCheckpoint(
      {
        uow,
        root: this.#root,
        profileId: this.#o.profileId,
        sessionId: candidate.sessionId,
        now: utcNow,
      },
      candidate,
    );
    this.#log(
      published.status === "published"
        ? `checkpoint ${String(published.checkpoint.sequence)} publié (${String(published.checkpoint.artifacts.length)} artefact(s))`
        : `checkpoint rejeté : ${published.reasons.join(", ")}`,
    );
  }

  /** Scheduler en service (tests). */
  get scheduler(): Scheduler | null {
    return this.#scheduler;
  }
}

/** Adapter réel désigné par la policy : enregistré, jamais un repli, jamais simulé. */
function realRegistration(
  registry: AdapterRegistry,
  wanted: AdapterId | null,
): AdapterRegistration {
  if (wanted === null) {
    throw new DaemonError(
      "runtime_mismatch",
      "aucune policy active ne désigne de runtime : activer une policy avant le mode réel",
    );
  }
  const registration = registry.get(wanted);
  if (registration === null) {
    const known = registry.realIds();
    throw new DaemonError(
      "real_adapter_missing",
      `adapter « ${wanted} » non enregistré dans ce build (adapters réels enregistrés : ${known.length === 0 ? "aucun" : known.join(", ")}) ; aucun repli vers un autre runtime`,
    );
  }
  if (registration.simulated) {
    throw new DaemonError(
      "runtime_mismatch",
      `la policy désigne l'adapter simulé « ${wanted} » : relancer avec --simulated, tout sera marqué SIMULÉ`,
    );
  }
  return registration;
}

/** Probe de l'adapter réel et lanceur confiné ; l'autotest a lieu au démarrage de `run`. */
async function realMode(
  options: DaemonOptions,
  registration: AdapterRegistration,
  runtimeDir: string,
  hostUnsandboxed: boolean,
): Promise<RealMode> {
  // Adapter construit hors runner, pour le seul probe : aucun processus ne peut être lancé.
  const probeOnly: RuntimeAdapter = registration.create({
    host: {
      spawnContained: () => {
        throw new DaemonError("adapter_unavailable", "probe : aucun lancement");
      },
      authorize: () => ({ allowed: false, reason: "probe", interruptSession: true }),
      isolation: () => "none",
    },
    dataDir: options.dataDir,
    workspaceDir: workspaceDirFor(options.dataDir),
    experimentFor: () => null,
    onProposal: () => undefined,
    fakeScenario: () => undefined,
  });
  let probe: ProbeResult;
  try {
    probe = await probeOnly.probe();
  } catch (error) {
    throw new DaemonError(
      "adapter_unavailable",
      `probe de l'adapter « ${registration.id} » en échec : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!probe.available || probe.simulated || probe.adapterId !== registration.id) {
    const why =
      probe.unavailableReason ?? (probe.simulated ? "adapter simulé" : "probe non conforme");
    throw new DaemonError(
      "adapter_unavailable",
      `adapter « ${registration.id} » indisponible : ${why}`,
    );
  }
  const isolation = options.isolation;
  // Mode non isolé consenti (ADR-006) : la sandbox reste disponible mais n'est pas exigée.
  const sandbox = hostUnsandboxed ? null : (isolation?.sandbox ?? new Sandbox(runtimeDir));
  if (sandbox !== null && !sandbox.status.available) {
    throw new DaemonError(
      "sandbox_unavailable",
      `isolation indisponible : ${sandbox.status.reason}`,
    );
  }
  return {
    registration,
    probe,
    sandbox,
    selfTest: isolation?.selfTest ?? (() => runIsolationSelfTest()),
    runtimeRoots: [...(registration.runtimeRoots?.() ?? []), ...(isolation?.runtimeRoots ?? [])],
  };
}
