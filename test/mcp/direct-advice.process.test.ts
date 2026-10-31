import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { seedSimulatedProfile } from "../demo/harness.js";
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});
it("exposes direct repo tools over the real MCP process and refuses an invented session", async () => {
  harness = await startHarness();
  const dir = path.join(harness.dir, "direct-profile"),
    helpers = path.join(harness.dir, "empty-helpers");
  fs.mkdirSync(dir);
  fs.mkdirSync(helpers);
  fs.writeFileSync(path.join(helpers, "helpers.json"), JSON.stringify({ roots: [] }));
  seedSimulatedProfile(dir, { hostUnsandboxed: true });
  const client = await harness.party("agent", {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_BACKGROUND_JOBS: "1",
    MIND_WAKE_HELPERS_DIR: helpers,
  });
  const listed = await client.call("list_repo_sessions");
  expect(listed.isError).toBe(false);
  expect(listed.data["sessions"]).toEqual([]);
  const interview = await client.call("interview", {
    phrase: "Cartographier les missions actuelles",
    idempotency_key: "empty-interview-batch",
  });
  expect(interview.isError).toBe(true);
  expect(interview.data["error"]).toContain("No authorized local session");
  const refused = await client.call("send_repo_request", {
    target: "claude:invented",
    topic: "Question",
    context: "test",
    idempotency_key: "not-a-real-session",
  });
  expect(refused.isError).toBe(true);
  expect(refused.data["error"]).toContain("authorized roots");
}, 30_000);
