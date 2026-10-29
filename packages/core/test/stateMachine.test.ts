import { describe, expect, it } from "vitest";
import {
  CLEAN_STATE_RESET,
  HUMAN_ACTIONS_BY_STATUS,
  applyHumanTaskEvent,
  findEventForMove,
  resolveTaskAction,
  resolveTaskPermissions,
} from "../src/stateMachine.js";
import type { TaskEvent, TaskStatus } from "../src/types.js";
import { TASK_EVENTS, TASK_STATUSES } from "../src/types.js";
import { ADMIN, LEGACY, makeTask } from "./helpers.js";

/** Ported from aif-handoff stateMachine.test.ts (bf6a8b6). */
describe("task state machine (AIF port)", () => {
  it("allows start_ai from backlog", () => {
    expect(applyHumanTaskEvent(makeTask("backlog"), "start_ai")).toMatchObject({ ok: true, patch: { status: "planning" } });
  });
  it("rejects start_ai from non-backlog statuses", () => {
    expect(applyHumanTaskEvent(makeTask("done"), "start_ai").ok).toBe(false);
  });
  it("keeps improve and verify as coordinator-only statuses", () => {
    expect(applyHumanTaskEvent(makeTask("improve"), "start_implementation").ok).toBe(false);
    expect(applyHumanTaskEvent(makeTask("verify"), "approve_done").ok).toBe(false);
  });
  it("allows accept_existing_plan from backlog with clean state", () => {
    const r = applyHumanTaskEvent(makeTask("backlog"), "accept_existing_plan");
    expect(r).toMatchObject({ ok: true, patch: { status: "plan_ready", reviewIterationCount: 0, manualReviewRequired: false, autoReviewState: null } });
  });
  it("rejects accept_existing_plan outside backlog", () => {
    expect(applyHumanTaskEvent(makeTask("planning"), "accept_existing_plan").ok).toBe(false);
  });
  it("approve_done resets review state", () => {
    const task = makeTask("done", {
      reviewIterationCount: 2,
      manualReviewRequired: true,
      autoReviewState: { strategy: "closure_first", iteration: 2, findings: [{ id: "f", source: "code_review", text: "x" }] },
    });
    expect(applyHumanTaskEvent(task, "approve_done")).toEqual({ ok: true, patch: { ...CLEAN_STATE_RESET, status: "verified" } });
  });
  it("request_changes from done → implementing + rework", () => {
    const r = applyHumanTaskEvent(makeTask("done", { reviewIterationCount: 3, manualReviewRequired: true }), "request_changes");
    expect(r).toEqual({ ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing", reworkRequested: true } });
  });
  it("retries blocked task to previous status", () => {
    const r = applyHumanTaskEvent(makeTask("blocked_external", { blockedFromStatus: "review", blockedReason: "rate limit", retryAfter: "2026-01-01T00:00:00Z" }), "retry_from_blocked");
    expect(r).toMatchObject({ ok: true, patch: { status: "review", blockedReason: null, blockedFromStatus: null, retryAfter: null } });
  });
  it("retry_from_blocked without blocked_from → blocked_status_missing", () => {
    expect(applyHumanTaskEvent(makeTask("blocked_external"), "retry_from_blocked")).toMatchObject({ ok: false, code: "blocked_status_missing" });
  });
  it("start_implementation only when autoMode=false", () => {
    expect(applyHumanTaskEvent(makeTask("plan_ready", { autoMode: false }), "start_implementation")).toMatchObject({ ok: true, patch: { status: "implementing" } });
    expect(applyHumanTaskEvent(makeTask("plan_ready", { autoMode: true }), "start_implementation")).toMatchObject({ ok: false, code: "action_not_allowed" });
    expect(applyHumanTaskEvent(makeTask("backlog", { autoMode: false }), "start_implementation").ok).toBe(false);
  });
  it("request_replanning and fast_fix from plan_ready", () => {
    expect(applyHumanTaskEvent(makeTask("plan_ready"), "request_replanning")).toMatchObject({ ok: true, patch: { status: "planning" } });
    expect(applyHumanTaskEvent(makeTask("plan_ready"), "fast_fix")).toMatchObject({ ok: true, patch: { status: "plan_ready" } });
    expect(applyHumanTaskEvent(makeTask("done"), "request_replanning").ok).toBe(false);
    expect(applyHumanTaskEvent(makeTask("done"), "fast_fix").ok).toBe(false);
  });
  it("rejects approve_done / request_changes / retry outside their statuses", () => {
    expect(applyHumanTaskEvent(makeTask("planning"), "approve_done").ok).toBe(false);
    expect(applyHumanTaskEvent(makeTask("plan_ready"), "request_changes").ok).toBe(false);
    expect(applyHumanTaskEvent(makeTask("review"), "retry_from_blocked").ok).toBe(false);
  });
  it("returns unknown event error", () => {
    const r = applyHumanTaskEvent(makeTask("backlog"), "unsupported" as TaskEvent);
    expect(r).toEqual({ ok: false, code: "action_not_allowed", error: "Unknown task event" });
    const h = resolveTaskAction(makeTask("backlog", { executionOwner: "human" }), "unsupported" as TaskEvent, ADMIN);
    expect(h).toEqual({ ok: false, code: "action_not_allowed", error: "Unknown task event" });
  });

  const member = {
    participantsModeEnabled: true,
    actor: { kind: "participant" as const, id: "member-1", displayNameSnapshot: "Member" },
    participantRole: "member" as const,
    participantActive: true,
  };
  const assigned = [{ participantId: "member-1", displayName: "Member", role: "member" as const, active: true }];

  it.each([
    ["backlog", "start_human_work", "planning"],
    ["planning", "mark_plan_ready", "plan_ready"],
    ["improve", "mark_plan_ready", "plan_ready"],
    ["plan_ready", "start_implementation", "implementing"],
    ["review", "request_review_changes", "implementing"],
    ["verify", "fail_verification", "implementing"],
    ["done", "approve_done", "verified"],
    ["done", "request_changes", "implementing"],
  ] as const)("assigned human action %s -%s-> %s", (status, event, expected) => {
    const task = makeTask(status, { executionOwner: "human", assignees: assigned });
    expect(resolveTaskAction(task, event, member)).toMatchObject({ ok: true, patch: { status: expected } });
  });

  it.each([
    [{ skipReview: false, runPostVerify: false }, "review"],
    [{ skipReview: true, runPostVerify: false }, "done"],
    [{ skipReview: false, runPostVerify: true }, "verify"],
  ] as const)("submit_implementation routes by flags %o → %s", (flags, status) => {
    expect(resolveTaskAction(makeTask("implementing", { ...flags, executionOwner: "human" }), "submit_implementation", ADMIN)).toMatchObject({ ok: true, patch: { status } });
  });

  it.each([
    [{ skipReview: false, runPostVerify: false }, "review"],
    [{ skipReview: true, runPostVerify: false }, "done"],
    [{ skipReview: false, runPostVerify: true }, "done"],
  ] as const)("pass_verification routes by flags %o → %s", (flags, status) => {
    expect(resolveTaskAction(makeTask("verify", { ...flags, executionOwner: "human" }), "pass_verification", ADMIN)).toMatchObject({ ok: true, patch: { status } });
  });

  it.each([
    [{ runPostVerify: false }, "done"],
    [{ runPostVerify: true }, "verify"],
  ] as const)("complete_review routes by flags %o → %s", (flags, status) => {
    expect(resolveTaskAction(makeTask("review", { ...flags, executionOwner: "human" }), "complete_review", ADMIN)).toMatchObject({ ok: true, patch: { status } });
  });

  it("member needs assignment; admin may act on any human task", () => {
    const task = makeTask("planning", { executionOwner: "human" });
    expect(resolveTaskAction(task, "mark_plan_ready", member)).toMatchObject({ ok: false, code: "assignment_required" });
    expect(resolveTaskAction(task, "mark_plan_ready", ADMIN)).toMatchObject({ ok: true });
  });
  it("members cannot act on AI-owned tasks", () => {
    expect(resolveTaskAction(makeTask("done"), "approve_done", member)).toMatchObject({ ok: false, code: "actor_not_authorized" });
  });
  it("participants mode requires an active participant", () => {
    const task = makeTask("done");
    expect(resolveTaskAction(task, "approve_done", { ...ADMIN, actor: { kind: "agent", id: "pi", displayNameSnapshot: null } })).toMatchObject({ ok: false, code: "actor_not_authorized" });
    expect(resolveTaskAction(task, "approve_done", { ...ADMIN, participantActive: false })).toMatchObject({ ok: false, code: "actor_not_authorized" });
    expect(resolveTaskAction(task, "approve_done", { ...ADMIN, participantRole: null })).toMatchObject({ ok: false, code: "actor_not_authorized" });
    expect(resolveTaskAction(task, "approve_done", { ...ADMIN, actor: { kind: "participant", id: null, displayNameSnapshot: null } })).toMatchObject({ ok: false, code: "actor_not_authorized" });
  });
  it("inactive assignee does not count", () => {
    const task = makeTask("planning", { executionOwner: "human", assignees: [{ ...assigned[0]!, active: false }] });
    expect(resolveTaskAction(task, "mark_plan_ready", member)).toMatchObject({ ok: false, code: "assignment_required" });
  });
  it("AI-only actions on human task require handoff", () => {
    for (const event of ["start_ai", "accept_existing_plan", "request_replanning", "fast_fix"] as const) {
      expect(resolveTaskAction(makeTask("backlog", { executionOwner: "human" }), event, ADMIN)).toMatchObject({ ok: false, code: "ai_handoff_required" });
    }
  });
  it("permissions are role-aware", () => {
    const task = makeTask("backlog", { executionOwner: "human" });
    expect(resolveTaskPermissions(task, member)).toEqual({
      canAssign: false,
      canHandoff: false,
      canSelfAssign: true,
      canAct: false,
      canComment: true,
      permittedActions: [],
    });
    const admin = resolveTaskPermissions(task, ADMIN);
    expect(admin.canAssign).toBe(true);
    expect(admin.canHandoff).toBe(true);
    expect(admin.permittedActions).toContain("start_human_work");
    const assignedMember = resolveTaskPermissions(makeTask("planning", { executionOwner: "human", assignees: assigned }), member);
    expect(assignedMember).toMatchObject({ canHandoff: true, canAct: true, canSelfAssign: false });
  });
  it("disabled participants mode keeps anonymous compatibility", () => {
    expect(resolveTaskAction(makeTask("backlog", { executionOwner: "human" }), "start_ai", LEGACY)).toMatchObject({ ok: true, patch: { status: "planning" } });
    expect(resolveTaskPermissions(makeTask("backlog"), LEGACY)).toEqual({
      canAssign: true,
      canHandoff: true,
      canSelfAssign: false,
      canAct: true,
      canComment: true,
      permittedActions: ["start_ai", "accept_existing_plan"],
    });
    expect(resolveTaskPermissions(makeTask("verified"), LEGACY).canAct).toBe(false);
  });
});

/**
 * Full matrix: every status × event × owner, compared with the spec tables 3.3 / 3.4.
 * `null` = denied.
 */
type Row = Partial<Record<TaskEvent, TaskStatus>>;
const AI_TABLE: Record<TaskStatus, Row> = {
  backlog: { start_ai: "planning", accept_existing_plan: "plan_ready" },
  planning: {},
  improve: {},
  plan_ready: { start_implementation: "implementing", request_replanning: "planning", fast_fix: "plan_ready" },
  implementing: {},
  review: {},
  verify: {},
  blocked_external: { retry_from_blocked: "review" },
  done: { approve_done: "verified", request_changes: "implementing" },
  verified: {},
};
const HUMAN_TABLE: Record<TaskStatus, Row> = {
  backlog: { start_human_work: "planning" },
  planning: { mark_plan_ready: "plan_ready" },
  improve: { mark_plan_ready: "plan_ready" },
  plan_ready: { start_implementation: "implementing" },
  implementing: { submit_implementation: "review" },
  review: { complete_review: "done", request_review_changes: "implementing" },
  verify: { pass_verification: "review", fail_verification: "implementing" },
  blocked_external: { retry_from_blocked: "review" },
  done: { approve_done: "verified", request_changes: "implementing" },
  verified: {},
};

describe("transition matrix (spec 3.3 / 3.4)", () => {
  for (const status of TASK_STATUSES) {
    for (const event of TASK_EVENTS) {
      it(`ai-owned ${status} × ${event}`, () => {
        const task = makeTask(status, { autoMode: false, blockedFromStatus: status === "blocked_external" ? "review" : null });
        const expected = AI_TABLE[status][event];
        const r = resolveTaskAction(task, event, ADMIN);
        if (expected) expect(r).toMatchObject({ ok: true, patch: { status: expected } });
        else expect(r.ok).toBe(false);
      });
      it(`human-owned ${status} × ${event}`, () => {
        const task = makeTask(status, { executionOwner: "human", autoMode: false, skipReview: false, runPostVerify: false, blockedFromStatus: status === "blocked_external" ? "review" : null });
        const expected = HUMAN_TABLE[status][event];
        const r = resolveTaskAction(task, event, ADMIN);
        if (expected) expect(r).toMatchObject({ ok: true, patch: { status: expected } });
        else expect(r.ok).toBe(false);
      });
    }
  }
  it("HUMAN_ACTIONS_BY_STATUS matches the AI table with autoMode=false", () => {
    for (const status of TASK_STATUSES) {
      expect([...HUMAN_ACTIONS_BY_STATUS[status]].sort()).toEqual(
        Object.keys(AI_TABLE[status]).filter((e) => e !== "accept_existing_plan").sort(),
      );
    }
  });
  it("every successful human transition clears block/retry/review state", () => {
    for (const status of TASK_STATUSES) {
      for (const event of TASK_EVENTS) {
        const r = resolveTaskAction(makeTask(status, { autoMode: false, blockedFromStatus: "review", retryCount: 2, blockedReason: "x", scheduledAt: "2026-01-01T00:00:00Z" }), event, ADMIN);
        if (r.ok) {
          expect(r.patch.retryCount).toBe(0);
          expect(r.patch.blockedReason).toBeNull();
          expect(r.patch.scheduledAt).toBeNull();
          expect(r.patch.manualReviewRequired).toBe(false);
        }
      }
    }
  });
});

describe("findEventForMove (board drag)", () => {
  it("maps drags to events", () => {
    expect(findEventForMove(makeTask("backlog"), "planning", ADMIN)).toBe("start_ai");
    expect(findEventForMove(makeTask("backlog"), "plan_ready", ADMIN)).toBe("accept_existing_plan");
    expect(findEventForMove(makeTask("done"), "verified", ADMIN)).toBe("approve_done");
    expect(findEventForMove(makeTask("done"), "implementing", ADMIN)).toBe("request_changes");
    expect(findEventForMove(makeTask("plan_ready"), "plan_ready", ADMIN)).toBe("fast_fix");
    expect(findEventForMove(makeTask("implementing"), "review", ADMIN)).toBeNull();
    expect(findEventForMove(makeTask("implementing", { executionOwner: "human", skipReview: false }), "review", ADMIN)).toBe("submit_implementation");
    expect(findEventForMove(makeTask("backlog"), "backlog", ADMIN)).toBeNull();
  });
});
