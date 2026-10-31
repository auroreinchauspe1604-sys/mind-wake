/** Opt-in control embedded in the existing desktop supervisor. No model or agent restart. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { checkUpdate } from "./app-update.mjs";
import { privateFile, privateTarget } from "../services/shared-workspace/private-files.mjs";
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const unknown = () => ({
  state: "unknown",
  loadedRevision: null,
  artifactSha256: null,
  instance: null,
});

export function readDesktopMaintenance(manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const c = manifest.maintenance;
  if (!c || Object.keys(c).some((k) => !["policyFile", "bindingFile", "storeFile"].includes(k)))
    throw Error("Invalid maintenance configuration");
  for (const k of ["policyFile", "bindingFile", "storeFile"])
    if (typeof c[k] !== "string" || !path.isAbsolute(c[k]))
      throw Error("Absolute maintenance paths required");
  privateFile(c.policyFile);
  const binding = JSON.parse(fs.readFileSync(privateFile(c.bindingFile), "utf8"));
  if (typeof binding.endpoint !== "string" || typeof binding.key !== "string" || !binding.key)
    throw Error("Local hub binding required");
  // The controller store must remain outside Git; choose it in protected local runtime data.
  privateTarget(c.storeFile);
  if (fs.existsSync(c.storeFile)) privateFile(c.storeFile);
  return { manifest, config: c, binding };
}

/** Owns only children returned by launch, never a discovered PID or external daemon/MCP. */
export class OwnedDesktop {
  constructor(manifestFile, launch, { receiptTimeout = 15000 } = {}) {
    this.manifestFile = manifestFile;
    this.launch = launch;
    this.receiptTimeout = receiptTimeout;
    this.current = null;
    this.closed = false;
    this.replacing = false;
    this.failures = 0;
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  async start() {
    if (this.closed) throw Error("Supervisor stopped");
    const m = JSON.parse(fs.readFileSync(this.manifestFile, "utf8"));
    const dir = path.join(path.dirname(this.manifestFile), "startup-receipts");
    fs.mkdirSync(dir, { recursive: true });
    const instance = randomUUID(),
      file = path.join(dir, `${instance}.json`);
    const before = digest(m.desktopExe);
    const child = await this.launch(this.manifestFile, "desktop", {
      restart: false,
      supervised: true,
      startupReceipt: { file, instance },
    });
    const current = {
      child,
      instance,
      file,
      exe: m.desktopExe,
      sha: before,
      evidence: null,
      started: Date.now(),
    };
    this.current = current;
    child.once("exit", (code, signal) => {
      current.exited = true;
      if (this.current !== current || this.replacing || this.closed) return;
      if (code === 0 && !signal) {
        this.closed = true;
        this.finish();
        return;
      }
      const delay =
        code === 75 && !signal ? 0 : Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
      this.recovery = setTimeout(() => {
        this.start().catch(() => {
          this.closed = true;
          this.finish();
        });
      }, delay);
    });
    // Observe an actual receipt from this process, not source HEAD or a mutable manifest.
    const deadline = Date.now() + this.receiptTimeout;
    while (!current.exited && !this.closed && Date.now() < deadline) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
          throw Error("Invalid receipt");
        const r = JSON.parse(fs.readFileSync(file, "utf8"));
        if (
          r.pid !== child.pid ||
          r.instance !== instance ||
          path.resolve(r.executable) !== path.resolve(m.desktopExe) ||
          digest(m.desktopExe) !== before
        )
          throw Error("Startup identity mismatch");
        current.evidence = {
          state: "running",
          instance,
          artifactSha256: before,
          loadedRevision:
            r.dirty === "false" && /^[a-f0-9]{40,64}$/.test(r.revision) ? r.revision : null,
        };
        fs.unlinkSync(file);
        if (Date.now() - current.started > 60000) this.failures = 0;
        return;
      } catch (e) {
        if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
      }
      await pause(100);
    }
    // Older builds can still run; lack of a receipt stays unknown and cannot verify a restart.
  }
  async observe() {
    const c = this.current;
    const app =
      c && !c.exited
        ? (c.evidence ?? { ...unknown(), state: "running" })
        : { ...unknown(), state: "stopped" };
    return { app, daemon: unknown(), mcp: unknown() };
  }
  async handoff(action, signal) {
    if (action !== "relaunch_app" || !this.current || this.current.exited || this.closed)
      throw Error("Unowned lifecycle");
    signal.throwIfAborted();
    this.guard?.();
    this.replacing = true;
    try {
      await this.stopChild();
      signal.throwIfAborted();
      this.guard?.();
      await this.start();
      signal.throwIfAborted();
      if (!this.current?.evidence) throw Error("Startup receipt missing");
    } finally {
      this.replacing = false;
    }
  }
  async stopChild() {
    const c = this.current;
    if (!c || c.exited) return;
    const exit = once(c.child, "exit");
    if (!c.child.kill()) throw Error("Owned app stop failed");
    let timer;
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Owned app stop timeout")), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.recovery);
    await this.stopChild();
    this.finish();
  }
}

