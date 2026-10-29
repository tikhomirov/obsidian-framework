/**
 * Task service: every read/write of tasks goes through here (single writer, Р-005).
 * HTTP API, MCP and the coordinator all call these methods; each mutation runs
 * under a per-project mutex, writes the `.md` atomically, appends the journal,
 * updates the short «История» and emits a bus event.
 */
import type {
  AuditActor,
  CreateTaskInput,
  HandoffInput,
  JournalEvent,
  JournalRow,
  ParticipantRole,
  Project,
  SyncStatusInput,
  Task,
  TaskAssignee,
  TaskEvent,
  TaskFlagsInput,
  TaskPatch,
  TaskStatus,
} from "@of/core";
import {
  FlagValidationError,
  PRIORITY_MAX_API,
  appendHistory,
  applyPatch,
  checkExpectedStatus,
  createTask,
  decideSyncStatus,
  formatLocalIso,
  formatTaskId,
  historyLine,
  nextTaskNumber,
  resolveHandoff,
  resolveTaskAction,
  resolveTaskPermissions,
  validateMaxReviewIterations,
  validatePriority,
} from "@of/core";
import type { TaskPermissions } from "@of/core";
import type { EventBus } from "./bus.js";
import { KeyedMutex } from "./bus.js";
import type { StoredTask, VaultStore } from "./vault/store.js";

export type ServiceErrorCode =
  | "not_found"
  | "validation"
  | "forbidden"
  | "status_conflict"
  | "action_not_allowed"
  | "reason_required"
  | "task_locked"
  | "ownership_revision_conflict"
  | "inactive_assignee"
  | "invalid_ownership_transition"
  | "ai_handoff_required"
  | "actor_not_authorized"
  | "assignment_required"
  | "blocked_status_missing"
  | "commit_not_found";

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  not_found: 404,
  validation: 400,
  reason_required: 400,
  forbidden: 403,
  actor_not_authorized: 403,
  assignment_required: 403,
  ai_handoff_required: 409,
  status_conflict: 409,
  action_not_allowed: 409,
  task_locked: 409,
  ownership_revision_conflict: 409,
  inactive_assignee: 409,
  invalid_ownership_transition: 409,
  blocked_status_missing: 409,
  commit_not_found: 422,
};

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly httpStatus: number;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

export interface ActorContext {
  actor: AuditActor;
  source: "api" | "mcp" | "worker" | "coordinator";
}

export const COORDINATOR_ACTOR: ActorContext = {
  actor: { kind: "system", id: "coordinator", displayNameSnapshot: "Координатор" },
  source: "coordinator",
};

export interface Mutation {
  patch: TaskPatch;
  action: string;
  reason?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  /** Default true. Heartbeats are not journaled. */
  journal?: boolean | undefined;
  /** Force a line in «История» even without a status/owner change (e.g. model switch). */
  history?: boolean | undefined;
}

export interface UpdateTaskInput extends TaskFlagsInput {
  title?: string | undefined;
  description?: string | undefined;
  plan?: string | undefined;
  implementationLog?: string | undefined;
  reviewComments?: string | undefined;
  tags?: string[] | undefined;
  roadmap?: string | null | undefined;
  position?: number | undefined;
  scheduledAt?: string | null | undefined;
  modelOverride?: string | null | undefined;
  planPath?: string | null | undefined;
  branch?: string | null | undefined;
  blockedReason?: string | null | undefined;
}

export interface CommitVerifier {
  /** true when `sha` exists in the remote repo and is contained in `branch`. */
  verify(project: Project, sha: string, branch: string): Promise<boolean>;
}

export interface ServiceOptions {
  store: VaultStore;
  bus: EventBus;
  participants: TaskAssignee[];
  tzOffsetMinutes: number;
  useSubagentsDefault: boolean;
  now?: () => Date;
  commitVerifier?: CommitVerifier | null;
}

export interface TaskView extends Task {
  archived: boolean;
  permissions: TaskPermissions;
}

