import { describe, expect, it } from "vitest";
import {
  PIPELINE,
  classifyStageError,
  completeStage,
  getRandomBackoffMinutes,
  getStage,
  getStageSuccessStatus,
  isStageCandidate,
  isTaskUnlocked,
  recoveryPatch,
  selectStageCandidates,
  startStagePatch,
} from "../src/pipeline.js";
import type { CoordinatorStage } from "../src/pipeline.js";
import { CLEAN_STATE_RESET } from "../src/stateMachine.js";
import { NOW, makeTask } from "./helpers.js";

describe("PIPELINE (AIF coordinator.ts)", () => {
  it("has the AIF stage order and mapping", () => {
    expect(PIPELINE.map((s) => [s.label, s.inProgress, s.onSuccess, s.where])).toEqual([
      ["planner", "planning", "plan_ready", "server"],
      ["improver", "improve", "plan_ready", "server"],
      ["plan-checker", "plan_ready", "plan_ready", "server"],
      ["implementer", "implementing", "review", "pc"],
      ["verifier", "verify", "review", "server"],
      ["reviewer", "review", "done", "server"],
    ]);
    expect(getStage("reviewer").modelRole).toBe("review");
    expect(getStage("plan-checker").modelRole).toBe("planning");
  });

  it.each([
    ["planner", "planning", true],
    ["planner", "improve", false],
    ["improver", "improve", true],
    ["plan-checker", "plan_ready", true],
    ["implementer", "plan_ready", true],
    ["implementer", "implementing", true],
    ["implementer", "review", false],
    ["verifier", "verify", true],
    ["reviewer", "review", true],
    ["reviewer", "done", false],
  ] as const)("candidate %s for %s = %s", (stage, status, expected) => {
    expect(isStageCandidate(makeTask(status), stage, NOW)).toBe(expected);
  });

  it("plan_ready needs auto_mode for plan-checker and implementer", () => {
    const t = makeTask("plan_ready", { autoMode: false });
    expect(isStageCandidate(t, "plan-checker", NOW)).toBe(false);
    expect(isStageCandidate(t, "implementer", NOW)).toBe(false);
  });

  it("skips human-owned, paused and locked tasks", () => {
    const stages: CoordinatorStage[] = ["planner"];
    for (const stage of stages) {
      expect(isStageCandidate(makeTask("planning", { executionOwner: "human" }), stage, NOW)).toBe(false);
      expect(isStageCandidate(makeTask("planning", { paused: true }), stage, NOW)).toBe(false);
      expect(isStageCandidate(makeTask("planning", { lockedBy: "c", lockedUntil: "2026-10-29T11:00:00Z" }), stage, NOW)).toBe(false);
      expect(isStageCandidate(makeTask("planning", { lockedBy: "c", lockedUntil: "2026-10-29T09:00:00Z" }), stage, NOW)).toBe(true);
    }
    expect(isTaskUnlocked({ lockedBy: "c", lockedUntil: null }, NOW)).toBe(false);
  });

  it("orders candidates by position, created, id and limits", () => {
    const a = makeTask("planning", { id: "TASK-003", position: 2, created: "2026-01-01" });
    const b = makeTask("planning", { id: "TASK-002", position: 1, created: "2026-01-02" });
    const c = makeTask("planning", { id: "TASK-001", position: 1, created: "2026-01-02" });
    const d = makeTask("planning", { id: "TASK-004", position: 1, created: "2026-01-01" });
    expect(selectStageCandidates([a, b, c, d, makeTask("done")], "planner", NOW, 3).map((t) => t.id)).toEqual(["TASK-004", "TASK-001", "TASK-002"]);
  });

  it("success status follows flags (AIF getStageSuccessStatus)", () => {
    expect(getStageSuccessStatus(makeTask("planning", { runPlanImprove: true }), getStage("planner"))).toBe("improve");
    expect(getStageSuccessStatus(makeTask("planning", { runPlanImprove: true, useSubagents: true }), getStage("planner"))).toBe("plan_ready");
    expect(getStageSuccessStatus(makeTask("planning"), getStage("planner"))).toBe("plan_ready");
    expect(getStageSuccessStatus(makeTask("implementing", { runPostVerify: true }), getStage("implementer"))).toBe("verify");
    expect(getStageSuccessStatus(makeTask("implementing", { runPostVerify: true, useSubagents: true }), getStage("implementer"))).toBe("review");
    expect(getStageSuccessStatus(makeTask("verify", { skipReview: true }), getStage("verifier"))).toBe("done");
    expect(getStageSuccessStatus(makeTask("verify", { skipReview: false }), getStage("verifier"))).toBe("review");
    expect(getStageSuccessStatus(makeTask("review"), getStage("reviewer"))).toBe("done");
  });

  it("implementer with skip_review → done (or verify) and needs commit", () => {
    expect(completeStage(makeTask("implementing", { skipReview: true }), getStage("implementer"), null)).toEqual({
      patch: { ...CLEAN_STATE_RESET, status: "done" },
      handoffToHuman: null,
      requiresCommit: true,
    });
    expect(completeStage(makeTask("implementing", { skipReview: true, runPostVerify: true }), getStage("implementer"), null).patch.status).toBe("verify");
  });

  it("implementer without skip_review → review, keeps review iteration", () => {
    const r = completeStage(makeTask("implementing", { skipReview: false, reviewIterationCount: 2 }), getStage("implementer"), null);
    expect(r.patch).toMatchObject({ status: "review", reviewIterationCount: 2 });
    expect(r.requiresCommit).toBe(false);
  });

  it("reviewer outcomes", () => {
    const task = makeTask("review", { skipReview: false });
    const rev = getStage("reviewer");
    expect(completeStage(task, rev, { status: "accepted", currentIteration: 1 })).toMatchObject({ patch: { status: "done" }, requiresCommit: true });
    const ars = { strategy: "full_re_review" as const, iteration: 1, findings: [] };
    expect(completeStage(task, rev, { status: "rework_requested", currentIteration: 1, autoReviewState: ars }).patch).toMatchObject({
      status: "implementing",
      reworkRequested: true,
      reviewIterationCount: 1,
      commitSha: null,
    });
    const manual = completeStage(task, rev, { status: "manual_review_required", currentIteration: 3, autoReviewState: ars, handoffReason: "max_iterations" });
    expect(manual.patch.status).toBeUndefined();
    expect(manual.patch.manualReviewRequired).toBe(true);
    expect(manual.handoffToHuman).toEqual({ reason: "max_iterations" });
    expect(completeStage(makeTask("review", { autoMode: false }), rev, { status: "rework_requested", currentIteration: 1, autoReviewState: null }).patch.status).toBe("done");
    expect(completeStage(task, rev, null).patch.status).toBe("done");
  });

  it("start patch locks the task", () => {
    expect(startStagePatch(getStage("implementer"), "coord", "2026-10-29T11:00:00Z", "2026-10-29T10:00:00Z")).toEqual({
      status: "implementing",
      lockedBy: "coord",
      lockedUntil: "2026-10-29T11:00:00Z",
      stageStartedAt: "2026-10-29T10:00:00Z",
      lastHeartbeatAt: "2026-10-29T10:00:00Z",
    });
  });
});

