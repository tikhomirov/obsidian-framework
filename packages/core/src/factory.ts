import type { FlagContext, TaskFlagsInput } from "./flags.js";
import { PRIORITY_MAX_API, resolveTaskFlags } from "./flags.js";
import type { Task } from "./types.js";

export interface CreateTaskInput extends TaskFlagsInput {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  roadmap?: string | null | undefined;
  scheduledAt?: string | null | undefined;
  modelOverride?: string | null | undefined;
  plan?: string | undefined;
  position?: number | undefined;
}

/** New task in `backlog`, `execution_owner: ai` (spec 10), flags with AIF defaults. */
export function createTask(
  input: CreateTaskInput,
  ref: { project: string; id: string },
  context: FlagContext,
  nowIso: string,
  priorityMax: number = PRIORITY_MAX_API,
): Task {
  const title = input.title.trim();
  if (!title) throw new RangeError("title is required");
  const flags = resolveTaskFlags(input, context, priorityMax);
  return {
    id: ref.id,
    project: ref.project,
    title,
    aliases: [title],
    status: "backlog",
    priority: flags.priority,
    position: input.position ?? 0,
    tags: input.tags ?? [],
    roadmap: input.roadmap ?? null,
    dependsOn: [],
    affects: [],
    implements: [],
    verifies: [],
    documents: [],
    supersedes: [],
    owners: [],
    executionOwner: "ai",
    assignees: [],
    ownershipRevision: 0,
    autoMode: flags.autoMode,
    plannerMode: flags.plannerMode,
    skipReview: flags.skipReview,
    planDocs: flags.planDocs,
    planTests: flags.planTests,
    runPlanImprove: flags.runPlanImprove,
    runPostVerify: flags.runPostVerify,
    useSubagents: flags.useSubagents,
    maxReviewIterations: flags.maxReviewIterations,
    isFix: flags.isFix,
    autoQa: flags.autoQa,
    autoQaCheck: flags.autoQaCheck,
    paused: flags.paused,
    scheduledAt: input.scheduledAt ?? null,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    reworkRequested: false,
    reviewIterationCount: 0,
    manualReviewRequired: false,
    autoReviewState: null,
    lockedBy: null,
    lockedUntil: null,
    lastHeartbeatAt: null,
    stageStartedAt: null,
    lastSyncedAt: null,
    runtimeProfile: flags.runtimeProfile,
    modelOverride: input.modelOverride ?? null,
    planPath: null,
    branch: null,
    commitSha: null,
    commits: [],
    created: nowIso,
    updated: nowIso,
    description: input.description ?? "",
    plan: input.plan ?? "",
    implementationLog: "",
    reviewComments: "",
    history: "",
  };
}

export function applyPatch(task: Task, patch: Partial<Task>, nowIso: string): Task {
  return { ...task, ...patch, updated: nowIso };
}