export class TaskService {
  private readonly store: VaultStore;
  private readonly bus: EventBus;
  private readonly participants: TaskAssignee[];
  private readonly tz: number;
  private readonly useSubagentsDefault: boolean;
  private readonly now: () => Date;
  private readonly commitVerifier: CommitVerifier | null;
  private readonly mutex = new KeyedMutex();

  constructor(opts: ServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.participants = opts.participants;
    this.tz = opts.tzOffsetMinutes;
    this.useSubagentsDefault = opts.useSubagentsDefault;
    this.now = opts.now ?? (() => new Date());
    this.commitVerifier = opts.commitVerifier ?? null;
  }

  clock(): Date {
    return this.now();
  }

  participant(id: string): TaskAssignee | null {
    return this.participants.find((p) => p.participantId === id) ?? null;
  }

  listParticipants(): TaskAssignee[] {
    return [...this.participants];
  }

  private actionContext(ctx: ActorContext): {
    participantsModeEnabled: boolean;
    actor: AuditActor;
    participantRole: ParticipantRole | null;
    participantActive: boolean;
  } {
    const p = ctx.actor.kind === "participant" && ctx.actor.id !== null ? this.participant(ctx.actor.id) : null;
    return {
      participantsModeEnabled: true,
      actor: ctx.actor,
      participantRole: p?.role ?? null,
      participantActive: p?.active ?? false,
    };
  }

  view(stored: StoredTask, ctx: ActorContext): TaskView {
    return { ...stored.task, archived: stored.archived, permissions: resolveTaskPermissions(stored.task, this.actionContext(ctx)) };
  }

  // ---------------------------------------------------------------- projects

  async listProjects(): Promise<Project[]> {
    return (await this.store.listProjects()).projects;
  }

  async getProject(id: string): Promise<Project> {
    const found = await this.store.readProject(id);
    if (!found) throw new ServiceError("not_found", `Project ${id} not found`);
    return found.project;
  }

  async updateProject(
    id: string,
    patch: Partial<Pick<Project, "autoQueueMode" | "parallelEnabled" | "status" | "title" | "defaultBranch" | "repo">>,
    ctx: ActorContext,
  ): Promise<Project> {
    if (ctx.actor.kind !== "participant" || this.actionContext(ctx).participantRole !== "admin") {
      throw new ServiceError("forbidden", "Only an admin can change project settings");
    }
    return this.mutex.run(id, async () => {
      const found = await this.store.readProject(id);
      if (!found) throw new ServiceError("not_found", `Project ${id} not found`);
      const next: Project = { ...found.project, ...patch, updated: this.now().toISOString() };
      await this.store.writeProject(next, found.text, found.path);
      await this.journal(id, { action: "project.updated", actor: ctx.actor, taskId: null, metadata: { fields: Object.keys(patch) } });
      this.emit("project.changed", id, null, {});
      return next;
    });
  }

  // ------------------------------------------------------------------- reads

  async listTasks(project: string, opts: { includeArchived?: boolean; status?: TaskStatus | undefined } = {}): Promise<StoredTask[]> {
    await this.getProject(project);
    const { tasks } = await this.store.listTasks(project, opts.includeArchived ?? false);
    return tasks
      .filter((t) => opts.status === undefined || t.task.status === opts.status)
      .sort((a, b) => a.task.position - b.task.position || a.task.created.localeCompare(b.task.created) || a.task.id.localeCompare(b.task.id));
  }

  async listAllActive(): Promise<{ project: Project; tasks: StoredTask[] }[]> {
    const out: { project: Project; tasks: StoredTask[] }[] = [];
    for (const project of await this.listProjects()) {
      if (project.status !== "active") continue;
      out.push({ project, tasks: (await this.store.listTasks(project.id, false)).tasks });
    }
    return out;
  }

  async searchTasks(query: string, opts: { project?: string | undefined; limit?: number; includeArchived?: boolean } = {}): Promise<StoredTask[]> {
    const q = query.trim().toLowerCase();
    if (!q) throw new ServiceError("validation", "query is required");
    const projects = opts.project !== undefined ? [await this.getProject(opts.project)] : await this.listProjects();
    const hits: StoredTask[] = [];
    for (const project of projects) {
      const { tasks } = await this.store.listTasks(project.id, opts.includeArchived ?? true);
      for (const t of tasks) {
        const hay = [t.task.id, t.task.title, t.task.description, t.task.tags.join(" "), ...t.task.aliases].join("\n").toLowerCase();
        if (hay.includes(q)) hits.push(t);
      }
    }
    return hits.slice(0, opts.limit ?? 50);
  }