export async function superviseDesktopMaintenance(manifestFile, launch) {
  const { manifest: m, config, binding } = readDesktopMaintenance(manifestFile);
  const [
    { MaintenanceController, readMaintenancePolicy },
    { LocalMaintenanceAdapter },
    { pumpMaintenance },
    { RemoteHubLink },
    { ProcessTreeSupervisor },
  ] = await Promise.all([
    import("../services/maintenance/controller.ts"),
    import("../services/maintenance/local-adapter.ts"),
    import("../services/maintenance/pump.ts"),
    import("../services/mcp/shared-https.ts"),
    import("../src/runner/process-tree.ts"),
  ]);
  const link = new RemoteHubLink(binding.endpoint, binding.key);
  const policy = readMaintenancePolicy(config.policyFile);
  if (policy.sharedEndpoint !== link.endpoint) throw Error("Maintenance endpoint mismatch");
  const owner = new OwnedDesktop(manifestFile, launch);
  const tree = new ProcessTreeSupervisor(path.join(m.dataDir, "maintenance-runtime"));
  const active = new Set();
  const adapter = new LocalMaintenanceAdapter({
    dataDir: m.dataDir,
    repoDir: m.repoDir,
    manifestFile,
    lifecycle: {
      actions: ["relaunch_app"],
      observe: () => owner.observe(),
      handoff: (a, s) => owner.handoff(a, s),
    },
    update: async (expectedRevision, signal) => {
      const latest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      // Update source is operator-selected HTTPS, never a request parameter.
      const url = new URL(latest.updateSource);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw Error("Explicit HTTPS update source required");
      const result = await checkUpdate(manifestFile, {
        expectedRevision,
        beforeStep: () => {
          signal.throwIfAborted();
          owner.guard();
          const approved = readMaintenancePolicy(config.policyFile);
          if (!Object.values(approved.releases).some((r) => r.revision === expectedRevision))
            throw Error("Release approval withdrawn");
        },
        run: async (exe, args, cwd, log) => {
          signal.throwIfAborted();
          const env = Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) => !/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE/i.test(k),
            ),
          );
          env.GIT_TERMINAL_PROMPT = "0";
          const p = tree.spawn("maintenance", randomUUID(), { executable: exe, args, cwd, env });
          active.add(p);
          const stop = () => {
            void p.terminateTree();
          };
          signal.addEventListener("abort", stop, { once: true });
          try {
            await p.started();
            let output = "",
              line;
            while ((line = await p.readLine()) !== null) {
              fs.writeSync(log, line + "\n");
              output = (output + line + "\n").slice(-8192);
            }
            const exit = await p.exited;
            signal.throwIfAborted();
            if (exit.mainExitCode !== 0) throw Error("Maintenance build failed");
            return output;
          } finally {
            signal.removeEventListener("abort", stop);
            active.delete(p);
            if (!p.hasExited) await p.terminateTree();
          }
        },
      });
      if (!["installed", "current"].includes(result.state) || result.revision !== expectedRevision)
        throw Error("Update not installed");
    },
  });
  const control = adapter.controlState.bind(adapter);
  owner.guard = () => {
    const state = control();
    if (
      owner.closed ||
      state.forceOff !== false ||
      !["ready", "running", "hibernating"].includes(state.wake)
    )
      throw Error("Maintenance stopped locally");
    const local = readMaintenancePolicy(config.policyFile);
    const activeRequest = controller.db
      .prepare(
        "SELECT actor,request,result FROM operations WHERE state IN ('accepted','running','restart_pending') LIMIT 1",
      )
      .get();
    if (activeRequest) {
      const request = JSON.parse(activeRequest.request);
      if (
        local.target !== policy.target ||
        local.sharedEndpoint !== policy.sharedEndpoint ||
        !local.grants.some(
          (g) => g.actor === activeRequest.actor && g.actions.includes(request.action),
        ) ||
        (request.release &&
          local.releases[request.release]?.revision !==
            JSON.parse(activeRequest.result).expectedRevision)
      )
        throw Error("Maintenance authority withdrawn");
    }
  };
  if (m.development !== false || typeof m.updateSource !== "string") delete adapter.options.update;
  adapter.controlState = () =>
    owner.closed || (owner.current?.exited && !owner.replacing)
      ? { wake: "stopped", forceOff: true }
      : control();
  const controller = new MaintenanceController(
    config.storeFile,
    () => readMaintenancePolicy(config.policyFile),
    adapter,
  );
  let polling;
  const tick = async () => {
    while (!owner.closed) {
      try {
        const identity = await link.call({ op: "whoami" });
        if (identity.ref !== readMaintenancePolicy(config.policyFile).target)
          throw Error("Maintenance target mismatch");
        await pumpMaintenance(link, controller);
      } catch {
        /* Offline control must not prevent the local desktop from running. */
      }
      if (!owner.closed) await pause(1000);
    }
  };
  const stop = () => {
    void owner.close();
    for (const p of active) void p.terminateTree();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await owner.start();
    polling = tick();
    await owner.finished;
    await polling;
  } finally {
    await owner.close();
    for (const p of active) await p.terminateTree();
    await polling;
    controller.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
