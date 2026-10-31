/** Local helper: prepare a fresh job script, never launch or edit runtime config. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { preflightScopedJob } from "../services/shared-workspace/scoped-job.mjs";

export function prepareScopedJob({ workspace, config }) {
  config = fs.realpathSync.native(config);
  if (preflightScopedJob(config).status !== "ready_to_start")
    throw new Error("target_preflight_refused");
  const root = fs.realpathSync.native(workspace);
  const jobs = fs.realpathSync.native(path.join(root, "jobs"));
  if (jobs.toLowerCase() !== path.join(root, "jobs").toLowerCase())
    throw new Error("jobs_directory_must_not_be_link");
  const script = "jobs/serve-scoped-workspace.mjs";
  const launcher = new URL("../services/shared-workspace/scoped-job.mjs", import.meta.url).href;
  fs.writeFileSync(
    path.join(root, script),
    `import { runScopedWorkspaceJob } from ${JSON.stringify(launcher)};\n` +
      `try { await runScopedWorkspaceJob(${JSON.stringify(config)}); }\n` +
      `catch { console.error('scoped_workspace_job_failed'); process.exitCode = 1; }\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    script,
    args: [],
    note: "Submit with start_background_job and a fresh idempotency_key. No job started.",
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: { workspace: { type: "string" }, config: { type: "string" } },
    });
    console.log(JSON.stringify(prepareScopedJob(values)));
  } catch {
    console.error("scoped_workspace_job_setup_refused");
    process.exitCode = 1;
  }
}