  async getTask(project: string, id: string): Promise<StoredTask> {
    await this.getProject(project);
    const found = await this.store.readTask(project, id);
    if (!found) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return found;
  }

  async history(project: string, id: string): Promise<JournalRow[]> {
    await this.getTask(project, id);
    return (await this.store.readJournal(project)).filter((row) => row.taskId === id);
  }

  async projectJournal(project: string): Promise<JournalRow[]> {
    await this.getProject(project);
    return this.store.readJournal(project);
  }

  // ------------------------------------------------------------------ create

  async createTask(project: string, input: CreateTaskInput, ctx: ActorContext, priorityMax = PRIORITY_MAX_API): Promise<StoredTask> {
    return this.mutex.run(project, async () => {
      const found = await this.store.readProject(project);
      if (!found) throw new ServiceError("not_found", `Project ${project} not found`);
      const { tasks } = await this.store.listTasks(project, true);
      const n = nextTaskNumber(found.project.nextTaskNumber, tasks.map((t) => t.task.id));
      const id = formatTaskId(n);
      const nowIso = this.now().toISOString();
      let task: Task;
      try {
        task = createTask(
          { ...input, position: input.position ?? (tasks.reduce((m, t) => Math.max(m, t.task.position), 0) + 1) },
          { project, id },
          { parallelEnabled: found.project.parallelEnabled, useSubagentsDefault: this.useSubagentsDefault },
          nowIso,
          priorityMax,
        );
      } catch (err) {
        throw toValidation(err);
      }
      const event = this.event(ctx.actor, "task.created", id, null, task.status, null, task, { title: task.title });
      task = { ...task, history: appendHistory(task.history, historyLine(event)) };
      // Counter first: a crash after this leaves a gap, never a duplicate id.
      await this.store.writeProject({ ...found.project, nextTaskNumber: n + 1, updated: nowIso }, found.text, found.path);
      const stored = await this.store.writeTask(task, null);
      await this.store.appendJournal(project, event, this.now());
      this.emit("task.created", project, id, { status: task.status });
      return stored;
    });
  }

  // ----------------------------------------------------------------- updates

  /** Generic mutation under the project lock; `fn` sees the fresh task. Returns null when `fn` returned null. */
  async mutate(project: string, id: string, ctx: ActorContext, fn: (stored: StoredTask) => Mutation | null): Promise<StoredTask | null> {
    return this.mutex.run(project, async () => {
      const stored = await this.store.readTask(project, id);
      if (!stored) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
      const m = fn(stored);
      if (m === null) return null;
      const now = this.now();
      let next = applyPatch(stored.task, m.patch, now.toISOString());
      const statusChanged = next.status !== stored.task.status;
      const ownerChanged = next.executionOwner !== stored.task.executionOwner;
      const doJournal = m.journal ?? true;
      let event: JournalEvent | null = null;
      if (doJournal) {
        event = this.event(ctx.actor, m.action, id, stored.task.status, next.status, m.reason ?? null, next, m.metadata ?? null);
        if (statusChanged || ownerChanged || m.history === true) next = { ...next, history: appendHistory(next.history, historyLine(event)) };
      }
      const written = await this.store.writeTask(next, stored);
      if (event) await this.store.appendJournal(project, event, now);
      if (doJournal) this.emit("task.changed", project, id, { status: next.status, action: m.action });
      return written;
    });
  }

