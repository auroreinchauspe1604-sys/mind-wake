/** Authenticated local control of children held by their actual launcher. No PID adoption. */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const unknown = () => ({
  state: "unknown",
  loadedRevision: null,
  artifactSha256: null,
  instance: null,
});
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function ownedDirectory(manifestFile) {
  return path.join(path.dirname(manifestFile), "owned-runtimes");
}
export function ownerKey(manifestFile) {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(manifestFile), "keys.json"), "utf8"))
    .owner;
}
export async function assertOwnedRestartAllowed(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const { stdout } = await promisify(execFile)(
    m.node ?? process.execPath,
    [path.join(m.repoDir, "dist/cli/main.js"), "status", "--data-dir", m.dataDir, "--json"],
    { cwd: m.repoDir, windowsHide: true, timeout: 5000, maxBuffer: 1048576 },
  );
  const report = JSON.parse(stdout);
  if (!report.ok) throw Error("Local status unavailable");
  const state = {
    wake: report.data.profile?.state,
    forceOff: fs.existsSync(path.join(m.dataDir, "emergency-stop.flag"))
      ? true
      : report.data.profile?.emergencyStopLocked,
  };
  if (state.forceOff !== false || !["ready", "running", "hibernating"].includes(state.wake))
    throw Error("Local stop prevents restart");
}

export class OwnedRuntime {
  constructor(
    manifestFile,
    role,
    launch,
    { guard = () => assertOwnedRestartAllowed(manifestFile), readyTimeout = 30000 } = {},
  ) {
    if (!["daemon", "mcp"].includes(role)) throw Error("Invalid owned role");
    this.manifestFile = manifestFile;
    this.role = role;
    this.launch = launch;
    this.guard = guard;
    this.readyTimeout = readyTimeout;
    this.ownerId = randomUUID();
    this.current = null;
    this.closed = false;
    this.busy = false;
    this.replacing = false;
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  async start() {
    if (this.closed) throw Error("Owner stopped");
    const dir = ownedDirectory(this.manifestFile);
    fs.mkdirSync(dir, { recursive: true });
    if (!this.server) {
      const name = createHash("sha256")
        .update(path.resolve(this.manifestFile))
        .digest("hex")
        .slice(0, 20);
      this.pipe =
        process.platform === "win32"
          ? `\\\\.\\pipe\\mindwake-owned-${name}-${this.role === "daemon" ? "engine" : this.ownerId}`
          : path.join(dir, `${this.role === "daemon" ? "engine" : this.ownerId}.sock`);
      this.server = net.createServer((socket) => {
        let input = "";
        socket.setTimeout(35000, () => socket.destroy());
        socket.on("error", () => {});
        socket.on("data", (data) => {
          input += data;
          if (input.length > 8192) {
            socket.destroy();
            return;
          }
          if (!input.includes("\n")) return;
          socket.removeAllListeners("data");
          const abort = new AbortController();
          socket.once("close", () => abort.abort());
          void (async () => {
            try {
              const r = JSON.parse(input.trim());
              if (
                !same(r.key, ownerKey(this.manifestFile)) ||
                !["observe", "restart"].includes(r.op)
              )
                throw Error("Denied");
              if (r.op === "restart") await this.restart(abort.signal);
              socket.end(JSON.stringify({ ok: true, component: await this.observe() }) + "\n");
            } catch {
              socket.end(JSON.stringify({ ok: false, code: "owner_operation_refused" }) + "\n");
            }
          })();
        });
      });
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.pipe, resolve);
      });
      this.record = path.join(dir, `${this.role}-${this.ownerId}.json`);
      fs.writeFileSync(
        this.record,
        JSON.stringify({ role: this.role, pipe: this.pipe, ownerId: this.ownerId }),
        { flag: "wx", mode: 0o600 },
      );
    }
    const instance = randomUUID(),
      file = path.join(dir, `ready-${instance}.json`);
    const launched = await this.launch({ file, instance });
    const c = { ...launched, instance, file, evidence: null, entrySha: sha(launched.entry) };
    this.current = c;
    c.child.once("exit", () => {
      c.exited = true;
      if (!this.replacing) {
        this.closed = true;
        this.finish();
      }
    });
    if (c.child.exitCode != null || c.child.signalCode != null) {
      c.exited = true;
      if (!this.replacing) {
        this.closed = true;
        this.finish();
      }
    }
    const deadline = Date.now() + this.readyTimeout;
    while (!c.exited && !this.closed && Date.now() < deadline) {
      try {
        const s = fs.lstatSync(file);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 4096)
          throw Error("Invalid startup receipt");
        const r = JSON.parse(fs.readFileSync(file, "utf8"));
        if (
          r.pid !== c.child.pid ||
          r.instance !== instance ||
          r.role !== this.role ||
          path.resolve(r.entry) !== path.resolve(c.entry) ||
          r.artifactSha256 !== c.entrySha ||
          sha(c.entry) !== c.entrySha
        )
          throw Error("Startup identity mismatch");
        c.evidence = {
          state: "running",
          instance,
          artifactSha256: c.entrySha,
          loadedRevision: /^[a-f0-9]{40,64}$/.test(r.loadedRevision ?? "")
            ? r.loadedRevision
            : null,
        };
        fs.unlinkSync(file);
        return;
      } catch (e) {
        if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
      }
      await pause(50);
    }
    if (c.exited) throw Error("Runtime exited before startup");
  }
  async observe() {
    return this.current && !this.current.exited
      ? (this.current.evidence ?? { ...unknown(), state: "running" })
      : { ...unknown(), state: "stopped" };
  }
  async stopChild() {
    const c = this.current;
    if (!c || c.exited) return;
    const exited = once(c.child, "exit");
    if (this.role === "daemon" && c.child.connected) c.child.send({ type: "wake_owned_stop" });
    else if (!c.child.kill()) throw Error("Owned child stop failed");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            c.child.kill();
            reject(Error("Owned stop timeout"));
          }, 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async restart(signal) {
    if (this.busy || this.closed || !this.current) throw Error("Owned restart unavailable");
    this.busy = true;
    this.replacing = true;
    try {
      signal.throwIfAborted();
      await this.guard();
      await this.beforeRestart?.();
      await this.stopChild();
      signal.throwIfAborted();
      await this.guard();
      await this.start();
      signal.throwIfAborted();
      if (!this.current.evidence) throw Error("New runtime has no startup receipt");
      await this.afterRestart?.();
    } finally {
      this.busy = false;
      this.replacing = false;
    }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOwned();
    return this.closePromise;
  }
  async closeOwned() {
    this.closed = true;
    await this.stopChild();
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
    if (this.record && fs.existsSync(this.record)) fs.unlinkSync(this.record);
    this.finish();
  }
}