describe("stage errors (AIF stageErrorHandler.ts)", () => {
  const base = { retryCount: 1, now: NOW, random: 0 };
  it("backoff is 5..15 minutes", () => {
    expect(getRandomBackoffMinutes(0)).toBe(5);
    expect(getRandomBackoffMinutes(0.9999)).toBe(15);
  });
  it("manual block and branch isolation → blocked without retry", () => {
    expect(classifyStageError({ ...base, error: { kind: "manual_block", reason: "need human" } })).toEqual({
      kind: "blocked_external",
      blockedReason: "need human",
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: 1,
    });
    expect(classifyStageError({ ...base, error: { kind: "branch_isolation", reason: "dirty" } })).toMatchObject({ blockedReason: "Branch isolation failure: dirty", retryAfter: null });
  });
  it("fast retry and revert", () => {
    expect(classifyStageError({ ...base, error: { kind: "fast_retry", reason: "stream" } })).toEqual({ kind: "fast_retry" });
    expect(classifyStageError({ ...base, error: { kind: "other", reason: "boom" } })).toEqual({ kind: "revert" });
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "unknown", reason: "?" } })).toEqual({ kind: "revert" });
  });
  it("limits only switch the model (Р-024, Р-025)", () => {
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "rate_limit", reason: "429", resetAt: "2026-10-29T15:00:00Z" } })).toEqual({
      kind: "switch_model",
      category: "rate_limit",
      resetAt: "2026-10-29T15:00:00Z",
    });
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "no_subscription", reason: "402" } })).toEqual({ kind: "switch_model", category: "no_subscription", resetAt: null });
  });
  it("non-retryable → manual blocked", () => {
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "context_length", reason: "x" } })).toMatchObject({ kind: "blocked_external", retryAfter: null, retryCount: 1 });
  });
  it("external → blocked with retry_after from resetAt / seconds / random", () => {
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "auth", reason: "x", resetAt: "2026-10-29T12:00:00Z" } })).toMatchObject({
      retryAfter: "2026-10-29T12:00:00.000Z",
      retryAfterSource: "resetAt",
      retryCount: 2,
    });
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "timeout", reason: "x", resetAt: "2020-01-01T00:00:00Z" } })).toMatchObject({ retryAfter: NOW.toISOString() });
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "stream", reason: "x", retryAfterSeconds: 60 } })).toMatchObject({
      retryAfter: "2026-10-29T10:01:00.000Z",
      retryAfterSource: "retryAfterSeconds",
    });
    expect(classifyStageError({ ...base, error: { kind: "runtime", category: "transport", reason: "x", resetAt: "bad" } })).toMatchObject({
      retryAfter: "2026-10-29T10:05:00.000Z",
      retryAfterSource: "random_backoff",
    });
    expect(JSON.stringify(classifyStageError({ ...base, error: { kind: "runtime", category: "permission", reason: "x" } }))).toContain("permissions");
    expect(JSON.stringify(classifyStageError({ ...base, error: { kind: "runtime", category: "auth", reason: "x" } }))).toContain("authentication");
    expect(JSON.stringify(classifyStageError({ ...base, error: { kind: "runtime", category: "timeout", reason: "x" } }))).toContain("timed out");
    expect(JSON.stringify(classifyStageError({ ...base, error: { kind: "runtime", category: "stream", reason: "x" } }))).toContain("stream");
  });
  it("recovery patches", () => {
    const st = getStage("implementer");
    expect(recoveryPatch({ kind: "fast_retry" }, st)).toMatchObject({ status: "implementing", blockedReason: null });
    expect(recoveryPatch({ kind: "revert" }, st)).toEqual({ status: "implementing", lockedBy: null, lockedUntil: null });
    expect(recoveryPatch({ kind: "switch_model", category: "rate_limit", resetAt: null }, st)).toEqual({ status: "implementing", lockedBy: null, lockedUntil: null });
    expect(recoveryPatch({ kind: "blocked_external", blockedReason: "r", retryAfter: "t", retryAfterSource: "resetAt", retryCount: 2 }, st)).toEqual({
      status: "blocked_external",
      blockedReason: "r",
      blockedFromStatus: "implementing",
      retryAfter: "t",
      retryCount: 2,
      lockedBy: null,
      lockedUntil: null,
    });
  });
});
