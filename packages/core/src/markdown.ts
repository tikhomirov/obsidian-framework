/**
 * `TASK-NNN.md` and `Проект.md` ↔ domain objects. Frontmatter keys follow spec section 4.
 * Unknown keys and key order are preserved on rewrite.
 */
import { Document, isMap, parseDocument } from "yaml";
import type { AutoReviewState, CommitRef, Project, Task, TaskAssignee, TaskStatus } from "./types.js";
import { EXECUTION_OWNERS, PLANNER_MODES, RUNTIME_PROFILES, TASK_STATUSES } from "./types.js";

export class TaskFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFormatError";
  }
}

export const BODY_SECTIONS = {
  description: "Описание",
  plan: "План",
  implementationLog: "Лог выполнения",
  reviewComments: "Замечания ревью",
  history: "История",
} as const;
type BodyKey = keyof typeof BODY_SECTIONS;
const BODY_KEYS = Object.keys(BODY_SECTIONS) as BodyKey[];

type FieldKind = "string" | "nullableString" | "number" | "boolean" | "stringList" | "json" | "status" | "nullableStatus" | "owner" | "plannerMode" | "runtimeProfile";

/** Domain field → frontmatter key (order = order in a new file). */
const TASK_FIELDS: readonly (readonly [Exclude<keyof Task, BodyKey | "project">, string, FieldKind])[] = [
  ["id", "id", "string"],
  ["title", "title", "string"],
  ["aliases", "aliases", "stringList"],
  ["status", "status", "status"],
  ["priority", "priority", "number"],
  ["position", "position", "number"],
  ["tags", "tags", "stringList"],
  ["roadmap", "roadmap", "nullableString"],
  ["dependsOn", "depends_on", "stringList"],
  ["affects", "affects", "stringList"],
  ["implements", "implements", "stringList"],
  ["verifies", "verifies", "stringList"],
  ["documents", "documents", "stringList"],
  ["supersedes", "supersedes", "stringList"],
  ["owners", "owners", "stringList"],
  ["executionOwner", "execution_owner", "owner"],
  ["assignees", "assignees", "json"],
  ["ownershipRevision", "ownership_revision", "number"],
  ["autoMode", "auto_mode", "boolean"],
  ["plannerMode", "planner_mode", "plannerMode"],
  ["skipReview", "skip_review", "boolean"],
  ["planDocs", "plan_docs", "boolean"],
  ["planTests", "plan_tests", "boolean"],
  ["runPlanImprove", "run_plan_improve", "boolean"],
  ["runPostVerify", "run_post_verify", "boolean"],
  ["useSubagents", "use_subagents", "boolean"],
  ["maxReviewIterations", "max_review_iterations", "number"],
  ["isFix", "is_fix", "boolean"],
  ["autoQa", "auto_qa", "boolean"],
  ["autoQaCheck", "auto_qa_check", "boolean"],
  ["paused", "paused", "boolean"],
  ["scheduledAt", "scheduled_at", "nullableString"],
  ["blockedReason", "blocked_reason", "nullableString"],
  ["blockedFromStatus", "blocked_from", "nullableStatus"],
  ["retryAfter", "retry_after", "nullableString"],
  ["retryCount", "retry_count", "number"],
  ["reworkRequested", "rework_requested", "boolean"],
  ["reviewIterationCount", "review_iteration_count", "number"],
  ["manualReviewRequired", "manual_review_required", "boolean"],
  ["autoReviewState", "auto_review_state", "json"],
  ["lockedBy", "locked_by", "nullableString"],
  ["lockedUntil", "locked_until", "nullableString"],
  ["lastHeartbeatAt", "last_heartbeat_at", "nullableString"],
  ["stageStartedAt", "stage_started_at", "nullableString"],
  ["lastSyncedAt", "last_synced_at", "nullableString"],
  ["runtimeProfile", "runtime_profile", "runtimeProfile"],
  ["modelOverride", "model_override", "nullableString"],
  ["planPath", "plan_path", "nullableString"],
  ["branch", "branch", "nullableString"],
  ["commitSha", "commit_sha", "nullableString"],
  ["commits", "commits", "json"],
  ["created", "created", "string"],
  ["updated", "updated", "string"],
];

export interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
  doc: Document;
}

export function splitFrontmatter(text: string): ParsedMarkdown {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new TaskFormatError("Missing frontmatter");
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) throw new TaskFormatError("Unterminated frontmatter");
  const yamlText = end >= 4 ? normalized.slice(4, end + 1) : "";
  const afterFence = normalized.slice(end + 4);
  const body = afterFence.startsWith("\n") ? afterFence.slice(1) : afterFence;
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) throw new TaskFormatError(`Bad frontmatter: ${doc.errors[0]?.message ?? "yaml error"}`);
  const data: unknown = doc.toJS() ?? {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new TaskFormatError("Frontmatter must be a mapping");
  return { data: data as Record<string, unknown>, body, doc };
}

function readField(data: Record<string, unknown>, key: string, kind: FieldKind): unknown {
  const v = data[key];
  switch (kind) {
    case "string":
      if (typeof v === "string") return v;
      if (typeof v === "number") return String(v);
      throw new TaskFormatError(`Field ${key} must be a string`);
    case "nullableString":
      if (v === undefined || v === null || v === "") return null;
      if (typeof v === "string" || typeof v === "number") return String(v);
      throw new TaskFormatError(`Field ${key} must be a string or empty`);
    case "number":
      if (v === undefined || v === null) return undefined;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      throw new TaskFormatError(`Field ${key} must be a number`);
    case "boolean":
      if (v === undefined || v === null) return undefined;
      if (typeof v === "boolean") return v;
      throw new TaskFormatError(`Field ${key} must be true/false`);
    case "stringList":
      if (v === undefined || v === null) return [];
      if (typeof v === "string") return [v];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
      throw new TaskFormatError(`Field ${key} must be a list of strings`);
    case "json":
      return v ?? undefined;
    case "status":
      if (typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v)) return v;
      throw new TaskFormatError(`Field ${key} must be one of ${TASK_STATUSES.join(", ")}`);
    case "nullableStatus":
      if (v === undefined || v === null || v === "") return null;
      if (typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v)) return v;
      throw new TaskFormatError(`Field ${key} must be a status`);
    case "owner":
      if (v === undefined || v === null) return undefined;
      if (typeof v === "string" && (EXECUTION_OWNERS as readonly string[]).includes(v)) return v;
      throw new TaskFormatError(`Field ${key} must be ai or human`);
    case "plannerMode":
      if (v === undefined || v === null) return undefined;
      if (typeof v === "string" && (PLANNER_MODES as readonly string[]).includes(v)) return v;
      throw new TaskFormatError(`Field ${key} must be fast or full`);
    case "runtimeProfile":
      if (v === undefined || v === null || v === "") return undefined;
      if (typeof v === "string" && (RUNTIME_PROFILES as readonly string[]).includes(v)) return v;
      throw new TaskFormatError(`Field ${key} must be opencode or pi`);
  }
}

function isAssignee(v: unknown): v is TaskAssignee {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a["participantId"] === "string" && typeof a["displayName"] === "string" && (a["role"] === "admin" || a["role"] === "member") && typeof a["active"] === "boolean";
}

function isCommit(v: unknown): v is CommitRef {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c["sha"] === "string" && typeof c["branch"] === "string" && typeof c["at"] === "string";
}

function isAutoReviewState(v: unknown): v is AutoReviewState {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (s["strategy"] === "full_re_review" || s["strategy"] === "closure_first") && typeof s["iteration"] === "number" && Array.isArray(s["findings"]);
}

