/** Local configuration only. No peer-supplied executable, path, URL or arguments. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { git } from "../../src/daemon/workspace-git-sync.js";
import { StopFlag } from "../../src/runner/controls.js";
import { wakeReader } from "../mcp/wake.js";
import {
  observationSchema,
  type Observation,
  type MaintenanceAction,
  type MaintenanceRequest,
} from "../../src/communication/maintenance-protocol.js";
import { MaintenanceAdapterError, type MaintenanceAdapter } from "./controller.js";
const exec = promisify(execFile);
const unknownComponent = () => ({
  state: "unknown" as const,
  loadedRevision: null,
  artifactSha256: null,
  instance: null,
});
export interface OwnedLifecycle {
  actions: MaintenanceAction[];
  observe(): Promise<Observation["components"]>;
  /** Existing supervisor handoff only. Must honor abort and local stop; no detached watcher. */
  handoff(action: MaintenanceAction, signal: AbortSignal): Promise<void>;
}
export interface LocalAdapterOptions {
  dataDir: string;
  repoDir: string;
  manifestFile?: string;
  source?: { httpsOrigin: string; branch: string };
  lifecycle?: OwnedLifecycle;
  /** Reuse app-update.checkUpdate with a cancellable, supervised runner. */
  update?: (expectedRevision: string, signal: AbortSignal) => Promise<void>;
}
export class LocalMaintenanceAdapter implements MaintenanceAdapter {
  constructor(readonly options: LocalAdapterOptions) {
    const source = options.source;
    if (source) {
      const url = new URL(source.httpsOrigin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source.branch) ||
        source.branch.includes("..")
      )
        throw Error("Invalid local source catalog");
    }
  }
  capabilities(): MaintenanceAction[] {
    return [
      "diagnose",
      ...(this.options.source ? ["pull_source" as const] : []),
      ...(this.options.lifecycle?.actions ?? []).filter((a) => a.startsWith("relaunch_")),
      ...(this.options.update && this.options.lifecycle?.actions.includes("relaunch_app")
        ? ["reinstall" as const]
        : []),
    ];
  }
  controlState(): Pick<Observation, "wake" | "forceOff"> {
    const status = wakeReader({ MIND_WAKE_DATA_DIR: this.options.dataDir }).status() as {
      profile: { state: Observation["wake"]; emergencyStopLocked: boolean } | null;
    };
    return {
      wake: status.profile?.state ?? "unknown",
      forceOff: new StopFlag(this.options.dataDir).exists()
        ? true
        : (status.profile?.emergencyStopLocked ?? null),
    };
  }
  async observe(): Promise<Observation> {
    let sourceRevision = null,
      installedRevision = null;
    try {
      const value = await exec("git", ["rev-parse", "HEAD"], {
        cwd: this.options.repoDir,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024,
      });
      if (/^[a-f0-9]{40,64}$/.test(value.stdout.trim())) sourceRevision = value.stdout.trim();
    } catch {
      /* No source evidence. */
    }
    try {
      const m = JSON.parse(readFileSync(this.options.manifestFile ?? "", "utf8")) as {
        revision?: string;
      };
      if (m.revision && /^[a-f0-9]{40,64}$/.test(m.revision)) installedRevision = m.revision;
    } catch {
      /* Installed version is not loaded version. */
    }
    const status = wakeReader({ MIND_WAKE_DATA_DIR: this.options.dataDir }).status() as {
      profile: { state: Observation["wake"]; emergencyStopLocked: boolean } | null;
      openSessions: number;
      daemon: { state: string };
    };
    return observationSchema.parse({
      at: new Date().toISOString(),
      wake: status.profile?.state ?? "unknown",
      forceOff: new StopFlag(this.options.dataDir).exists()
        ? true
        : (status.profile?.emergencyStopLocked ?? null),
      openSessions: status.openSessions,
      components: this.options.lifecycle
        ? await this.options.lifecycle.observe()
        : {
            app: unknownComponent(),
            daemon: {
              ...unknownComponent(),
              state:
                status.daemon.state === "running"
                  ? "running"
                  : ["stopped", "crashed", "never"].includes(status.daemon.state)
                    ? "stopped"
                    : "unknown",
            },
            mcp: unknownComponent(),
          },
      sourceRevision,
      installedRevision,
    });
  }
  async execute(
    r: MaintenanceRequest,
    expected: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (r.action === "pull_source") {
      const s = this.options.source;
      if (!s || !expected) throw Error("Unsupported");
      const run = (args: string[]) => git(this.options.repoDir, args, signal);
      if (
        realpathSync((await run(["rev-parse", "--show-toplevel"])).trim()) !==
        realpathSync(this.options.repoDir)
      )
        throw new MaintenanceAdapterError("source_mismatch", "Choose source repository root");
      if ((await run(["symbolic-ref", "--short", "HEAD"])).trim() !== s.branch)
        throw new MaintenanceAdapterError("source_mismatch", "Source branch mismatch");
      if ((await run(["config", "--get-all", "remote.origin.url"])).trim() !== s.httpsOrigin)
        throw new MaintenanceAdapterError("source_mismatch", "Origin mismatch");
      if ((await run(["status", "--porcelain"])).trim())
        throw new MaintenanceAdapterError("source_dirty", "Local changes preserved");
      await run(["fetch", "--no-tags", "origin", `refs/heads/${s.branch}`]);
      if ((await run(["rev-parse", "FETCH_HEAD"])).trim() !== expected)
        throw new MaintenanceAdapterError("revision_mismatch", "Unapproved revision");
      if ((await run(["status", "--porcelain"])).trim())
        throw new MaintenanceAdapterError("source_dirty", "Local changes preserved");
      try {
        await run(["merge-base", "--is-ancestor", "HEAD", expected]);
      } catch {
        throw new MaintenanceAdapterError(
          "source_diverged",
          "Source diverged; local commits preserved",
        );
      }
      // No reset, clean, force, checkout or stash. Divergence fails without touching local commits.
      await run(["merge", "--ff-only", "--no-edit", expected]);
      return;
    }
    if (r.action === "reinstall") {
      if (
        !expected ||
        !this.options.update ||
        !this.options.lifecycle?.actions.includes("relaunch_app")
      )
        throw Error("Unsupported");
      // Updater fetches first, validates approved revision, builds immutable release, switches manifest.
      await this.options.update(expected, signal);
      signal.throwIfAborted();
      await this.options.lifecycle.handoff("relaunch_app", signal);
      return;
    }
    if (!this.options.lifecycle?.actions.includes(r.action)) throw Error("Unowned lifecycle");
    await this.options.lifecycle.handoff(r.action, signal);
  }
}
