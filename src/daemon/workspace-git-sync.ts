import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod";
import {
  atomicLocalJson,
  githubUrl,
  readLocalJson,
  validateWorkspace,
  workspaceConfig,
  type WorkspaceConfig,
} from "./workspace-config.js";

export const WORKSPACE_SYNC_INTERVAL = 60_000;
const stateSchema = z.strictObject({
  status: z.enum([
    "disabled",
    "waiting",
    "running",
    "ok",
    "paused",
    "blocked",
    "error",
    "pending_restart",
  ]),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  error: z.string().nullable(),
  fingerprint: z.string(),
});
type SyncState = z.infer<typeof stateSchema>;
const stateFile = (dir: string) => path.join(dir, "workspace-sync-state.json");
const requestFile = (dir: string) => path.join(dir, "workspace-sync-now.json");
const fingerprint = (c: WorkspaceConfig) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        c.workspaceDir,
        c.githubUrl,
        c.enabled,
        c.activeWorkspace,
        WORKSPACE_SYNC_INTERVAL,
      ]),
    )
    .digest("hex");
function emptyState(c: WorkspaceConfig): SyncState {
  return {
    status: c.enabled ? "waiting" : "disabled",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    error: null,
    fingerprint: fingerprint(c),
  };
}
function readState(dir: string, c: WorkspaceConfig): SyncState {
  if (!fs.existsSync(stateFile(dir))) return emptyState(c);
  const state = stateSchema.parse(readLocalJson(stateFile(dir)));
  return state.fingerprint === fingerprint(c) ? state : emptyState(c);
}
export function workspaceSyncStatus(dir: string) {
  const c = workspaceConfig(dir);
  return {
    config: { workspaceDir: c.workspaceDir, githubUrl: c.githubUrl, enabled: c.enabled },
    state: readState(dir, c),
    activeWorkspace: c.activeWorkspace,
    pendingRestart: c.activeWorkspace !== c.workspaceDir,
  };
}

class GitCommandError extends Error {
  constructor(
    operation: string,
    readonly transient: boolean,
  ) {
    super(
      `Git ${operation} failed${transient ? " (temporary network failure; retry in one minute)" : "; inspect the repository locally"}.`,
    );
  }
}
/** No shell. Errors deliberately omit raw Git output, URLs and credentials. */
export async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw Error("Git operation cancelled");
  // The native Job Object owns Git and descendants from creation, without PID races.
  // Its lifetime includes main-process exit and daemon death.
  const supervisor = new ProcessTreeSupervisor(path.join(os.tmpdir(), "mind-wake-git-runtime"));
  const child = supervisor.spawn("workspace-git" as ProfileId, randomUUID() as SessionId, {
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/workspace-git-command.mjs", import.meta.url)),
      JSON.stringify(["-c", "credential.interactive=false", "-c", "core.askPass=", ...args]),
    ],
    cwd,
    env: {
      ...Object.fromEntries(
        [
          "PATH",
          "Path",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "PROGRAMFILES",
          "SSH_AUTH_SOCK",
        ].flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
      GIT_SSH_VARIANT: "ssh",
      MIND_WAKE_AUTO_PUSH_RUNNING: "1",
    },
  });
  const cancellation = new AbortController();
  const stop = () => {
    cancellation.abort();
    void child.terminateTree();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 30_000);
  try {
    await child.started();
    const line = await child.readLine();
    const exit = await child.exited;
    if (cancellation.signal.aborted) throw new GitCommandError(args[0] ?? "operation", true);
    if (exit.mainExitCode !== 0 || line === null)
      throw new GitCommandError(args[0] ?? "operation", false);
    const result = JSON.parse(line) as { failed: boolean; stdout: string; stderr: string };
    if (result.failed)
      throw new GitCommandError(
        args[0] ?? "operation",
        /could not resolve host|could not resolve hostname|failed to connect|connection timed out|connection reset|network is unreachable|unable to access.*(timeout|couldn.t connect)/i.test(
          result.stderr,
        ),
      );
    return result.stdout.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (!child.hasExited) await child.terminateTree();
  }
}