export function parseBody(body: string): Record<BodyKey, string> {
  const result: Record<BodyKey, string> = { description: "", plan: "", implementationLog: "", reviewComments: "", history: "" };
  const headingToKey = new Map<string, BodyKey>(BODY_KEYS.map((k) => [`## ${BODY_SECTIONS[k]}`, k]));
  let current: BodyKey | null = null;
  const buffers = new Map<BodyKey, string[]>();
  const preamble: string[] = [];
  for (const line of body.split("\n")) {
    const key = headingToKey.get(line.trimEnd());
    if (key) {
      current = key;
      buffers.set(key, []);
      continue;
    }
    if (current) buffers.get(current)?.push(line);
    else preamble.push(line);
  }
  for (const [key, lines] of buffers) result[key] = lines.join("\n").trim();
  const pre = preamble.join("\n").trim();
  if (pre && !buffers.has("description")) result.description = pre.replace(/^# .*\n?/, "").trim();
  return result;
}

export function serializeBody(task: Pick<Task, BodyKey | "title">): string {
  const parts = [`# ${task.title}`, ""];
  for (const key of BODY_KEYS) {
    parts.push(`## ${BODY_SECTIONS[key]}`);
    const content = task[key].trim();
    if (content) parts.push(content);
    parts.push("");
  }
  return parts.join("\n");
}

export interface TaskDefaults {
  autoMode: boolean;
  plannerMode: Task["plannerMode"];
  maxReviewIterations: number;
  runtimeProfile: Task["runtimeProfile"];
}

export function parseTaskMarkdown(text: string, project: string): Task {
  const { data, body } = splitFrontmatter(text);
  const out: Record<string, unknown> = { project };
  for (const [field, key, kind] of TASK_FIELDS) out[field] = readField(data, key, kind);
  const sections = parseBody(body);
  const plannerMode = (out["plannerMode"] as Task["plannerMode"] | undefined) ?? "fast";
  const full = plannerMode === "full";
  const num = (k: string, d: number): number => (out[k] as number | undefined) ?? d;
  const bool = (k: string, d: boolean): boolean => (out[k] as boolean | undefined) ?? d;
  const assigneesRaw = out["assignees"];
  const commitsRaw = out["commits"];
  const arsRaw = out["autoReviewState"];
  const title = out["title"] as string;
  const task: Task = {
    id: out["id"] as string,
    project,
    title,
    aliases: (out["aliases"] as string[]).length > 0 ? (out["aliases"] as string[]) : [title],
    status: out["status"] as TaskStatus,
    priority: num("priority", 0),
    position: num("position", 0),
    tags: out["tags"] as string[],
    roadmap: out["roadmap"] as string | null,
    dependsOn: out["dependsOn"] as string[],
    affects: out["affects"] as string[],
    implements: out["implements"] as string[],
    verifies: out["verifies"] as string[],
    documents: out["documents"] as string[],
    supersedes: out["supersedes"] as string[],
    owners: out["owners"] as string[],
    executionOwner: (out["executionOwner"] as Task["executionOwner"] | undefined) ?? "ai",
    assignees: Array.isArray(assigneesRaw) ? assigneesRaw.filter(isAssignee) : [],
    ownershipRevision: num("ownershipRevision", 0),
    autoMode: bool("autoMode", true),
    plannerMode,
    skipReview: bool("skipReview", !full),
    planDocs: bool("planDocs", full),
    planTests: bool("planTests", full),
    runPlanImprove: bool("runPlanImprove", false),
    runPostVerify: bool("runPostVerify", false),
    useSubagents: bool("useSubagents", false),
    maxReviewIterations: num("maxReviewIterations", 3),
    isFix: bool("isFix", false),
    autoQa: bool("autoQa", false),
    autoQaCheck: bool("autoQaCheck", false),
    paused: bool("paused", false),
    scheduledAt: out["scheduledAt"] as string | null,
    blockedReason: out["blockedReason"] as string | null,
    blockedFromStatus: out["blockedFromStatus"] as TaskStatus | null,
    retryAfter: out["retryAfter"] as string | null,
    retryCount: num("retryCount", 0),
    reworkRequested: bool("reworkRequested", false),
    reviewIterationCount: num("reviewIterationCount", 0),
    manualReviewRequired: bool("manualReviewRequired", false),
    autoReviewState: isAutoReviewState(arsRaw) ? arsRaw : null,
    lockedBy: out["lockedBy"] as string | null,
    lockedUntil: out["lockedUntil"] as string | null,
    lastHeartbeatAt: out["lastHeartbeatAt"] as string | null,
    stageStartedAt: out["stageStartedAt"] as string | null,
    lastSyncedAt: out["lastSyncedAt"] as string | null,
    runtimeProfile: (out["runtimeProfile"] as Task["runtimeProfile"] | undefined) ?? "opencode",
    modelOverride: out["modelOverride"] as string | null,
    planPath: out["planPath"] as string | null,
    branch: out["branch"] as string | null,
    commitSha: out["commitSha"] as string | null,
    commits: Array.isArray(commitsRaw) ? commitsRaw.filter(isCommit) : [],
    created: out["created"] as string,
    updated: out["updated"] as string,
    ...sections,
  };
  return task;
}

function yamlValue(task: Task, field: (typeof TASK_FIELDS)[number][0]): unknown {
  return task[field];
}

/**
 * Serialize a task. When `previous` (the current file text) is given, its frontmatter
 * key order and unknown keys are kept; known keys are updated in place.
 */
export function serializeTaskMarkdown(task: Task, previous?: string): string {
  let doc: Document;
  if (previous !== undefined) {
    doc = splitFrontmatter(previous).doc;
  } else {
    doc = new Document({ type: "task" });
  }
  if (!isMap(doc.contents)) doc.contents = doc.createNode({ type: "task" });
  if (!doc.has("type")) doc.set("type", "task");
  for (const [field, key] of TASK_FIELDS) doc.set(key, doc.createNode(yamlValue(task, field)));
  const yamlText = doc.toString({ lineWidth: 0 });
  return `---\n${yamlText}---\n${serializeBody(task)}`;
}

const PROJECT_FIELDS: readonly (readonly [keyof Project, string])[] = [
  ["id", "id"],
  ["title", "title"],
  ["status", "status"],
  ["repo", "repo"],
  ["defaultBranch", "default_branch"],
  ["autoQueueMode", "auto_queue_mode"],
  ["parallelEnabled", "parallel_enabled"],
  ["nextTaskNumber", "next_task_number"],
  ["created", "created"],
  ["updated", "updated"],
];

export function parseProjectMarkdown(text: string): { project: Project; body: string } {
  const { data, body } = splitFrontmatter(text);
  if (data["type"] !== "project") throw new TaskFormatError("Not a project file (type: project)");
  const str = (k: string, d?: string): string => {
    const v = data[k];
    if (typeof v === "string" && v !== "") return v;
    if (d !== undefined) return d;
    throw new TaskFormatError(`Project field ${k} is required`);
  };
  const status = data["status"];
  const next = data["next_task_number"];
  return {
    project: {
      id: str("id"),
      title: str("title", str("id")),
      status: status === "paused" || status === "archived" ? status : "active",
      repo: str("repo", ""),
      defaultBranch: str("default_branch", "main"),
      autoQueueMode: data["auto_queue_mode"] === true,
      parallelEnabled: data["parallel_enabled"] === true,
      nextTaskNumber: typeof next === "number" && Number.isInteger(next) && next > 0 ? next : 1,
      created: str("created", "1970-01-01"),
      updated: str("updated", str("created", "1970-01-01")),
    },
    body,
  };
}

export function serializeProjectMarkdown(project: Project, previous: string): string {
  const { doc, body } = splitFrontmatter(previous);
  for (const [field, key] of PROJECT_FIELDS) doc.set(key, project[field]);
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;
}
