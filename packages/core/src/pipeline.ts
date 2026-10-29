/**
 * Coordinator pipeline as pure functions. Mirrors aif-handoff
 * `agent/src/coordinator.ts` PIPELINE + `stageErrorHandler.ts` (bf6a8b6, MIT).
 * I/O (runners, storage) lives in @of/server.
 */
import { CLEAN_STATE_RESET } from "./stateMachine.js";
import type { AutoReviewState, Task, TaskPatch, TaskStatus } from "./types.js";
import { NON_RETRYABLE_RUNTIME_CATEGORIES, isExternalFailureCategory, isModelLimitCategory } from "./errors.js";
import type { RuntimeErrorCategory } from "./errors.js";

export const COORDINATOR_STAGES = ["planner", "improver", "plan-checker", "implementer", "verifier", "reviewer"] as const;
export type CoordinatorStage = (typeof COORDINATOR_STAGES)[number];

/** models.json role per stage (Р-024): plan-checker → planning, triage → review. */
export type ModelRole = "worker" | "planning" | "improve" | "review" | "verify";

export interface StageDefinition {
  label: CoordinatorStage;
  from: readonly TaskStatus[];
  inProgress: TaskStatus;
  onSuccess: TaskStatus;
  /** Where the stage runs (Р-019): Pi on server or worker on PC. */
  where: "server" | "pc";
  modelRole: ModelRole;
  /** ai-factory skill. */
  skill: string;
}

export const PIPELINE: readonly StageDefinition[] = [
  { label: "planner", from: ["planning"], inProgress: "planning", onSuccess: "plan_ready", where: "server", modelRole: "planning", skill: "aif-plan" },
  { label: "improver", from: ["improve"], inProgress: "improve", onSuccess: "plan_ready", where: "server", modelRole: "improve", skill: "aif-improve" },
  { label: "plan-checker", from: ["plan_ready"], inProgress: "plan_ready", onSuccess: "plan_ready", where: "server", modelRole: "planning", skill: "aif-plan" },
  { label: "implementer", from: ["plan_ready", "implementing"], inProgress: "implementing", onSuccess: "review", where: "pc", modelRole: "worker", skill: "aif-implement" },
  { label: "verifier", from: ["verify"], inProgress: "verify", onSuccess: "review", where: "server", modelRole: "verify", skill: "aif-verify" },
  { label: "reviewer", from: ["review"], inProgress: "review", onSuccess: "done", where: "server", modelRole: "review", skill: "aif-review" },
];

export function getStage(label: CoordinatorStage): StageDefinition {
  const stage = PIPELINE.find((s) => s.label === label);
  /* v8 ignore next -- exhaustive by construction */
  if (!stage) throw new Error(`Unknown stage ${label}`);
  return stage;
}

export function isTaskUnlocked(task: Pick<Task, "lockedBy" | "lockedUntil">, now: Date): boolean {
  return task.lockedBy === null || (task.lockedUntil !== null && Date.parse(task.lockedUntil) <= now.getTime());
}

/** AIF `coordinatorStageFilter` + `unlockedCoordinatorTaskFilter`. */
export function isStageCandidate(task: Task, stage: CoordinatorStage, now: Date): boolean {
  if (task.executionOwner !== "ai" || task.paused || !isTaskUnlocked(task, now)) return false;
  switch (stage) {
    case "implementer":
      return task.status === "implementing" || (task.status === "plan_ready" && task.autoMode);
    case "plan-checker":
      return task.status === "plan_ready" && task.autoMode;
    case "planner":
      return task.status === "planning";
    case "improver":
      return task.status === "improve";
    case "verifier":
      return task.status === "verify";
    case "reviewer":
      return task.status === "review";
  }
}

