import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// This integration suite launches many real Windows Job Objects and Git processes.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { activateWorkspace, githubUrl, workspaceConfig } from "./workspace-config.js";
import { workspaceDirFor } from "./paths.js";
import {
  configureWorkspaceSync,
  git,
  requestWorkspaceSync,
  workspaceSyncStatus,
  WorkspaceGitSync,
  WORKSPACE_SYNC_INTERVAL,
} from "./workspace-git-sync.js";

let root: string,
  dir: string,
  work: string,
  remote: string,
  other: string,
  allowed: boolean,
  sync: WorkspaceGitSync;
const url = "https://github.com/wake-fixture/workspace.git";
async function setupRepo(folder: string) {
  await git(root, ["init", "--initial-branch=main", folder]);
  await git(folder, ["config", "user.name", "Wake Fixture"]);
  await git(folder, ["config", "user.email", "wake@example.invalid"]);
}
async function commit(folder: string, text: string) {
  fs.writeFileSync(path.join(folder, "shared.txt"), text);
  await git(folder, ["add", "--all"]);
  await git(folder, ["commit", "-m", text]);
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-git-sync-"));
  dir = path.join(root, "profile");
  work = path.join(dir, "workspace");
  remote = path.join(root, "remote.git");
  other = path.join(root, "other");
  fs.mkdirSync(dir);
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await setupRepo(work);
  await commit(work, "base");
  await git(work, ["remote", "add", "origin", url]);
  await git(work, ["config", `url.${pathToFileURL(remote).href}.insteadOf`, url]);
  await git(work, ["push", "-u", "origin", "main"]);
  await git(root, ["clone", remote, other]);
  await git(other, ["config", "user.name", "Other Fixture"]);
  await git(other, ["config", "user.email", "other@example.invalid"]);
  await configureWorkspaceSync(dir, { workspaceDir: work, githubUrl: url, enabled: true });
  allowed = true;
  sync = new WorkspaceGitSync(dir, () => allowed);
});
afterEach(async () => {
  await sync.close();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});