async function callOwner(record, key, op, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.connect(record.pipe);
    let text = "";
    const abort = () => socket.destroy(Error("Cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    socket.setTimeout(op === "observe" ? 1000 : 35000, () =>
      socket.destroy(Error("Owner timeout")),
    );
    socket.once("connect", () => socket.write(JSON.stringify({ key, op }) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > 8192) socket.destroy(Error("Oversized owner response"));
    });
    socket.once("error", (e) => {
      cleanup();
      reject(e);
    });
    socket.once("end", () => {
      cleanup();
      try {
        const r = JSON.parse(text);
        if (!r.ok) throw Error("Owner refused operation");
        resolve(r.component);
      } catch (e) {
        reject(e);
      }
    });
  });
}
export async function ownedComponents(manifestFile, role, op = "observe", signal) {
  const dir = ownedDirectory(manifestFile),
    members = [];
  if (!fs.existsSync(dir)) return { component: unknown(), members: [] };
  const key = ownerKey(manifestFile);
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(role + "-") && n.endsWith(".json"))) {
    const file = path.join(dir, name),
      s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 4096) continue;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      record.role !== role ||
      typeof record.pipe !== "string" ||
      (process.platform === "win32"
        ? !record.pipe.startsWith("\\\\.\\pipe\\mindwake-owned-")
        : path.dirname(record.pipe) !== dir)
    )
      continue;
    try {
      if (op === "restart") {
        try {
          await callOwner(record, key, "observe", signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          continue;
        }
      }
      members.push({ owner: record.ownerId, component: await callOwner(record, key, op, signal) });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (op === "restart") throw Error("Owned runtime could not restart", { cause: e });
    }
  }
  if (!members.length) return { component: unknown(), members };
  const values = members.map((m) => m.component);
  if (values.some((c) => c.state !== "running")) return { component: unknown(), members };
  if (members.length === 1) return { component: values[0], members };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(members.sort((a, b) => a.owner.localeCompare(b.owner))))
    .digest("hex");
  const instance = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-8${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
  return {
    members,
    component: {
      state: "running",
      instance,
      artifactSha256: fingerprint,
      loadedRevision: values.every((v) => v.loadedRevision === values[0].loadedRevision)
        ? values[0].loadedRevision
        : null,
    },
  };
}
