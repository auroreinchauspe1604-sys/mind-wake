import type { WakeScreenshotChoice } from "../../daemon/wake-screenshot.js";
import { createInterface } from "node:readline";
/**
 * `daemon run` : daemon Wake au premier plan, dans le terminal de l'humain. Ni service
 * Windows, ni tâche planifiée, ni démarrage automatique : il s'arrête avec Ctrl+C (fin
 * de la session en cours puis arrêt ; un second Ctrl+C arrête aussitôt, la session est
 * alors réconciliée comme orpheline au démarrage suivant).
 *
 * Avec `--simulated`, seul l'adapter factice tourne et tout est marqué SIMULÉ (sortie,
 * journal, statut, bilan). Sans `--simulated`, le daemon exécute l'adapter réel désigné
 * par la policy, seulement s'il est enregistré dans ce build et que son `probe` le dit
 * disponible, et seulement dans la sandbox après un autotest de refus réussi ; sinon il
 * refuse avec motif, sans repli vers un autre runtime. Aucun port réseau.
 */

import {
  FAKE_SCENARIO_NAMES,
  fakeScenario,
  type FakeScenarioName,
} from "../../adapters/fake/index.js";
import { DaemonError, WakeDaemon, type DaemonSummary } from "../../daemon/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";

/** Lanceur Job Object compilé hors du dossier de données (développement, tests). */
export const RUNTIME_DIR_ENV = "MIND_WAKE_RUNTIME_DIR";

/**
 * Scénario factice imposé à toutes les sessions (tests de crash et de contrôles) ; sans
 * cette variable, l'agent factice de la démo choisit selon sa mémoire.
 */
export const FAKE_SCENARIO_ENV = "MIND_WAKE_FAKE_SCENARIO";

function forcedScenario(name: string | undefined): FakeScenarioName | null {
  if (name === undefined || name === "") return null;
  const known = FAKE_SCENARIO_NAMES.find((n) => n === name);
  if (known === undefined) throw new Error(`${FAKE_SCENARIO_ENV} : scénario inconnu (${name})`);
  return known;
}

export interface DaemonRunOptions {
  readonly wakeScreenshot?: WakeScreenshotChoice;
  readonly simulated: boolean;
  readonly recheckMs: number | null;
  readonly exitAfterSessions: number | null;
  /** Sortie JSON : aucune ligne de suivi, seulement le résultat final. */
  readonly quiet: boolean;
}

export interface DaemonRunData {
  readonly started: boolean;
  readonly simulated: boolean;
  readonly runId: string | null;
  readonly refusal: { readonly code: DaemonError["code"]; readonly detail: string } | null;
  readonly stopReason: string | null;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly outcome: string;
    readonly reason: string;
    readonly tokens: number;
    readonly provenance: string;
  }[];
}

export async function daemonRun(
  ctx: CliContext,
  dataDir: DataDir,
  options: DaemonRunOptions,
): Promise<CommandResult<DaemonRunData>> {
  let daemon: WakeDaemon;
  try {
    const runtimeDir = ctx.env[RUNTIME_DIR_ENV];
    const scenario = forcedScenario(ctx.env[FAKE_SCENARIO_ENV]);
    daemon = await WakeDaemon.open({
      dataDir: dataDir.path,
      profileId: DEFAULT_PROFILE_ID,
      simulated: options.simulated,
      ...(options.wakeScreenshot === undefined ? {} : { wakeScreenshot: options.wakeScreenshot }),
      ...(options.recheckMs === null ? {} : { recheckIntervalMs: options.recheckMs }),
      ...(options.exitAfterSessions === null
        ? {}
        : { exitAfterSessions: options.exitAfterSessions }),
      ...(runtimeDir === undefined || runtimeDir === "" ? {} : { runtimeDir }),
      ...(scenario === null ? {} : { scenario: fakeScenario(scenario) }),
      ...(options.quiet
        ? {}
        : {
            log: (line: string) => {
              ctx.stdout(`${line}\n`);
            },
          }),
    });
  } catch (error) {
    if (!(error instanceof DaemonError)) throw error;
    return {
      exitCode: EXIT_FAILURE,
      data: {
        started: false,
        simulated: options.simulated,
        runId: null,
        refusal: { code: error.code, detail: error.message },
        stopReason: null,
        sessions: [],
      },
      human: formatDaemonRun,
    };
  }
  let interrupts = 0;
  const detach = ctx.onInterrupt?.(() => {
    interrupts += 1;
    if (interrupts === 1) {
      daemon.requestStop("interruption au clavier");
    } else {
      // Arrêt immédiat : le lanceur Job Object termine l'arborescence à la fin de son
      // canal de contrôle ; la session sera réconciliée comme orpheline.
      ctx.exit?.(130);
    }
  });
  let summary: DaemonSummary;
  const isOwnedEngine = !!process.env["MIND_WAKE_OWNED_INSTANCE"];
  const ownedStop = (message: unknown): void => {
    if (
      isOwnedEngine &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "wake_owned_stop"
    )
      daemon.requestStop("redémarrage demandé au superviseur propriétaire");
  };
  process.on("message", ownedStop);
  const ownedInput = isOwnedEngine ? createInterface({ input: process.stdin }) : null;
  ownedInput?.on("line", (line) => {
    try {
      ownedStop(JSON.parse(line));
    } catch {
      /* Parent control channel accepts only typed JSON. */
    }
  });
  const disconnected = (): void => {
    if (isOwnedEngine) daemon.requestStop("superviseur propriétaire déconnecté");
  };
  process.on("disconnect", disconnected);
  try {
    summary = await daemon.run();
  } finally {
    detach?.();
    process.removeListener("message", ownedStop);
    process.removeListener("disconnect", disconnected);
    ownedInput?.close();
    if (isOwnedEngine && process.connected) process.disconnect();
  }
  return {
    exitCode: EXIT_OK,
    data: {
      started: true,
      simulated: daemon.simulated,
      runId: summary.runId,
      refusal: null,
      stopReason: summary.reason,
      sessions: summary.sessions.map((s) => ({
        sessionId: s.sessionId,
        outcome: s.outcome,
        reason: s.reason,
        tokens: s.tokens,
        provenance: s.provenance,
      })),
    },
    human: formatDaemonRun,
  };
}

function formatDaemonRun(data: DaemonRunData): string {
  if (!data.started) {
    return `Daemon non démarré [${data.refusal?.code ?? "—"}] : ${data.refusal?.detail ?? "—"}`;
  }
  if (!data.simulated) {
    return [
      `Exécution ${data.runId ?? "—"} terminée : ${data.stopReason ?? "—"}`,
      `Sessions menées : ${String(data.sessions.length)} (sessions confinées, adapter réel)`,
    ].join("\n");
  }
  return [
    `[SIMULÉ] Exécution ${data.runId ?? "—"} terminée : ${data.stopReason ?? "—"}`,
    `Sessions menées : ${String(data.sessions.length)} (consommation SIMULÉE, aucun appel modèle)`,
  ].join("\n");
}