it("uses the existing workspace by default and persists a changed folder until next engine launch", async () => {
  const target = path.join(root, "new-workspace");
  fs.mkdirSync(target);
  await configureWorkspaceSync(dir, { workspaceDir: target, githubUrl: "", enabled: false });
  expect(workspaceDirFor(dir)).toBe(work);
  expect(workspaceSyncStatus(dir).pendingRestart).toBe(true);
  activateWorkspace(dir);
  expect(workspaceDirFor(dir)).toBe(target);
  expect(workspaceConfig(dir).enabled).toBe(false);
  expect(() => githubUrl("https://secret@github.com/a/b.git")).toThrow();
  expect(() => githubUrl("https://github.com/a/b?token=secret")).toThrow();
  await expect(
    configureWorkspaceSync(dir, { workspaceDir: dir, githubUrl: url, enabled: true }),
  ).rejects.toThrow("credentials");
  await expect(
    configureWorkspaceSync(dir, { workspaceDir: "relative", githubUrl: url, enabled: false }),
  ).rejects.toThrow("absolute");
  await expect(
    configureWorkspaceSync(dir, {
      workspaceDir: path.join(root, "missing"),
      githubUrl: url,
      enabled: false,
    }),
  ).rejects.toThrow();
});
it("pulls a real remote update after one minute and persists the next due time through restart", async () => {
  expect(WORKSPACE_SYNC_INTERVAL).toBe(60_000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
  await sync.tick();
  await commit(other, "remote-new");
  await git(other, ["push", "origin", "main"]);
  vi.setSystemTime(Date.now() + WORKSPACE_SYNC_INTERVAL - 1);
  await sync.tick();
  expect(fs.readFileSync(path.join(work, "shared.txt"), "utf8")).toBe("base");
  sync = new WorkspaceGitSync(dir, () => allowed);
  vi.setSystemTime(Date.now() + 1);
  await sync.tick();
  expect(fs.readFileSync(path.join(work, "shared.txt"), "utf8")).toBe("remote-new");
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
  expect(workspaceSyncStatus(dir).state.nextRunAt).toBe(
    new Date(Date.now() + WORKSPACE_SYNC_INTERVAL).toISOString(),
  );
});
it("commits and pushes ignored-aware work once under concurrent polls and suppresses recursive hooks", async () => {
  fs.writeFileSync(path.join(work, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(work, "ignored.txt"), "private ignored");
  fs.writeFileSync(path.join(work, "new.txt"), "new work");
  fs.writeFileSync(
    path.join(work, ".git", "hooks", "post-commit"),
    '#!/bin/sh\n[ "$MIND_WAKE_AUTO_PUSH_RUNNING" = "1" ] || exit 42\nprintf hook-ok > hook-evidence\n',
  );
  requestWorkspaceSync(dir);
  await Promise.all([sync.tick(), sync.tick(), sync.tick()]);
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
  expect(await git(remote, ["rev-parse", "main"])).toBe(await git(work, ["rev-parse", "HEAD"]));
  expect(await git(work, ["ls-files", "ignored.txt"])).toBe("");
  expect(fs.readFileSync(path.join(work, "hook-evidence"), "utf8")).toBe("hook-ok");
  const head = await git(work, ["rev-parse", "HEAD"]);
  await sync.tick();
  expect(await git(work, ["rev-parse", "HEAD"])).toBe(head);
});
it("blocks dirty remote advances without altering staged or working changes and needs an explicit retry", async () => {
  fs.writeFileSync(path.join(work, "shared.txt"), "local WIP");
  await git(work, ["add", "shared.txt"]);
  fs.writeFileSync(path.join(work, "new.txt"), "untracked");
  await commit(other, "remote-change");
  await git(other, ["push", "origin", "main"]);
  const index = await git(work, ["diff", "--cached"]),
    before = await git(work, ["rev-parse", "HEAD"]);
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("blocked");
  expect(await git(work, ["diff", "--cached"])).toBe(index);
  expect(fs.readFileSync(path.join(work, "shared.txt"), "utf8")).toBe("local WIP");
  expect(await git(work, ["rev-parse", "HEAD"])).toBe(before);
  await sync.tick();
  expect(await git(work, ["rev-parse", "HEAD"])).toBe(before);
});
it("retains diverged commits and existing conflict markers without attempting a merge", async () => {
  await commit(work, "local-commit");
  await commit(other, "remote-commit");
  await git(other, ["push", "origin", "main"]);
  const head = await git(work, ["rev-parse", "HEAD"]);
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("blocked");
  expect(await git(work, ["rev-parse", "HEAD"])).toBe(head);
  await git(work, ["fetch", "origin", "main"]);
  await expect(git(work, ["merge", "FETCH_HEAD"])).rejects.toThrow();
  const conflicted = fs.readFileSync(path.join(work, "shared.txt"), "utf8");
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("blocked");
  expect(fs.readFileSync(path.join(work, "shared.txt"), "utf8")).toBe(conflicted);
  expect(fs.existsSync(path.join(work, ".git", "MERGE_HEAD"))).toBe(true);
});
it("retains a rejected push as a local commit and sends it after manual resolution", async () => {
  fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
  fs.writeFileSync(path.join(work, "new.txt"), "retained");
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("blocked");
  const head = await git(work, ["rev-parse", "HEAD"]);
  expect(await git(remote, ["rev-parse", "main"])).not.toBe(head);
  fs.unlinkSync(path.join(remote, "hooks", "pre-receive"));
  await sync.tick();
  expect(await git(remote, ["rev-parse", "main"])).not.toBe(head);
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
  expect(await git(remote, ["rev-parse", "main"])).toBe(head);
});
it("respects Pause, disabled settings, mismatched remote and missing upstream", async () => {
  fs.writeFileSync(path.join(work, "new.txt"), "not yet");
  requestWorkspaceSync(dir);
  allowed = false;
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("paused");
  expect(await git(work, ["status", "--porcelain"])).toContain("new.txt");
  allowed = true;
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
  await configureWorkspaceSync(dir, { workspaceDir: work, githubUrl: url, enabled: false });
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("disabled");
  await git(work, ["remote", "set-url", "origin", "https://github.com/other/repository.git"]);
  await expect(
    configureWorkspaceSync(dir, { workspaceDir: work, githubUrl: url, enabled: true }),
  ).rejects.toThrow("match");
  await git(work, ["remote", "set-url", "origin", url]);
  await git(work, ["config", "--unset", "branch.main.remote"]);
  await expect(
    configureWorkspaceSync(dir, { workspaceDir: work, githubUrl: url, enabled: true }),
  ).rejects.toThrow();
});

it("does not rewrite unchanged paused/disabled state on every maintenance poll", async () => {
  allowed = false;
  await sync.tick();
  const file = path.join(dir, "workspace-sync-state.json");
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  await sync.tick();
  expect(fs.statSync(file).mtimeMs).toBe(before);
});
it("preserves SSH protocol and neutralizes askpass and SSH prompting", async () => {
  expect(githubUrl("git@github.com:a/b")).toBe("git@github.com:a/b.git");
  await git(work, ["config", "core.askPass", "should-never-run"]);
  expect(await git(work, ["config", "core.askPass"])).toBe("");
  const hook = path.join(work, ".git", "hooks", "pre-commit");
  fs.writeFileSync(
    hook,
    '#!/bin/sh\n[ "$GIT_TERMINAL_PROMPT" = "0" ] && [ "$GCM_INTERACTIVE" = "Never" ] && [ "$GIT_SSH_COMMAND" = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes" ] || exit 42\n',
  );
  await commit(work, "noninteractive");
});
it("pushes only the explicit upstream with followTags, mirror and hostile pushurl configured", async () => {
  await git(work, ["tag", "-a", "local-only", "-m", "local tag"]);
  await git(work, ["branch", "local-only"]);
  await git(work, ["config", "push.followTags", "true"]);
  await git(work, ["config", "remote.origin.mirror", "true"]);
  await git(work, ["config", "remote.origin.pushurl", "https://github.com/never/contact.git"]);
  fs.writeFileSync(path.join(work, "new.txt"), "one branch");
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
  expect(await git(remote, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
});
it("retries a transient loopback connection failure only after one minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
  const local = pathToFileURL(remote).href;
  await git(work, ["config", "--unset", `url.${local}.insteadOf`]);
  await git(work, ["config", "url.http://127.0.0.1:1/.insteadOf", url]);
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("error");
  await git(work, ["config", "--unset", "url.http://127.0.0.1:1/.insteadOf"]);
  await git(work, ["config", `url.${local}.insteadOf`, url]);
  vi.setSystemTime(Date.now() + WORKSPACE_SYNC_INTERVAL - 1);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("error");
  vi.setSystemTime(Date.now() + 1);
  await sync.tick();
  expect(workspaceSyncStatus(dir).state.status).toBe("ok");
});
it("honors an exclusive live-owner repository lock without committing", async () => {
  const before = await git(work, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(work, "new.txt"), "WIP");
  fs.writeFileSync(
    path.join(work, ".git", "mind-wake-workspace-sync.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  requestWorkspaceSync(dir);
  await sync.tick();
  expect(await git(work, ["rev-parse", "HEAD"])).toBe(before);
  expect(fs.readFileSync(path.join(work, "new.txt"), "utf8")).toBe("WIP");
});
it("cancels Git and a hook grandchild by owned Job Object, keeping WIP", async () => {
  const pids = path.join(root, "pids.json"),
    worker = path.join(root, "long-hook.mjs");
  fs.writeFileSync(
    worker,
    `import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    path.join(work, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\n"${process.execPath.replaceAll("\\", "/")}" "${worker.replaceAll("\\", "/")}"\n`,
  );
  fs.writeFileSync(path.join(work, "new.txt"), "WIP");
  requestWorkspaceSync(dir);
  const flight = sync.tick();
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(pids)) {
    if (Date.now() > deadline) throw Error("Hook did not start");
    await new Promise((r) => setTimeout(r, 30));
  }
  const owned = JSON.parse(fs.readFileSync(pids, "utf8")) as number[];
  allowed = false;
  await flight;
  expect(workspaceSyncStatus(dir).state.status).toBe("paused");
  for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
  expect(fs.readFileSync(path.join(work, "new.txt"), "utf8")).toBe("WIP");
}, 30000);
