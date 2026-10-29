/**
 * Execution handoff ai ↔ human. Mirrors aif-handoff `data/src/taskOwnership.ts`
 * `handoffTaskExecution` validation (bf6a8b6, MIT) as a pure function.
 */
import type { ExecutionOwner, Task, TaskAssignee, TaskEvent, TaskPatch, TaskStatus } from "./types.js";

export type OwnershipConflictCode =
  | "task_not_found"
  | "task_locked"
  | "ownership_revision_conflict"
  | "inactive_assignee"
  | "invalid_ownership_transition"
  | "ai_handoff_required";

export interface HandoffInput {
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner | undefined;
  expectedStatus?: TaskStatus | undefined;
  reason?: string | null | undefined;
  resumeAction?: TaskEvent | undefined;
  /** Coordinator may hand off a task it holds itself (AIF `allowLockedBy`). */
  allowLockedBy?: string | undefined;
}

export type HandoffResult =
  | { ok: true; patch: TaskPatch }
  | { ok: false; code: OwnershipConflictCode; message: string };

const RESET = {
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  reworkRequested: false,
  reviewIterationCount: 0,
  manualReviewRequired: false,
  autoReviewState: null,
  scheduledAt: null,
} as const;

function fail(code: OwnershipConflictCode, message: string): HandoffResult {
  return { ok: false, code, message };
}

export function hasLiveLock(task: Pick<Task, "lockedBy" | "lockedUntil">, now: Date, allowLockedBy?: string): boolean {
  return (
    task.lockedBy !== null &&
    task.lockedBy !== allowLockedBy &&
    (task.lockedUntil === null || Date.parse(task.lockedUntil) > now.getTime())
  );
}

/**
 * `participants` resolves requested assignee ids (null = unknown id).
 */
export function resolveHandoff(
  task: Task,
  input: HandoffInput,
  participants: (id: string) => TaskAssignee | null,
  now: Date,
): HandoffResult {
  if (hasLiveLock(task, now, input.allowLockedBy)) return fail("task_locked", "Task is locked by a running stage");
  if (
    task.ownershipRevision !== input.expectedOwnershipRevision ||
    (input.expectedExecutionOwner !== undefined && task.executionOwner !== input.expectedExecutionOwner) ||
    (input.expectedStatus !== undefined && task.status !== input.expectedStatus)
  ) {
    return fail("ownership_revision_conflict", "Task changed since it was read");
  }
  const humanToAi = task.executionOwner === "human" && input.executionOwner === "ai";
  if (
    task.status === "verified" ||
    (input.executionOwner === "ai" && input.assigneeIds.length > 0) ||
    (humanToAi && task.status === "plan_ready" && !task.autoMode && input.resumeAction !== "start_implementation") ||
    (humanToAi && task.status === "blocked_external" && (input.resumeAction !== "retry_from_blocked" || task.blockedFromStatus === null))
  ) {
    return fail("invalid_ownership_transition", "Ownership transition is not allowed");
  }
  const requested: TaskAssignee[] = [];
  for (const id of input.assigneeIds) {
    const p = participants(id);
    if (!p?.active) return fail("inactive_assignee", `Assignee ${id} is missing or inactive`);
    requested.push(p);
  }
  const sameAssignees =
    task.assignees.length === requested.length &&
    [...task.assignees.map((a) => a.participantId)].sort().join("\u0000") === [...requested.map((a) => a.participantId)].sort().join("\u0000");
  if (task.executionOwner === input.executionOwner && sameAssignees) {
    return fail("invalid_ownership_transition", "Handoff would not change ownership");
  }
  const patch: TaskPatch = {
    executionOwner: input.executionOwner,
    assignees: requested,
    ownershipRevision: task.ownershipRevision + 1,
    stageStartedAt: null,
  };
  if (humanToAi && task.status === "backlog") Object.assign(patch, RESET, { status: "planning" });
  if (humanToAi && task.status === "plan_ready" && !task.autoMode && input.resumeAction === "start_implementation") {
    Object.assign(patch, RESET, { status: "implementing" });
  }
  if (humanToAi && task.status === "blocked_external" && input.resumeAction === "retry_from_blocked" && task.blockedFromStatus !== null) {
    Object.assign(patch, RESET, { status: task.blockedFromStatus });
  }
  return { ok: true, patch };
}

/** Optimistic status check (spec 7): `expected_status` mismatch → `status_conflict`. */
export function checkExpectedStatus(task: Pick<Task, "status">, expected: TaskStatus | undefined): boolean {
  return expected === undefined || task.status === expected;
}
