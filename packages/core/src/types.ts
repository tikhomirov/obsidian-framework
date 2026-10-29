/**
 * Core domain types. 1:1 with aif-handoff `packages/shared/src/types.ts`
 * (bf6a8b6) where the spec says so (Р-016); additions are marked.
 */

export const TASK_STATUSES = [
  "backlog",
  "planning",
  "improve",
  "plan_ready",
  "implementing",
  "review",
  "verify",
  "blocked_external",
  "done",
  "verified",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses an agent stage is actively working in (watchdog scope, AIF). */
export const IN_PROGRESS_STATUSES = ["planning", "improve", "implementing", "review", "verify"] as const;
export type InProgressStatus = (typeof IN_PROGRESS_STATUSES)[number];

export const EXECUTION_OWNERS = ["ai", "human"] as const;
export type ExecutionOwner = (typeof EXECUTION_OWNERS)[number];

export const PARTICIPANT_ROLES = ["admin", "member"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const AUDIT_ACTOR_KINDS = ["participant", "agent", "system", "anonymous"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  displayNameSnapshot: string | null;
}

export const TASK_EVENTS = [
  "start_ai",
  "accept_existing_plan",
  "start_human_work",
  "mark_plan_ready",
  "start_implementation",
  "submit_implementation",
  "complete_review",
  "request_review_changes",
  "pass_verification",
  "fail_verification",
  "request_replanning",
  "fast_fix",
  "approve_done",
  "request_changes",
  "retry_from_blocked",
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

export const PLANNER_MODES = ["fast", "full"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];

/** Addition (Р-023): which worker agent implements the task on the PC. */
export const RUNTIME_PROFILES = ["opencode", "pi"] as const;
export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

export const AUTO_REVIEW_STRATEGIES = ["full_re_review", "closure_first"] as const;
export type AutoReviewStrategy = (typeof AUTO_REVIEW_STRATEGIES)[number];

export const AUTO_REVIEW_FINDING_SOURCES = ["code_review", "security_audit", "review_gate"] as const;
export type AutoReviewFindingSource = (typeof AUTO_REVIEW_FINDING_SOURCES)[number];

export interface AutoReviewFinding {
  id: string;
  text: string;
  source: AutoReviewFindingSource;
}

export interface AutoReviewState {
  strategy: AutoReviewStrategy;
  iteration: number;
  findings: AutoReviewFinding[];
}

export interface TaskAssignee {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  active: boolean;
}

export interface CommitRef {
  sha: string;
  branch: string;
  at: string;
}

export interface Task {
  /** `TASK-NNN`, unique inside the project (Р-014, Р-015). */
  id: string;
  project: string;
  title: string;
  aliases: string[];
  status: TaskStatus;
  priority: number;
  position: number;
  tags: string[];
  roadmap: string | null;
  /** ai-factory header links. */
  dependsOn: string[];
  affects: string[];
  implements: string[];
  verifies: string[];
  documents: string[];
  supersedes: string[];
  owners: string[];

  executionOwner: ExecutionOwner;
  assignees: TaskAssignee[];
  ownershipRevision: number;

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
  scheduledAt: string | null;

  blockedReason: string | null;
  blockedFromStatus: TaskStatus | null;
  retryAfter: string | null;
  retryCount: number;

  reworkRequested: boolean;
  reviewIterationCount: number;
  manualReviewRequired: boolean;
  autoReviewState: AutoReviewState | null;

  lockedBy: string | null;
  lockedUntil: string | null;
  lastHeartbeatAt: string | null;
  stageStartedAt: string | null;
  lastSyncedAt: string | null;

  runtimeProfile: RuntimeProfile;
  modelOverride: string | null;
  planPath: string | null;

  branch: string | null;
  commitSha: string | null;
  commits: CommitRef[];

  created: string;
  updated: string;

  /** Body sections (`description`, `plan`, `implementationLog`, `reviewComments` in AIF). */
  description: string;
  plan: string;
  implementationLog: string;
  reviewComments: string;
  history: string;
}

export interface Project {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  repo: string;
  defaultBranch: string;
  autoQueueMode: boolean;
  parallelEnabled: boolean;
  nextTaskNumber: number;
  created: string;
  updated: string;
}

export type TaskPatch = Partial<Omit<Task, "id" | "project" | "created">>;
