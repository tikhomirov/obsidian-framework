import type { PlannerMode, RuntimeProfile } from "./types.js";

/** 1:1 with aif-handoff `plannerDefaults.ts`. */
export interface PlannerFlagDefaults {
  skipReview: boolean;
  planDocs: boolean;
  planTests: boolean;
}

export function defaultsForMode(mode: PlannerMode): PlannerFlagDefaults {
  return mode === "full"
    ? { skipReview: false, planDocs: true, planTests: true }
    : { skipReview: true, planDocs: false, planTests: false };
}

export const MAX_REVIEW_ITERATIONS_DEFAULT = 3;
export const MAX_REVIEW_ITERATIONS_MIN = 1;
export const MAX_REVIEW_ITERATIONS_MAX = 50;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX_API = 5;
export const PRIORITY_MAX_MCP = 3;
export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = "opencode";

export interface TaskFlagsInput {
  autoMode?: boolean | undefined;
  plannerMode?: PlannerMode | undefined;
  skipReview?: boolean | undefined;
  planDocs?: boolean | undefined;
  planTests?: boolean | undefined;
  runPlanImprove?: boolean | undefined;
  runPostVerify?: boolean | undefined;
  useSubagents?: boolean | undefined;
  maxReviewIterations?: number | undefined;
  isFix?: boolean | undefined;
  autoQa?: boolean | undefined;
  autoQaCheck?: boolean | undefined;
  paused?: boolean | undefined;
  priority?: number | undefined;
  runtimeProfile?: RuntimeProfile | undefined;
}

export interface ResolvedTaskFlags {
  autoMode: boolean;
  plannerMode: PlannerMode;
  skipReview: boolean;
  planDocs: boolean;
  planTests: boolean;
  runPlanImprove: boolean;
  runPostVerify: boolean;
  useSubagents: boolean;
  maxReviewIterations: number;
  isFix: boolean;
  autoQa: boolean;
  autoQaCheck: boolean;
  paused: boolean;
  priority: number;
  runtimeProfile: RuntimeProfile;
}

export interface FlagContext {
  /** Project `parallel_enabled`: forces `planner_mode: full` (AIF). */
  parallelEnabled: boolean;
  /** Env `AGENT_USE_SUBAGENTS` default (AIF: false). */
  useSubagentsDefault: boolean;
}

export class FlagValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "FlagValidationError";
    this.field = field;
  }
}

export function validateMaxReviewIterations(value: number): number {
  if (!Number.isInteger(value) || value < MAX_REVIEW_ITERATIONS_MIN || value > MAX_REVIEW_ITERATIONS_MAX) {
    throw new FlagValidationError(
      "maxReviewIterations",
      `maxReviewIterations must be an integer ${String(MAX_REVIEW_ITERATIONS_MIN)}..${String(MAX_REVIEW_ITERATIONS_MAX)}`,
    );
  }
  return value;
}

export function validatePriority(value: number, max: number): number {
  if (!Number.isInteger(value) || value < PRIORITY_MIN || value > max) {
    throw new FlagValidationError("priority", `priority must be an integer ${String(PRIORITY_MIN)}..${String(max)}`);
  }
  return value;
}

/**
 * Resolve task flags with AIF defaults (spec section 2):
 * - planner mode `fast` unless set; `parallel_enabled` forces `full`;
 * - skip_review / plan_docs / plan_tests follow the mode unless set explicitly;
 * - `use_subagents` forces `run_plan_improve` and `run_post_verify` off.
 */
export function resolveTaskFlags(
  input: TaskFlagsInput,
  context: FlagContext,
  priorityMax: number = PRIORITY_MAX_API,
): ResolvedTaskFlags {
  const plannerMode: PlannerMode = context.parallelEnabled ? "full" : (input.plannerMode ?? "fast");
  const modeDefaults = defaultsForMode(plannerMode);
  const useSubagents = input.useSubagents ?? context.useSubagentsDefault;
  return {
    autoMode: input.autoMode ?? true,
    plannerMode,
    skipReview: input.skipReview ?? modeDefaults.skipReview,
    planDocs: input.planDocs ?? modeDefaults.planDocs,
    planTests: input.planTests ?? modeDefaults.planTests,
    runPlanImprove: useSubagents ? false : (input.runPlanImprove ?? false),
    runPostVerify: useSubagents ? false : (input.runPostVerify ?? false),
    useSubagents,
    maxReviewIterations: validateMaxReviewIterations(input.maxReviewIterations ?? MAX_REVIEW_ITERATIONS_DEFAULT),
    isFix: input.isFix ?? false,
    autoQa: input.autoQa ?? false,
    autoQaCheck: input.autoQaCheck ?? false,
    paused: input.paused ?? false,
    priority: validatePriority(input.priority ?? 0, priorityMax),
    runtimeProfile: input.runtimeProfile ?? DEFAULT_RUNTIME_PROFILE,
  };
}
