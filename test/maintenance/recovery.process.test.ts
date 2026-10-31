import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTreeSupervisor, type SessionProcess } from "../../src/runner/process-tree.js";
import type { ProfileId, SessionId } from "../../src/contracts/index.js";
import { NODE_ARGS, minimalEnv } from "../mcp/harness.js";
import { componentSchema, resultSchema } from "../../src/communication/maintenance-protocol.js";

it("actual controller exits during owned handoff and recovers verified result after process restart without replay", async () => {
  const root = resolve(".local/remote-maintenance");
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve("output/remote-maintenance"), { recursive: true });
  const dir = mkdtempSync(join(root, "recovery-")),
    expected = "b".repeat(40);
  const supervisor = new ProcessTreeSupervisor(join(dir, "runtime"));
  let component: SessionProcess | undefined,
    handoffs = 0;
  const old = join(dir, "old.mjs"),
    next = join(dir, "next.mjs");
  for (const [file, revision] of [
    [old, "a".repeat(40)],
    [next, expected],
  ] as const)
    writeFileSync(
      file,
      `import {randomUUID,createHash} from 'node:crypto';import {readFileSync} from 'node:fs';console.log(JSON.stringify({state:'running',loadedRevision:'${revision}',instance:randomUUID(),artifactSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex')}));setInterval(()=>{},1000);`,
    );
  async function launch(file: string) {
    if (component) await component.terminateTree();
    component = supervisor.spawn("recovery-fixture" as ProfileId, randomUUID() as SessionId, {
      executable: process.execPath,
      args: [file],
      cwd: dir,
      env: {},
    });
    await component.started();
    const line = await component.readLine();
    if (!line) throw Error("No component handshake");
    const unknown = {
      state: "unknown",
      loadedRevision: null,
      artifactSha256: null,
      instance: null,
    };
    writeFileSync(
      join(dir, "observation.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        wake: "ready",
        forceOff: false,
        openSessions: 0,
        components: { app: componentSchema.parse(JSON.parse(line)), daemon: unknown, mcp: unknown },
        sourceRevision: null,
        installedRevision: null,
      }),
    );
  }
  const request = {
    requestId: randomUUID(),
    target: "agent-bbbbbbbbbb",
    action: "relaunch_app",
    release: "approved",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
  };
  writeFileSync(join(dir, "request.json"), JSON.stringify(request));
  const worker = join(dir, "controller-worker.mjs");
  writeFileSync(
    worker,
    `
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {MaintenanceController} from ${JSON.stringify(pathToFileURL(resolve("services/maintenance/controller.ts")).href)};
const dir=process.argv[2], read=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const policy={target:'agent-bbbbbbbbbb',sharedEndpoint:'https://fixture.invalid/v1/messages',grants:[{actor:'agent-aaaaaaaaaa',actions:['relaunch_app']}],releases:{approved:{revision:'${expected}'}}};
const adapter={capabilities:()=>['relaunch_app'],observe:async()=>read('observation.json'),execute:async()=>{process.send({handoff:true});await new Promise(resolve=>process.once('message',resolve));process.exit(75);}};
const c=new MaintenanceController(join(dir,'controller.sqlite'),()=>policy,adapter);
const request=read('request.json');c.accept('agent-aaaaaaaaaa',request);
try{const result=await c.run(request.requestId);writeFileSync(join(dir,'result.json'),JSON.stringify(result));}finally{c.close();process.disconnect();}
`,
  );
  async function runWorker() {
    return new Promise<number | null>((yes, no) => {
      const child = spawn(process.execPath, [...NODE_ARGS, worker, dir], {
        env: minimalEnv(),
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let errors = "";
      child.stderr?.on("data", (d) => {
        errors += String(d);
      });
      const timer = setTimeout(() => {
        child.kill();
        no(Error("Controller fixture timeout"));
      }, 20_000);
      child.on("message", () => {
        handoffs++;
        void launch(next)
          .then(() => child.send({ complete: true }))
          .catch(no);
      });
      child.on("error", no);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 || code === 75) yes(code);
        else no(Error(errors));
      });
    });
  }
  try {
    await launch(old);
    expect(await runWorker()).toBe(75);
    expect(await runWorker()).toBe(0);
    const result = resultSchema.parse(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")));
    expect(result.state).toBe("verified");
    expect(result.observation?.components.app.loadedRevision).toBe(expected);
    expect(handoffs).toBe(1);
    writeFileSync(
      resolve("output/remote-maintenance/recovery-proof.json"),
      JSON.stringify(
        { result, handoffs, controllerExit: 75, recoveredExit: 0, fixtureOnly: true },
        null,
        2,
      ),
    );
  } finally {
    if (component) await component.terminateTree();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
