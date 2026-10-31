import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessTreeSupervisor, type SessionProcess } from "../../src/runner/process-tree.js";
import type { ProfileId, SessionId } from "../../src/contracts/index.js";
import {
  MaintenanceController,
  type MaintenancePolicy,
} from "../../services/maintenance/controller.js";
import {
  LocalMaintenanceAdapter,
  type OwnedLifecycle,
} from "../../services/maintenance/local-adapter.js";
import { componentSchema, type Observation } from "../../src/communication/maintenance-protocol.js";
import { checkUpdate } from "../../scripts/app-update.mjs";
const actor = "agent-aaaaaaaaaa",
  target = "agent-bbbbbbbbbb";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string) =>
  git(
    cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-am",
    "fixture",
  );
const request = (action: "reinstall" | "relaunch_app") => ({
  requestId: randomUUID(),
  target,
  action,
  release: "approved",
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 240_000).toISOString(),
});
const scratch = () => {
  const root = resolve(".local/remote-maintenance");
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve("output/remote-maintenance"), { recursive: true });
  return mkdtempSync(join(root, "adapter-"));
};

it("existing app-update pipeline fetches real fixture commits, builds real fixture executable, switches manifest and supervisor relaunch loads approved bytes", async () => {
  const dir = scratch(),
    source = join(dir, "source"),
    install = join(dir, "installation");
  mkdirSync(source);
  mkdirSync(install);
  git(source, "init", "--initial-branch=main");
  writeFileSync(join(source, "content.txt"), "old");
  git(source, "add", ".");
  commit(source);
  const oldRevision = git(source, "rev-parse", "HEAD");
  const oldCheckout = join(dir, "old-checkout");
  git(dir, "clone", "--", source, oldCheckout);
  writeFileSync(join(source, "content.txt"), "updated");
  commit(source);
  const approved = git(source, "rev-parse", "HEAD");
  // The production helper requires npm beside node. This fixture supplies its
  // own local toolchain descriptor; every Git call and generated Node build runs.
  const fixtureNode = join(dir, "toolchain/node.exe");
  mkdirSync(join(dir, "toolchain/node_modules/npm/bin"), { recursive: true });
  writeFileSync(join(dir, "toolchain/node_modules/npm/bin/npm-cli.js"), "// fixture descriptor");
  const manifest = join(install, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      development: false,
      repoDir: oldCheckout,
      dataDir: dir,
      node: fixtureNode,
      revision: oldRevision,
      updateSource: source,
      updateBranch: "main",
    }),
  );
  const supervisor = new ProcessTreeSupervisor(join(dir, "runtime"));
  let child: SessionProcess | undefined,
    loaded: Observation["components"]["app"] = {
      state: "unknown",
      instance: null,
      loadedRevision: null,
      artifactSha256: null,
    };
  const trace: string[] = [];
  async function ownedRun(exe: string, args: string[], cwd: string, signal?: AbortSignal) {
    if (signal?.aborted) throw Error("cancelled");
    const p = supervisor.spawn("maintenance-fixture" as ProfileId, randomUUID() as SessionId, {
      executable: exe,
      args,
      cwd,
      env: { PATH: process.env["PATH"] ?? process.env["Path"] ?? "", GIT_TERMINAL_PROMPT: "0" },
    });
    const stop = () => {
      void p.terminateTree();
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      await p.started();
      let output = "",
        line: string | null;
      while ((line = await p.readLine()) !== null) output += line + "\n";
      const exit = await p.exited;
      if (exit.mainExitCode !== 0 || signal?.aborted) throw Error("fixture command failed");
      return output;
    } finally {
      signal?.removeEventListener("abort", stop);
      if (!p.hasExited) await p.terminateTree();
    }
  }
  const lifecycle: OwnedLifecycle = {
    actions: ["relaunch_app"],
    observe: () =>
      Promise.resolve({
        app: loaded,
        daemon: { state: "unknown", instance: null, loadedRevision: null, artifactSha256: null },
        mcp: { state: "unknown", instance: null, loadedRevision: null, artifactSha256: null },
      }),
    handoff: async (_action, signal) => {
      if (signal.aborted) throw Error("cancelled");
      trace.push("handoff");
      if (child) await child.terminateTree();
      const m = JSON.parse(readFileSync(manifest, "utf8")) as { repoDir: string };
      child = supervisor.spawn("maintenance-fixture" as ProfileId, randomUUID() as SessionId, {
        executable: process.execPath,
        args: [join(m.repoDir, "fixture-component.mjs")],
        cwd: m.repoDir,
        env: {},
      });
      await child.started();
      const line = await child.readLine();
      if (!line) throw Error("No loaded-version handshake");
      loaded = componentSchema.parse(JSON.parse(line));
      trace.push(`loaded:${String(loaded.loadedRevision)}`);
    },
  };
  const adapter = new LocalMaintenanceAdapter({
    dataDir: dir,
    repoDir: oldCheckout,
    manifestFile: manifest,
    lifecycle,
    update: async (expectedRevision, signal) => {
      const result = await checkUpdate(manifest, {
        expectedRevision,
        beforeStep: () => {
          if (signal.aborted) throw Error("cancelled");
        },
        run: async (exe: string, args: string[], cwd: string) => {
          trace.push(exe === "git" ? `git:${String(args[0])}` : "build:" + args.join(" "));
          if (exe === "git") return ownedRun(exe, args, cwd, signal);
          if (exe === "cargo") {
            // Actual miniature build. Fixture .exe is a marker, not a Windows app.
            // The generated Node component is the executable we really relaunch.
            const builder = `const fs=require('node:fs');const c=require('node:child_process');const rev=c.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();fs.mkdirSync('dist/cli',{recursive:true});fs.writeFileSync('dist/cli/main.js','// fixture CLI');fs.mkdirSync('desktop/src-tauri/target/release',{recursive:true});fs.writeFileSync('desktop/src-tauri/target/release/mind-wake-desktop.exe','fixture marker');const code="import {randomUUID,createHash} from 'node:crypto';import {readFileSync} from 'node:fs';console.log(JSON.stringify({state:'running',loadedRevision:'"+rev+"',instance:randomUUID(),artifactSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex')}));setInterval(()=>{},1000);";fs.writeFileSync('fixture-component.mjs',code);`;
            return ownedRun(process.execPath, ["-e", builder], cwd, signal);
          }
          return ownedRun(
            process.execPath,
            [
              "-e",
              "require('node:fs').appendFileSync('fixture-build.log','build step executed\\n')",
            ],
            cwd,
            signal,
          );
        },
      });
      if (!["installed", "current"].includes(result.state) || result.revision !== expectedRevision)
        throw Error("Update did not install approved release");
    },
  });
  // Synthetic Wake state is explicit; the installer and contained component are real.
  const originalObserve = adapter.observe.bind(adapter);
  adapter.observe = async () => ({ ...(await originalObserve()), wake: "ready", forceOff: false });
  adapter.controlState = () => ({ wake: "ready", forceOff: false });
  const policy: MaintenancePolicy = {
    target,
    sharedEndpoint: "https://fixture.invalid/v1/messages",
    grants: [{ actor, actions: ["reinstall", "relaunch_app"] }],
    releases: { approved: { revision: approved } },
  };
  const controller = new MaintenanceController(
    join(dir, "maintenance.sqlite"),
    () => policy,
    adapter,
  );
  try {
    const r = request("reinstall");
    controller.accept(actor, r);
    const result = await controller.run(r.requestId);
    expect(result.state, JSON.stringify(result)).toBe("verified");
    expect(result.observation?.components.app.loadedRevision).toBe(approved);
    expect(result.observation?.components.app.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.observation?.installedRevision).toBe(approved);
    expect(trace.indexOf("git:fetch")).toBeLessThan(trace.indexOf("handoff"));
    expect(git(oldCheckout, "rev-parse", "HEAD")).toBe(oldRevision);
    expect(readFileSync(join(oldCheckout, "content.txt"), "utf8")).toBe("old");
    expect(
      (
        JSON.parse(readFileSync(join(install, "previous-manifest.json"), "utf8")) as {
          repoDir: string;
        }
      ).repoDir,
    ).toBe(oldCheckout);
    writeFileSync(
      resolve("output/remote-maintenance/fixture-install-proof.json"),
      JSON.stringify({ result, trace, fixtureOnly: true, miniatureToolchain: true }, null, 2),
    );
  } finally {
    if (child) await child.terminateTree();
    controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

it("real supervised fast-forward pull preserves dirty/divergent work and refuses unapproved revisions", async () => {
  const dir = scratch(),
    upstream = join(dir, "upstream"),
    checkout = join(dir, "checkout");
  mkdirSync(upstream);
  git(upstream, "init", "--initial-branch=main");
  writeFileSync(join(upstream, "source.txt"), "old");
  git(upstream, "add", ".");
  commit(upstream);
  git(dir, "clone", "--", upstream, checkout);
  const before = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(upstream, "source.txt"), "new");
  commit(upstream);
  const approved = git(upstream, "rev-parse", "HEAD");
  const httpsOrigin = "https://fixture.invalid/wake.git";
  // Test-only Git rewrite to a local fixture. No network, global config or TLS bypass.
  git(checkout, "config", "remote.origin.url", httpsOrigin);
  git(checkout, "config", `url.${upstream.replaceAll("\\", "/")}.insteadOf`, httpsOrigin);
  const adapter = new LocalMaintenanceAdapter({
    dataDir: dir,
    repoDir: checkout,
    source: { httpsOrigin, branch: "main" },
  });
  const r = { ...request("reinstall"), action: "pull_source" as const };
  try {
    writeFileSync(join(checkout, "local.txt"), "preserve this work");
    await expect(adapter.execute(r, approved, new AbortController().signal)).rejects.toThrow(
      "Local changes preserved",
    );
    expect(readFileSync(join(checkout, "local.txt"), "utf8")).toBe("preserve this work");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    git(checkout, "add", "local.txt");
    commit(checkout);
    const divergent = git(checkout, "rev-parse", "HEAD");
    await expect(adapter.execute(r, approved, new AbortController().signal)).rejects.toThrow();
    expect(git(checkout, "rev-parse", "HEAD")).toBe(divergent);
    // Fresh checkout: no reset of the divergent fixture.
    const fresh = join(dir, "fresh");
    git(dir, "clone", "--", upstream, fresh);
    git(fresh, "config", "remote.origin.url", httpsOrigin);
    git(fresh, "config", `url.${upstream.replaceAll("\\", "/")}.insteadOf`, httpsOrigin);
    const safe = new LocalMaintenanceAdapter({
      dataDir: dir,
      repoDir: fresh,
      source: { httpsOrigin, branch: "main" },
    });
    await expect(safe.execute(r, "a".repeat(40), new AbortController().signal)).rejects.toThrow(
      "Unapproved revision",
    );
    // Advance source after cloning, then actually fast-forward the fixture checkout.
    writeFileSync(join(upstream, "source.txt"), "third");
    commit(upstream);
    const newest = git(upstream, "rev-parse", "HEAD");
    await safe.execute(r, newest, new AbortController().signal);
    expect(git(fresh, "rev-parse", "HEAD")).toBe(newest);
    expect(readFileSync(join(fresh, "source.txt"), "utf8")).toBe("third");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