async function repository(c: WorkspaceConfig, signal?: AbortSignal) {
  const root = await git(c.workspaceDir, ["rev-parse", "--show-toplevel"], signal);
  if (fs.realpathSync(root) !== fs.realpathSync(c.workspaceDir))
    throw Error("Choose the Git repository root as the workspace");
  const remote = await git(root, ["config", "--get-all", "remote.origin.url"], signal);
  if (githubUrl(remote) !== githubUrl(c.githubUrl))
    throw Error("origin does not match the configured GitHub URL");
  const branch = await git(root, ["symbolic-ref", "--short", "HEAD"], signal);
  const upstream = await git(root, ["config", "--get", `branch.${branch}.remote`], signal);
  const merge = await git(root, ["config", "--get", `branch.${branch}.merge`], signal);
  if (upstream !== "origin" || !merge.startsWith("refs/heads/"))
    throw Error("An explicit origin upstream branch is required");
  await git(root, ["check-ref-format", merge], signal);
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"], signal);
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ]) {
    if (fs.existsSync(path.join(gitDir, marker)))
      throw Error("A Git operation is unfinished; resolve it locally first");
  }
  const conflicts = await git(root, ["ls-files", "-u"], signal);
  if (conflicts) throw Error("Unresolved Git conflicts; resolve them locally first");
  return { root, branch, merge, gitDir };
}
export async function configureWorkspaceSync(
  dir: string,
  input: { workspaceDir: string; githubUrl: string; enabled: boolean },
) {
  const previous = workspaceConfig(dir),
    root = validateWorkspace(dir, input.workspaceDir);
  const c: WorkspaceConfig = {
    workspaceDir: root,
    githubUrl: input.githubUrl.trim() ? githubUrl(input.githubUrl) : "",
    enabled: input.enabled,
    activeWorkspace: previous.activeWorkspace,
  };
  if (c.enabled) {
    if (!c.githubUrl) throw Error("A GitHub repository URL is required");
    await repository(c);
  }
  atomicLocalJson(path.join(dir, "workspace-settings.json"), c);
  return workspaceSyncStatus(dir);
}
/** A manual request is consumed only by the daemon, never by a UI subprocess. */
export function requestWorkspaceSync(dir: string) {
  const c = workspaceConfig(dir);
  if (!c.enabled) throw Error("Enable workspace synchronisation first");
  if (c.activeWorkspace !== c.workspaceDir)
    throw Error("Restart the engine to adopt the selected workspace first");
  atomicLocalJson(requestFile(dir), { requestedAt: new Date().toISOString() });
  return workspaceSyncStatus(dir);
}

