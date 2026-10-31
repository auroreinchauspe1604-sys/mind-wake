/**
 * Enregistrement de Claude Code dans le daemon, en mode réel (`daemon run` sans
 * `--simulated`), avec le faux exécutable `claude` : aucun appel modèle. Vérifie
 * l'acceptation d'une policy `runtime.adapterId = "claude"` et les refus motivés quand le
 * consentement au mode non isolé, la jauge ou `probe` manquent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE,
  demoDir,
  seedSimulatedProfile,
  type DemoDir,
} from "../../../test/demo/harness.js";
import { SHARED_RUNTIME_DIR } from "../../../test/fixtures/runner/setup.js";
import type { SubscriptionQuotaGuard } from "../../contracts/index.js";
import { DaemonError, WakeDaemon } from "../../daemon/daemon.js";
import { controlDbPath } from "../../daemon/paths.js";
import { AdapterRegistry, FAKE_REGISTRATION, defaultRegistry } from "../../daemon/registry.js";
import type { IsolationSelfTestReport, Sandbox } from "../../sandbox/index.js";
import { openStoreReadOnly } from "../../store/index.js";
import {
  CLAUDE_ADAPTER_ID,
  CLAUDE_AUTH_MODE,
  CLAUDE_PROVIDER,
  claudeRegistration,
  defaultClaudeConfig,
} from "./index.js";

const WINDOWS = process.platform === "win32";
const TIMEOUT = 90_000;
const FAKE_CLAUDE = fileURLToPath(
  new URL("../../../test/fixtures/claude/fake-claude.ts", import.meta.url),
);

/** Poste inactif depuis une heure : le signal réel (GetLastInputInfo) n'est pas lu en test. */
const IDLE = {
  latest: () => ({ idleMs: 3_600_000, observedAtMs: Date.now() }),
  close: () => undefined,
};

/** Garde de quota : la fenêtre hebdomadaire du faux CLI se remet à zéro dans 3 jours. */
const GUARD: SubscriptionQuotaGuard = {
  enabled: true,
  accountRiskAcknowledged: true,
  startBelowBasisPoints: 6_000,
  stopAtBasisPoints: 8_000,
  userReserveBasisPoints: 1_000,
  overshootBoundBasisPoints: 500,
  maxSnapshotAgeMs: 120_000,
  targetUsageBasisPoints: 8_000,
  initialRateBasisPointsPerHour: 2_000,
  pacingMarginRatio: 0.25,
};

const RUNTIME = { provider: CLAUDE_PROVIDER, model: "opus", authMode: CLAUDE_AUTH_MODE };

describe("enregistrement Claude : registre par défaut", () => {
  it("défaut du build : factice et Claude, runtime déclaré sans substitution", () => {
    const registry = defaultRegistry();
    expect(registry.realIds()).toContain(CLAUDE_ADAPTER_ID);
    const registration = registry.get("claude");
    expect(registration?.simulated).toBe(false);
    expect(registration?.billing()).toEqual({ kind: "subscription_quota" });
    const config = defaultClaudeConfig({
      MIND_WAKE_CLAUDE_EXE: "C:/outils/claude.exe",
      MIND_WAKE_CLAUDE_MODEL: "sonnet",
    });
    expect(claudeRegistration(config).runtime()).toEqual({
      adapterId: "claude",
      provider: "anthropic",
      model: "sonnet",
      authMode: "claude_subscription",
    });
    expect(claudeRegistration(config).runtimeRoots?.()).toEqual(["C:/outils"]);
  });
});

