import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedSimulatedProfile } from "../demo/harness.js";
import { refreshIndex, type IndexedSession } from "../../services/helpers/session-index.js";
import {
  interviewContext,
  queueInterview,
  readInterview,
  selectInterviewSessions,
} from "../../services/helpers/interview.js";

vi.mock("../../services/helpers/session-index.js", () => ({ refreshIndex: vi.fn() }));

let dir: string;
let env: Record<string, string>;

const sessions: IndexedSession[] = [
  {
    runtime: "codex",
    sessionId: "hri",
    cwd: "C:/work/hri",
    file: "C:/sessions/hri.jsonl",
    updatedAt: "2026-10-30T10:00:00.000Z",
    mtimeMs: 3,
    terms: { symphytum: 8, manuscript: 4, audit: 2 },
  },
  {
    runtime: "claude",
    sessionId: "scisense",
    cwd: "C:/work/scisense",
    file: "C:/sessions/scisense.jsonl",
    updatedAt: "2026-10-31T10:00:00.000Z",
    mtimeMs: 4,
    terms: { offre: 8, scisense: 5 },
  },
  {
    runtime: "codex",
    sessionId: "other",
    cwd: "C:/work/other",
    file: "C:/sessions/other.jsonl",
    updatedAt: "2026-10-29T10:00:00.000Z",
    mtimeMs: 2,
    terms: { unrelated: 9 },
  },
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-test-"));
  seedSimulatedProfile(dir, { hostUnsandboxed: true });
  env = {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_BACKGROUND_JOBS: "1",
    MIND_WAKE_HELPERS_DIR: path.join(dir, "helpers"),
  };
  vi.mocked(refreshIndex).mockResolvedValue({ sessions, reread: 0 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.clearAllMocks();
});

it("ranks matching sessions first and fills the requested count by recency", () => {
  const selected = selectInterviewSessions("offre SciSense", sessions, 3);
  expect(selected.map((item) => item.target)).toEqual([
    "claude:scisense",
    "codex:hri",
    "codex:other",
  ]);
  expect(selected[0]?.score).not.toBeNull();
  expect(selected[1]?.score).toBeNull();
});

it("builds a read-only, evidence-aware interview prompt around the current need", () => {
  const prompt = interviewContext("cartographier les missions HRI");
  expect(prompt).toContain("Besoin actuel : cartographier les missions HRI");
  expect(prompt).toContain("Ne modifie aucun fichier");
  expect(prompt).toContain("MIND_WAKE: done");
});

it("queues one supervised consultation per selected session and exposes an aggregate reader", async () => {
  const queued = await queueInterview(env, {
    phrase: "offre SciSense",
    count: 2,
    idempotencyKey: "interview-batch-001",
  });
  expect(queued).toMatchObject({
    requested_count: 2,
    selected_count: 2,
    queued_count: 2,
    workspace_updated: false,
    review_required: true,
  });
  expect(queued.selections).toHaveLength(2);
  const read = readInterview(env, queued.batch_id);
  expect(read).toMatchObject({
    phrase: "offre SciSense",
    report_count: 2,
    complete: false,
    workspace_updated: false,
  });
  expect(read.reports.every((report) => report.status === "queued")).toBe(true);
  expect(
    await queueInterview(env, {
      phrase: "offre SciSense",
      count: 2,
      idempotencyKey: "interview-batch-001",
    }),
  ).toEqual(queued);
});

it("refuses to reuse a batch key with different parameters", async () => {
  await queueInterview(env, {
    phrase: "offre SciSense",
    count: 1,
    idempotencyKey: "interview-batch-002",
  });
  await expect(
    queueInterview(env, {
      phrase: "audit HRI",
      count: 1,
      idempotencyKey: "interview-batch-002",
    }),
  ).rejects.toThrow("different interview parameters");
});