export class WorkspaceGitSync {
  #flight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  constructor(
    readonly dir: string,
    private readonly allowed: () => boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}
  #isAllowed(): boolean {
    try {
      return this.allowed();
    } catch {
      return false;
    }
  }
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    this.#flight = this.#cycle().finally(() => {
      this.#flight = null;
    });
    return this.#flight;
  }
  async close(): Promise<void> {
    this.#controller?.abort();
    await this.#flight;
  }
  async #cycle(): Promise<void> {
    const c = workspaceConfig(this.dir),
      state = readState(this.dir, c),
      stamp = () => new Date(this.now()).toISOString();
    let saved = fs.existsSync(stateFile(this.dir))
      ? JSON.stringify(readLocalJson(stateFile(this.dir)))
      : "";
    const save = () => {
      const next = JSON.stringify(state);
      if (next !== saved) {
        atomicLocalJson(stateFile(this.dir), state);
        saved = next;
      }
    };
    if (!c.enabled) {
      state.status = "disabled";
      state.nextRunAt = null;
      save();
      return;
    }
    if (c.activeWorkspace !== c.workspaceDir) {
      state.status = "pending_restart";
      state.nextRunAt = null;
      save();
      return;
    }
    if (!this.#isAllowed()) {
      state.status = "paused";
      state.nextRunAt = null;
      save();
      return;
    }
    const requested = fs.existsSync(requestFile(this.dir));
    if (state.status === "blocked" && !requested) return;
    if (!requested && state.nextRunAt === null) {
      state.status = "waiting";
      state.nextRunAt = new Date(this.now() + WORKSPACE_SYNC_INTERVAL).toISOString();
      save();
      return;
    }
    if (!requested && state.nextRunAt !== null && Date.parse(state.nextRunAt) > this.now()) return;
    if (requested) fs.unlinkSync(requestFile(this.dir));
    const controller = new AbortController();
    this.#controller = controller;
    const guard = () => {
      let unchanged = false;
      try {
        unchanged = fingerprint(workspaceConfig(this.dir)) === fingerprint(c);
      } catch {
        /* Stop on unreadable controls. */
      }
      if (!this.#isAllowed() || !unchanged) {
        controller.abort();
        throw Error("Synchronisation stopped by Pause, Stop or changed settings");
      }
    };
    const run = async (args: readonly string[]) => {
      guard();
      const result = await git(c.workspaceDir, args, controller.signal);
      guard();
      return result;
    };
    let release: (() => void) | null = null;
    const monitor = setInterval(() => {
      try {
        guard();
      } catch {
        /* Abort cancels the active command. */
      }
    }, 200);
    const timeout = setTimeout(() => {
      controller.abort();
    }, 90_000);
    try {
      guard();
      const repo = await repository(c, controller.signal);
      guard();
      const lockFile = path.join(repo.gitDir, "mind-wake-workspace-sync.lock");
      if (fs.existsSync(lockFile)) {
        const owner = z.strictObject({ pid: z.int().positive() }).parse(readLocalJson(lockFile));
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (alive) return;
        // Never race another daemon by unlinking a lock it may just have replaced.
        throw Error("Stale workspace sync lock; inspect and remove it locally before Sync now");
      }
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
      }
      release = () => {
        fs.unlinkSync(lockFile);
      };
      state.status = "running";
      state.lastAttemptAt = stamp();
      state.error = null;
      save();
      // Fetch first: never commit dirty work into a history that already diverges.
      await run(["fetch", "--no-tags", "origin", repo.merge]);
      const counts = (await run(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"]))
        .split(/\s+/)
        .map(Number);
      const ahead = counts[0],
        behind = counts[1];
      if (
        ahead === undefined ||
        behind === undefined ||
        !Number.isFinite(ahead) ||
        !Number.isFinite(behind)
      )
        throw Error("Cannot compare local and remote history");
      const dirty = Boolean(await run(["status", "--porcelain"]));
      if (ahead > 0 && behind > 0)
        throw Error("Local and remote branches diverged; resolve locally, then Sync now");
      if (behind > 0 && dirty)
        throw Error(
          "Remote advanced while workspace has local changes; resolve locally, then Sync now",
        );
      if (behind > 0) await run(["pull", "--ff-only", "--no-rebase", "origin", repo.merge]);
      if (dirty) {
        await run(["add", "--all"]);
        // git diff exits 1 for changes; a nonempty name list avoids treating that as failure.
        if (await run(["diff", "--cached", "--name-only"]))
          await run(["commit", "-m", "Wake workspace: automatic synchronisation"]);
      }
      // Push the explicit upstream branch without force; a concurrent remote change is a block.
      // Use the reviewed URL explicitly: remote.origin.pushurl cannot redirect it.
      if ((await repository(c, controller.signal)).branch !== repo.branch)
        throw Error("Local branch changed during synchronisation");
      await run([
        "-c",
        "remote.origin.mirror=false",
        "push",
        "--no-follow-tags",
        "--no-mirror",
        "--recurse-submodules=no",
        c.githubUrl,
        `HEAD:${repo.merge}`,
      ]);
      state.status = "ok";
      state.lastSuccessAt = stamp();
      state.nextRunAt = new Date(this.now() + WORKSPACE_SYNC_INTERVAL).toISOString();
      state.error = null;
      save();
    } catch (e) {
      state.status = !this.#isAllowed()
        ? "paused"
        : e instanceof GitCommandError && e.transient
          ? "error"
          : "blocked";
      state.nextRunAt =
        state.status === "error"
          ? new Date(this.now() + WORKSPACE_SYNC_INTERVAL).toISOString()
          : null;
      state.error = e instanceof Error ? e.message : "Workspace Git sync failed";
      save();
    } finally {
      clearInterval(monitor);
      clearTimeout(timeout);
      release?.();
      this.#controller = null;
    }
  }
}
