/** Keep the provider's stdio connection while replacing only our initialized MIND worker. */
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { OwnedRuntime } from "./owned-runtime.mjs";
export async function runOwnedMcp(manifestFile, load) {
  let worker,
    initialize,
    initialized = false,
    replaying = null,
    replayResolve,
    replayReject;
  const pending = new Map(),
    queued = [];
  const retired = new WeakSet();
  const send = (line) => {
    if (worker && !worker.stdin.destroyed) worker.stdin.write(line + "\n");
    else throw Error("MCP worker unavailable");
  };
  const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const owner = new OwnedRuntime(manifestFile, "mcp", async ({ file, instance }) => {
    const loaded = await load();
    const { m, env, nodeArgs } = loaded,
      entry = loaded.entry ?? path.join(m.repoDir, "services/mcp/server-main.ts");
    worker = spawn(m.node, [...nodeArgs, path.join(m.repoDir, "scripts/mcp-child.mjs"), entry], {
      cwd: m.repoDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...env,
        MIND_WAKE_OWNED_RECEIPT: file,
        MIND_WAKE_OWNED_INSTANCE: instance,
        MIND_WAKE_OWNED_ENTRY: entry,
      },
    });
    const lines = createInterface({ input: worker.stdout });
    const child = worker;
    lines.on("line", (line) => {
      if (retired.has(child)) return;
      try {
        const value = JSON.parse(line);
        if (replaying && value.id === replaying) {
          if (value.error) {
            replayReject?.(Error("MCP reinitialization refused"));
            return;
          }
          replaying = null;
          if (initialized)
            send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
          for (const message of queued.splice(0)) send(message);
          replayResolve?.();
          return;
        }
        if (value.id !== undefined) pending.delete(JSON.stringify(value.id));
        process.stdout.write(line + "\n");
      } catch {
        /* Do not mix non-JSON output into the provider transport. */
      }
    });
    return { child: worker, entry };
  });
  owner.beforeRestart = () => {
    if (!initialize || !initialized) throw Error("MCP client has not initialized");
    retired.add(worker);
    replaying = `wake-reinitialize-${randomUUID()}`;
    for (const request of pending.values())
      output({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "MIND MCP restarted; retry the request" },
      });
    pending.clear();
    queued.length = 0;
  };
  owner.afterRestart = async () => {
    let timer;
    try {
      await new Promise((resolve, reject) => {
        replayResolve = resolve;
        replayReject = reject;
        timer = setTimeout(() => reject(Error("MCP initialization timeout")), 10000);
        send(JSON.stringify({ ...initialize, id: replaying }));
      });
      output({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    } finally {
      clearTimeout(timer);
      replayResolve = null;
      replayReject = null;
    }
  };
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let value;
    try {
      if (line.length > 1048576) throw Error("MCP message too large");
      value = JSON.parse(line);
      if (owner.current?.exited && !owner.replacing) throw Error("MCP worker stopped");
      if (value.method === "initialize") initialize = value;
      if (value.method === "notifications/initialized") initialized = true;
      if (value.id !== undefined && value.method) pending.set(JSON.stringify(value.id), value);
      if (replaying || !worker) {
        if (queued.length >= 128) throw Error("MCP restart queue full");
        queued.push(line);
      } else send(line);
    } catch {
      output({
        jsonrpc: "2.0",
        id: value?.id ?? null,
        error: { code: -32600, message: "Invalid or unavailable MCP request" },
      });
    }
  });
  input.once("close", () => {
    void owner.close();
  });
  try {
    await owner.start();
    for (const line of queued.splice(0)) send(line);
    await owner.finished;
  } finally {
    input.close();
    await owner.close();
  }
}