/** Candidates ordered like AIF: position asc, created asc. */
export function selectStageCandidates(tasks: readonly Task[], stage: CoordinatorStage, now: Date, limit: number): Task[] {
  return tasks
    .filter((t) => isStageCandidate(t, stage, now))
    .sort((a, b) => a.position - b.position || a.created.localeCompare(b.created) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function shouldRunSkillsModeImprove(task: Pick<Task, "runPlanImprove" | "useSubagents">): boolean {
  return task.runPlanImprove && !task.useSubagents;
}

export function shouldRunSkillsModeVerify(task: Pick<Task, "runPostVerify" | "useSubagents">): boolean {
  return task.runPostVerify && !task.useSubagents;
}

/** AIF `getStageSuccessStatus`. */
export function getStageSuccessStatus(task: Task, stage: StageDefinition): TaskStatus {
  if (stage.label === "planner" && shouldRunSkillsModeImprove(task)) return "improve";
  if (stage.label === "implementer" && shouldRunSkillsModeVerify(task)) return "verify";
  if (stage.label === "verifier" && task.skipReview) return "done";
  return stage.onSuccess;
}

export type ReviewOutcome =
  | { status: "accepted"; currentIteration: number }
  | { status: "rework_requested"; currentIteration: number; autoReviewState: AutoReviewState | null }
  | { status: "manual_review_required"; currentIteration: number; autoReviewState: AutoReviewState | null; handoffReason: string };

export interface StageCompletion {
  patch: TaskPatch;
  /** When set, the task is handed to the human (manual review, AIF). */
  handoffToHuman: { reason: string } | null;
  requiresCommit: boolean;
}

/**
 * Status patch after a stage finished successfully (AIF `processOneTask` success branch).
 * `review` is the parsed review gate result for the reviewer stage when `auto_mode` is on.
 */
export function completeStage(task: Task, stage: StageDefinition, review: ReviewOutcome | null): StageCompletion {
  if (stage.label === "implementer" && task.skipReview) {
    const status: TaskStatus = shouldRunSkillsModeVerify(task) ? "verify" : "done";
    return { patch: { ...CLEAN_STATE_RESET, status }, handoffToHuman: null, requiresCommit: status === "done" };
  }
  if (stage.label === "reviewer" && review && task.autoMode) {
    switch (review.status) {
      case "manual_review_required":
        return {
          patch: {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
            retryCount: 0,
            reworkRequested: false,
            reviewIterationCount: review.currentIteration,
            manualReviewRequired: true,
            autoReviewState: review.autoReviewState,
          },
          handoffToHuman: { reason: review.handoffReason },
          requiresCommit: false,
        };
      case "rework_requested":
        return {
          patch: {
            status: "implementing",
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
            retryCount: 0,
            reworkRequested: true,
            reviewIterationCount: review.currentIteration,
            manualReviewRequired: false,
            autoReviewState: review.autoReviewState,
            commitSha: null,
          },
          handoffToHuman: null,
          requiresCommit: false,
        };
      case "accepted":
        return { patch: { ...CLEAN_STATE_RESET, status: "done" }, handoffToHuman: null, requiresCommit: true };
    }
  }
  const successStatus = getStageSuccessStatus(task, stage);
  return {
    patch: {
      ...CLEAN_STATE_RESET,
      status: successStatus,
      reviewIterationCount: stage.label === "implementer" ? task.reviewIterationCount : 0,
    },
    handoffToHuman: null,
    requiresCommit: successStatus === "done" || successStatus === "verified",
  };
}

/** Patch applied when a stage starts (AIF `updateTaskStatus(task.id, stage.inProgress)`). */
export function startStagePatch(stage: StageDefinition, lockedBy: string, lockedUntil: string, nowIso: string): TaskPatch {
  return { status: stage.inProgress, lockedBy, lockedUntil, stageStartedAt: nowIso, lastHeartbeatAt: nowIso };
}

// ---------------------------------------------------------------------------
// Stage errors (AIF stageErrorHandler.ts)
// ---------------------------------------------------------------------------

export type StageError =
  | { kind: "manual_block"; reason: string }
  | { kind: "branch_isolation"; reason: string }
  | { kind: "fast_retry"; reason: string }
  | { kind: "runtime"; category: RuntimeErrorCategory; reason: string; resetAt?: string | null; retryAfterSeconds?: number | null }
  | { kind: "other"; reason: string };

export type ErrorRecovery =
  | { kind: "fast_retry" }
  /** Р-024/Р-025: limit → switch the model; the task process is not affected. */
  | { kind: "switch_model"; category: RuntimeErrorCategory; resetAt: string | null }
  | {
      kind: "blocked_external";
      blockedReason: string;
      retryAfter: string | null;
      retryAfterSource: "resetAt" | "retryAfterSeconds" | "random_backoff" | "none";
      retryCount: number;
    }
  | { kind: "revert" };

/** AIF `getRandomBackoffMinutes`: 5..15. `random` in [0,1). */
export function getRandomBackoffMinutes(random: number): number {
  return Math.floor(random * 11) + 5;
}

function safeExternalReason(category: RuntimeErrorCategory): string {
  switch (category) {
    case "auth":
      return "Runtime authentication failed. Check the configured runtime profile.";
    case "permission":
      return "Runtime permissions blocked this task. Check the configured runtime profile or approval mode.";
    case "timeout":
      return "Runtime request timed out. Task will retry automatically.";
    case "stream":
      return "Runtime stream failed. Task will retry automatically.";
    default:
      return "Runtime request failed. Task will retry automatically.";
  }
}

export function classifyStageError(input: { error: StageError; retryCount: number; now: Date; random: number }): ErrorRecovery {
  const { error, retryCount, now } = input;
  switch (error.kind) {
    case "manual_block":
    case "branch_isolation":
      return {
        kind: "blocked_external",
        blockedReason: error.kind === "branch_isolation" ? `Branch isolation failure: ${error.reason}` : error.reason,
        retryAfter: null,
        retryAfterSource: "none",
        retryCount,
      };
    case "fast_retry":
      return { kind: "fast_retry" };
    case "other":
      return { kind: "revert" };
    case "runtime": {
      if (isModelLimitCategory(error.category)) {
        return { kind: "switch_model", category: error.category, resetAt: error.resetAt ?? null };
      }
      if (NON_RETRYABLE_RUNTIME_CATEGORIES.has(error.category)) {
        return {
          kind: "blocked_external",
          blockedReason: `Runtime error (${error.category}). Manual action required before retry.`,
          retryAfter: null,
          retryAfterSource: "none",
          retryCount,
        };
      }
      if (!isExternalFailureCategory(error.category)) return { kind: "revert" };
      if (error.resetAt && Number.isFinite(Date.parse(error.resetAt))) {
        return {
          kind: "blocked_external",
          blockedReason: safeExternalReason(error.category),
          retryAfter: new Date(Math.max(Date.parse(error.resetAt), now.getTime())).toISOString(),
          retryAfterSource: "resetAt",
          retryCount: retryCount + 1,
        };
      }
      if (typeof error.retryAfterSeconds === "number" && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
        return {
          kind: "blocked_external",
          blockedReason: safeExternalReason(error.category),
          retryAfter: new Date(now.getTime() + error.retryAfterSeconds * 1000).toISOString(),
          retryAfterSource: "retryAfterSeconds",
          retryCount: retryCount + 1,
        };
      }
      return {
        kind: "blocked_external",
        blockedReason: safeExternalReason(error.category),
        retryAfter: new Date(now.getTime() + getRandomBackoffMinutes(input.random) * 60_000).toISOString(),
        retryAfterSource: "random_backoff",
        retryCount: retryCount + 1,
      };
    }
  }
}

/** Patch for a stage error recovery (AIF `processOneTask` catch branch). */
export function recoveryPatch(recovery: ErrorRecovery, stage: StageDefinition): TaskPatch {
  switch (recovery.kind) {
    case "fast_retry":
      return { status: stage.inProgress, blockedReason: null, blockedFromStatus: null, retryAfter: null, lockedBy: null, lockedUntil: null };
    case "blocked_external":
      return {
        status: "blocked_external",
        blockedReason: recovery.blockedReason,
        blockedFromStatus: stage.inProgress,
        retryAfter: recovery.retryAfter,
        retryCount: recovery.retryCount,
        lockedBy: null,
        lockedUntil: null,
      };
    case "revert":
    case "switch_model":
      return { status: stage.inProgress, lockedBy: null, lockedUntil: null };
  }
}