  async updateTask(project: string, id: string, input: UpdateTaskInput, ctx: ActorContext, priorityMax = PRIORITY_MAX_API): Promise<StoredTask> {
    const patch: TaskPatch = {};
    try {
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new ServiceError("validation", "title must not be empty");
        patch.title = title;
      }
      if (input.priority !== undefined) patch.priority = validatePriority(input.priority, priorityMax);
      if (input.maxReviewIterations !== undefined) patch.maxReviewIterations = validateMaxReviewIterations(input.maxReviewIterations);
    } catch (err) {
      throw toValidation(err);
    }
    if (input.scheduledAt !== undefined && input.scheduledAt !== null && !Number.isFinite(Date.parse(input.scheduledAt))) {
      throw new ServiceError("validation", "scheduledAt must be an ISO timestamp");
    }
    const copy = [
      "description", "plan", "implementationLog", "reviewComments", "tags", "roadmap", "position", "scheduledAt",
      "modelOverride", "planPath", "branch", "blockedReason", "autoMode", "plannerMode", "skipReview", "planDocs", "planTests",
      "runPlanImprove", "runPostVerify", "useSubagents", "isFix", "autoQa", "autoQaCheck", "paused", "runtimeProfile",
    ] as const;
    for (const key of copy) {
      const value = input[key];
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }
    if (patch.useSubagents === true) {
      patch.runPlanImprove = false;
      patch.runPostVerify = false;
    }
    const fields = Object.keys(patch);
    if (fields.length === 0) throw new ServiceError("validation", "Nothing to update");
    const result = await this.mutate(project, id, ctx, (stored) => {
      if (ctx.actor.kind === "agent" && stored.task.executionOwner !== "ai" && ctx.source !== "worker") {
        throw new ServiceError("ai_handoff_required", "Task is owned by a human");
      }
      return { patch, action: "task.updated", metadata: { fields } };
    });
    /* v8 ignore next */
    if (!result) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return result;
  }

  async applyEvent(
    project: string,
    id: string,
    event: TaskEvent,
    ctx: ActorContext,
    opts: { reason?: string | null | undefined; expectedStatus?: TaskStatus | undefined; requireReason?: boolean } = {},
  ): Promise<StoredTask> {
    const reason = opts.reason?.trim() ?? "";
    if (opts.requireReason && !reason) throw new ServiceError("reason_required", "A reason is required for manual moves (Р-017)");
    const result = await this.mutate(project, id, ctx, (stored) => {
      if (!checkExpectedStatus(stored.task, opts.expectedStatus)) {
        throw new ServiceError("status_conflict", `Task is '${stored.task.status}', expected '${String(opts.expectedStatus)}'`);
      }
      const decision = resolveTaskAction(stored.task, event, this.actionContext(ctx));
      if (!decision.ok) throw new ServiceError(decision.code, decision.error);
      const patch: TaskPatch = { ...decision.patch, lockedBy: null, lockedUntil: null };
      if (event === "request_changes") patch.commitSha = null;
      return { patch, action: `task.event.${event}`, reason: reason || null, metadata: { event } };
    });
    /* v8 ignore next */
    if (!result) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return result;
  }

  async handoff(project: string, id: string, input: HandoffInput, ctx: ActorContext): Promise<StoredTask> {
    const result = await this.mutate(project, id, ctx, (stored) => {
      const role = this.actionContext(ctx).participantRole;
      const isAdmin = role === "admin";
      const assignedHuman =
        stored.task.executionOwner === "human" && stored.task.assignees.some((a) => a.participantId === ctx.actor.id);
      if (ctx.source !== "coordinator" && ctx.actor.kind === "participant" && !isAdmin && !assignedHuman) {
        throw new ServiceError("forbidden", "Only an admin or the assignee can hand off this task");
      }
      const decision = resolveHandoff(stored.task, input, (pid) => this.participant(pid), this.now());
      if (!decision.ok) {
        throw new ServiceError(decision.code === "task_not_found" ? "not_found" : decision.code, decision.message);
      }
      const patch = { ...decision.patch };
      if (input.allowLockedBy !== undefined && stored.task.lockedBy === input.allowLockedBy) {
        patch.lockedBy = null;
        patch.lockedUntil = null;
      }
      return {
        patch,
        action: "task.handoff",
        reason: input.reason ?? null,
        metadata: { to: input.executionOwner, assignees: input.assigneeIds, resumeAction: input.resumeAction ?? null },
      };
    });
    /* v8 ignore next */
    if (!result) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return result;
  }

  async syncStatus(
    project: string,
    id: string,
    input: SyncStatusInput,
    ctx: ActorContext,
  ): Promise<{ applied: boolean; conflict: boolean; reason: string | null; task: StoredTask }> {
    let outcome: { applied: boolean; conflict: boolean; reason: string | null } = { applied: false, conflict: false, reason: null };
    const written = await this.mutate(project, id, ctx, (stored) => {
      const decision = decideSyncStatus(stored.task, input, ctx.actor.kind === "agent", this.now().toISOString());
      if (!decision.applied) {
        outcome = { applied: false, conflict: decision.conflict, reason: decision.reason };
        return null;
      }
      outcome = { applied: true, conflict: false, reason: null };
      return { patch: decision.patch, action: "task.sync_status", metadata: { direction: input.direction } };
    });
    return { ...outcome, task: written ?? (await this.getTask(project, id)) };
  }

  async pushPlan(project: string, id: string, plan: string, ctx: ActorContext): Promise<StoredTask> {
    const result = await this.mutate(project, id, ctx, (stored) => {
      if (ctx.actor.kind === "agent" && stored.task.executionOwner !== "ai") {
        throw new ServiceError("ai_handoff_required", "Task is owned by a human");
      }
      return { patch: { plan }, action: "task.plan_pushed", metadata: { length: plan.length } };
    });
    /* v8 ignore next */
    if (!result) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return result;
  }

  /** AIF `handoff_annotate_plan`: append content under a heading of the plan (created when missing). */
  async annotatePlan(project: string, id: string, content: string, heading: string | null, ctx: ActorContext): Promise<StoredTask> {
    const text = content.trim();
    if (!text) throw new ServiceError("validation", "planContent is required");
    const title = (heading ?? "Annotations").replace(/^#+\s*/, "").trim() || "Annotations";
    const result = await this.mutate(project, id, ctx, (stored) => {
      if (ctx.actor.kind === "agent" && stored.task.executionOwner !== "ai") {
        throw new ServiceError("ai_handoff_required", "Task is owned by a human");
      }
      return { patch: { plan: insertUnderHeading(stored.task.plan, title, text) }, action: "task.plan_annotated", metadata: { heading: title } };
    });
    /* v8 ignore next */
    if (!result) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
    return result;
  }

  /** Manual mode (spec 3.7): every MCP call of the worker refreshes the heartbeat. */
  async touch(project: string, id: string, ctx: ActorContext): Promise<void> {
    const nowIso = this.now().toISOString();
    await this.mutate(project, id, ctx, (stored) =>
      stored.task.executionOwner === "ai" ? { patch: { lastHeartbeatAt: nowIso }, action: "task.heartbeat", journal: false } : null,
    ).catch(() => null);
  }

  /** Record a commit (spec 3.6): verified in the server clone unless `verified` is passed. */
  async addCommit(project: string, id: string, sha: string, branch: string, ctx: ActorContext): Promise<StoredTask> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new ServiceError("validation", "sha must be a hex commit id");
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) throw new ServiceError("validation", "invalid branch name");
    const projectInfo = await this.getProject(project);
    if (this.commitVerifier && !(await this.commitVerifier.verify(projectInfo, sha, branch))) {
      throw new ServiceError("commit_not_found", `Commit ${sha} is not in remote branch ${branch}`);
    }
    const at = this.now().toISOString();
    const result = await this.mutate(project, id, ctx, (stored) => {
      if (stored.task.commits.some((c) => c.sha === sha)) {
        return stored.task.commitSha === sha ? null : { patch: { commitSha: sha, branch }, action: "task.commit_added", metadata: { sha, branch } };
      }
      return {
        patch: { commitSha: sha, branch, commits: [...stored.task.commits, { sha, branch, at }] },
        action: "task.commit_added",
        metadata: { sha, branch },
      };
    });
    return result ?? (await this.getTask(project, id));
  }

  async setArchived(project: string, id: string, archived: boolean, ctx: ActorContext, reason: string | null = null): Promise<StoredTask> {
    return this.mutex.run(project, async () => {
      const stored = await this.store.readTask(project, id);
      if (!stored) throw new ServiceError("not_found", `Task ${project}/${id} not found`);
      if (stored.archived === archived) return stored;
      if (archived && stored.task.status !== "verified" && stored.task.status !== "done" && stored.task.status !== "backlog") {
        throw new ServiceError("action_not_allowed", "Only backlog, done or verified tasks can be archived");
      }
      const moved = await this.store.setArchived(stored, archived);
      const action = archived ? "task.archived" : "task.restored";
      const event = this.event(ctx.actor, action, id, stored.task.status, stored.task.status, reason, stored.task, null);
      const next = { ...moved.task, history: appendHistory(moved.task.history, historyLine(event)), updated: this.now().toISOString() };
      const written = await this.store.writeTask(next, moved);
      await this.store.appendJournal(project, event, this.now());
      this.emit("task.archived", project, id, { archived });
      return written;
    });
  }

  async heartbeat(project: string, id: string, ctx: ActorContext, lockTtlMs: number): Promise<StoredTask | null> {
    const now = this.now();
    return this.mutate(project, id, ctx, (stored) =>
      stored.task.lockedBy === null
        ? null
        : {
            patch: { lastHeartbeatAt: now.toISOString(), lockedUntil: new Date(now.getTime() + lockTtlMs).toISOString() },
            action: "task.heartbeat",
            journal: false,
          },
    );
  }

  /** Journal-only event (e.g. `task.waiting_worker`, `task.model_switched`). */
  async note(project: string, taskId: string | null, ctx: ActorContext, action: string, reason: string | null, metadata: Record<string, unknown> | null): Promise<void> {
    await this.mutex.run(project, async () => {
      await this.journal(project, { action, actor: ctx.actor, taskId, reason, metadata });
    });
    this.emit("task.changed", project, taskId, { action });
  }

  emitRaw(type: "models.changed" | "worker.status", data: Record<string, unknown>): void {
    this.emit(type, null, null, data);
  }

  // ----------------------------------------------------------------- helpers

  private event(
    actor: AuditActor,
    action: string,
    taskId: string | null,
    from: TaskStatus | null,
    to: TaskStatus | null,
    reason: string | null,
    task: Task | null,
    metadata: Record<string, unknown> | null,
  ): JournalEvent {
    return {
      at: formatLocalIso(this.now(), this.tz),
      actor,
      action,
      taskId,
      from,
      to,
      reason,
      ownershipRevision: task?.ownershipRevision ?? null,
      executionOwner: task?.executionOwner ?? null,
      metadata,
    };
  }

  private async journal(
    project: string,
    e: { action: string; actor: AuditActor; taskId: string | null; reason?: string | null; metadata?: Record<string, unknown> | null },
  ): Promise<void> {
    await this.store.appendJournal(project, this.event(e.actor, e.action, e.taskId, null, null, e.reason ?? null, null, e.metadata ?? null), this.now());
  }

  private emit(type: "task.changed" | "task.created" | "task.archived" | "project.changed" | "models.changed" | "worker.status", project: string | null, taskId: string | null, data: Record<string, unknown>): void {
    this.bus.emit({ type, project, taskId, data, at: this.now().toISOString() });
  }
}

export function insertUnderHeading(plan: string, heading: string, text: string): string {
  const lines = plan.split("\n");
  const idx = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading);
  if (idx < 0) return `${plan.trimEnd()}${plan.trim() ? "\n\n" : ""}## ${heading}\n\n${text}\n`;
  const level = (/^#+/.exec(lines[idx] ?? "") ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? "");
    if (m?.[1] && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, end);
  while (before.length > idx + 1 && (before[before.length - 1] ?? "").trim() === "") before.pop();
  const after = lines.slice(end);
  return [...before, "", text, ...(after.length ? ["", ...after] : [""])].join("\n");
}

function toValidation(err: unknown): Error {
  if (err instanceof ServiceError) return err;
  if (err instanceof FlagValidationError || err instanceof RangeError) return new ServiceError("validation", err.message);
  /* v8 ignore next */
  return err instanceof Error ? err : new Error(String(err));
}