describe.runIf(WINDOWS)("enregistrement Claude : daemon en mode réel, faux CLI", () => {
  let dir: DemoDir;
  let state: string;
  let log: string;

  beforeEach(() => {
    dir = demoDir("mind-wake-claude-");
    state = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-claude-state-"));
    log = path.join(state, "invocations.jsonl");
  });

  afterEach(() => {
    dir.remove();
    fs.rmSync(state, { recursive: true, force: true });
  });

  function registry(
    usage: "fresh" | "none" = "fresh",
    executable: string = process.execPath,
  ): AdapterRegistry {
    return new AdapterRegistry([
      FAKE_REGISTRATION,
      claudeRegistration({
        executable,
        executablePrefixArgs: [FAKE_CLAUDE],
        model: "opus",
        runtimeDir: SHARED_RUNTIME_DIR,
        extraEnv: {
          FAKE_CLAUDE_SCENARIO: "success",
          FAKE_CLAUDE_USAGE: usage,
          FAKE_CLAUDE_STATE: state,
          FAKE_CLAUDE_LOG: log,
        },
      }),
    ]);
  }

  function seed(hostUnsandboxed: boolean): void {
    seedSimulatedProfile(dir.path, {
      runtimeAdapterId: CLAUDE_ADAPTER_ID,
      runtime: RUNTIME,
      subscriptionQuota: GUARD,
      hostUnsandboxed,
    });
  }

  function invocations(): { argv: string[] }[] {
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
  }

  /** Lance `run`, attend un motif dans le journal ou le profil, puis arrête le daemon. */
  async function runUntil(daemon: WakeDaemon, pattern: RegExp): Promise<string> {
    const running = daemon.run();
    const deadline = Date.now() + 30_000;
    let seen = "";
    while (Date.now() < deadline) {
      const store = openStoreReadOnly(controlDbPath(dir.path));
      try {
        seen = JSON.stringify({
          profile: store.uow.profiles.get(PROFILE),
          events: store.uow.journal.list(PROFILE),
        });
      } finally {
        store.close();
      }
      if (pattern.test(seen)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    daemon.requestStop("fin du test");
    const summary = await running;
    expect(summary.sessions).toHaveLength(0);
    return seen;
  }

  it(
    "accepte une policy claude consentie : jauge, session non isolée, usage mesuré",
    async () => {
      seed(true);
      const lines: string[] = [];
      const daemon = await WakeDaemon.open({
        dataDir: dir.path,
        profileId: PROFILE,
        simulated: false,
        registry: registry(),
        runtimeDir: SHARED_RUNTIME_DIR,
        idleWatcher: IDLE,
        recheckIntervalMs: 1_000,
        exitAfterSessions: 1,
        log: (line) => lines.push(line),
      });
      expect(daemon.simulated).toBe(false);
      const personalDir = path.join(dir.path, "workspace", "artifacts");
      fs.mkdirSync(personalDir, { recursive: true });
      fs.writeFileSync(
        path.join(personalDir, "PERSONALITY.md"),
        "My evolving voice: warm, playful and candid.",
      );
      const summary = await daemon.run();
      expect(summary.sessions).toHaveLength(1);
      expect(summary.sessions[0]).toMatchObject({
        outcome: "completed",
        isolation: "host_unsandboxed",
        tokens: 200,
        provenance: "measured",
      });
      expect(lines.some((l) => l.startsWith("[NON ISOLÉ]"))).toBe(true);

      const calls = invocations();
      const quota = calls.filter((c) => c.argv.includes("--no-session-persistence"));
      const sessions = calls.filter((c) => !c.argv.includes("--no-session-persistence"));
      expect(quota.length).toBeGreaterThan(0);
      for (const call of quota) expect(call.argv).not.toContain("--dangerously-skip-permissions");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.argv).toContain("--dangerously-skip-permissions");
      expect(sessions[0]?.argv).toContain("--append-system-prompt-file");
      const hookSettings = JSON.parse(
        sessions[0]!.argv[sessions[0]!.argv.indexOf("--settings") + 1]!,
      );
      expect(hookSettings.hooks.PostToolUse[0].hooks[0].args).toContain(dir.path);
      expect(hookSettings.hooks.SessionStart).toBeDefined();
      const promptIndex = sessions[0]!.argv.indexOf("--append-system-prompt-file");
      const runtimePrompt = fs.readFileSync(sessions[0]!.argv[promptIndex + 1]!, "utf8");
      expect(runtimePrompt).toContain("You are an agent of MIND.");
      expect(runtimePrompt).toContain("When you receive an actual new human message");
      expect(runtimePrompt).toContain("before starting long execution or delegation");
      expect(runtimePrompt).toContain("terminal output is not publication in the Wake conversation");
      expect(runtimePrompt).toContain(
        "Stay actively engaged throughout the time and compute allocated to this wake.",
      );
      expect(runtimePrompt).toContain("Wake environment — runtime configuration");
      expect(runtimePrompt).toContain("Your space:");
      expect(runtimePrompt).toContain("NOT ISOLATED");
      expect(runtimePrompt).toContain("A human theme is optional");
      expect(runtimePrompt).toContain("My evolving voice: warm, playful and candid.");
      expect(runtimePrompt).toContain("artifacts/questions-for-human.md");
      expect(runtimePrompt).toContain("old self-imposed rules");
      expect(sessions[0]?.argv).toContain("--session-id");

      const store = openStoreReadOnly(controlDbPath(dir.path));
      try {
        const events = store.uow.journal.list(PROFILE);
        expect(events.findLast((e) => e.type === "session_ended")?.metadata).toMatchObject({
          isolation: "host_unsandboxed",
          simulated: false,
        });
        expect(events.find((e) => e.type === "daemon_started")?.metadata).toMatchObject({
          mode: "real",
          adapterId: "claude",
          isolation: "host_unsandboxed",
        });
      } finally {
        store.close();
      }
      const conversations = path.join(dir.path, "runtimes", "claude", "conversations.json");
      expect(fs.existsSync(conversations)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "jauge absente : aucun lancement, motif quota inconnu",
    async () => {
      seed(true);
      const daemon = await WakeDaemon.open({
        dataDir: dir.path,
        profileId: PROFILE,
        simulated: false,
        registry: registry("none"),
        runtimeDir: SHARED_RUNTIME_DIR,
        idleWatcher: IDLE,
        recheckIntervalMs: 1_000,
      });
      const seen = await runUntil(daemon, /quota_unknown/);
      expect(seen).toMatch(/subscription\.quota_unknown/);
      expect(invocations().every((c) => c.argv.includes("--no-session-persistence"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "consentement absent : sandbox exigée, autotest en échec, profil bloqué sans repli",
    async () => {
      seed(false);
      const failed: IsolationSelfTestReport = {
        passed: false,
        platform: "win32",
        profile: null,
        checks: [],
        termination: null,
        cleanup: { aclRemoved: true, profileRemoved: true, tempRemoved: true },
        notDemonstrated: [],
        durationMs: 1,
      };
      const sandbox = {
        status: { available: true, launcherPath: "absent.exe", sourceDigest: "test" },
        profile: "mindwake.test.claude",
        ensureProfile: () => ({ sid: "S-1-15-2-0", created: false }),
        health: () => ({ operational: false, detail: "banc" }),
      } as unknown as Sandbox;
      const daemon = await WakeDaemon.open({
        dataDir: dir.path,
        profileId: PROFILE,
        simulated: false,
        registry: registry(),
        isolation: { sandbox, selfTest: () => Promise.resolve(failed) },
        runtimeDir: SHARED_RUNTIME_DIR,
        idleWatcher: IDLE,
        recheckIntervalMs: 1_000,
      });
      const seen = await runUntil(daemon, /"state":"blocked"/);
      expect(seen).toMatch(/sandbox_unavailable/);
      expect(invocations().some((c) => c.argv.includes("--dangerously-skip-permissions"))).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  it("probe en échec (CLI absent) : refus au démarrage, sans repli", async () => {
    seed(true);
    const refused = await WakeDaemon.open({
      dataDir: dir.path,
      profileId: PROFILE,
      simulated: false,
      registry: registry("fresh", path.join(state, "absent", "claude.exe")),
      runtimeDir: SHARED_RUNTIME_DIR,
      idleWatcher: IDLE,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonError);
    expect(refused).toMatchObject({ code: "adapter_unavailable" });
    expect((refused as Error).message).toMatch(/claude --version a échoué/);
  });
});
