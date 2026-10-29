/** Input schemas shared by the HTTP API and MCP tools. */
import { z } from "zod";
import { EXECUTION_OWNERS, PLANNER_MODES, RUNTIME_PROFILES, TASK_EVENTS, TASK_STATUSES } from "@of/core";

export const statusSchema = z.enum(TASK_STATUSES);
export const eventSchema = z.enum(TASK_EVENTS);
const iso = z.string().refine((v) => Number.isFinite(Date.parse(v)), "must be an ISO timestamp");

export const flagsShape = {
  autoMode: z.boolean().optional(),
  plannerMode: z.enum(PLANNER_MODES).optional(),
  skipReview: z.boolean().optional(),
  planDocs: z.boolean().optional(),
  planTests: z.boolean().optional(),
  runPlanImprove: z.boolean().optional(),
  runPostVerify: z.boolean().optional(),
  useSubagents: z.boolean().optional(),
  maxReviewIterations: z.number().int().optional(),
  isFix: z.boolean().optional(),
  autoQa: z.boolean().optional(),
  autoQaCheck: z.boolean().optional(),
  paused: z.boolean().optional(),
  priority: z.number().int().optional(),
  runtimeProfile: z.enum(RUNTIME_PROFILES).optional(),
};

const modelRef = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+(#[A-Za-z0-9._-]+)?$/, "must be provider/model");

export const createTaskShape = {
  title: z.string().min(1).max(300),
  description: z.string().max(100_000).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  roadmap: z.string().max(300).nullable().optional(),
  scheduledAt: iso.nullable().optional(),
  modelOverride: modelRef.nullable().optional(),
  plan: z.string().max(500_000).optional(),
  position: z.number().optional(),
  /** AIF names: runtime profile id (`opencode` | `pi`), runtime options (accepted, not used). */
  runtimeProfileId: z.enum(RUNTIME_PROFILES).optional(),
  runtimeOptions: z.record(z.unknown()).optional(),
  ...flagsShape,
};

export const updateTaskShape = {
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  plan: z.string().max(500_000).optional(),
  implementationLog: z.string().max(500_000).optional(),
  reviewComments: z.string().max(500_000).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  roadmap: z.string().max(300).nullable().optional(),
  position: z.number().optional(),
  scheduledAt: iso.nullable().optional(),
  modelOverride: modelRef.nullable().optional(),
  roadmapAlias: z.string().max(300).nullable().optional(),
  blockedReason: z.string().max(2000).nullable().optional(),
  runtimeProfileId: z.enum(RUNTIME_PROFILES).optional(),
  runtimeOptions: z.record(z.unknown()).optional(),
  ...flagsShape,
};

/** Map AIF field names onto ours (`runtimeProfileId` → `runtimeProfile`, `roadmapAlias` → `roadmap`). */
export function fromAif<T extends { runtimeProfileId?: (typeof RUNTIME_PROFILES)[number] | undefined; runtimeOptions?: unknown; roadmapAlias?: string | null | undefined; runtimeProfile?: (typeof RUNTIME_PROFILES)[number] | undefined; roadmap?: string | null | undefined }>(
  input: T,
): Omit<T, "runtimeProfileId" | "runtimeOptions" | "roadmapAlias"> {
  const { runtimeProfileId, roadmapAlias, ...rest } = input;
  delete (rest as { runtimeOptions?: unknown }).runtimeOptions;
  const out = { ...rest } as Omit<T, "runtimeProfileId" | "runtimeOptions" | "roadmapAlias"> & { runtimeProfile?: unknown; roadmap?: unknown };
  if (runtimeProfileId !== undefined && out.runtimeProfile === undefined) out.runtimeProfile = runtimeProfileId;
  if (roadmapAlias !== undefined && out.roadmap === undefined) out.roadmap = roadmapAlias;
  return out;
}

export const eventBodyShape = {
  reason: z.string().max(2000).nullable().optional(),
  expectedStatus: statusSchema.optional(),
};

export const planShape = { planContent: z.string().max(100 * 1024) };

export const annotateShape = { planContent: z.string().min(1).max(100 * 1024), sectionHeading: z.string().max(200).optional() };

export const reasonShape = { reason: z.string().max(2000).nullable().optional() };

export const handoffShape = {
  executionOwner: z.enum(EXECUTION_OWNERS),
  assigneeIds: z.array(z.string()).max(20).default([]),
  expectedOwnershipRevision: z.number().int().min(0),
  expectedExecutionOwner: z.enum(EXECUTION_OWNERS).optional(),
  expectedStatus: statusSchema.optional(),
  reason: z.string().max(2000).nullable().optional(),
  resumeAction: eventSchema.optional(),
};

export const syncShape = {
  newStatus: statusSchema,
  sourceTimestamp: z.string(),
  direction: z.enum(["aif_to_handoff", "handoff_to_aif"]).default("aif_to_handoff"),
  paused: z.boolean().optional(),
};

export const commitShape = {
  sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
  branch: z.string().min(1).max(200),
};

export const projectPatchShape = {
  title: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  autoQueueMode: z.boolean().optional(),
  parallelEnabled: z.boolean().optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  repo: z.string().max(500).optional(),
};

export const modelsResetShape = { model: z.string().min(1) };

/** Drop `undefined` keys (exactOptionalPropertyTypes friendly). */
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Compact<T>;
}
