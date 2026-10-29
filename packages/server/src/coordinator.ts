/**
 * Coordinator (spec 3.5–3.8, AIF `agent/src/coordinator.ts` + watchdog):
 * one loop over active projects → system transitions → stage candidates →
 * runners (Pi on the server, of-worker on the PC over ssh).
 */
import type { ModelsConfig, Project, RuntimeProfile, StageDefinition, StageError, Task, TaskPatch, WatchdogConfig } from "@of/core";
import {
  PIPELINE,
  branchNameFor,
  getStage,
  classifyStageError,
  completeStage,
  evaluateReview,
  fireScheduled,
  getRandomBackoffMinutes,
  isStageCandidate,
  markModelUnavailable,
  pickAutoQueueTasks,
  pruneModelsState,
  recoverStale,
  recoveryPatch,
  releaseDueBlocked,
  selectStageCandidates,
  selectModel,
  shouldAutoArchive,
  shouldReleaseClaim,
  startStagePatch,
} from "@of/core";
import type { SystemTransition } from "@of/core";
import type { StageRunResult, StageRunner, WorkerProbe } from "./runners/types.js";
import type { ActorContext, TaskService } from "./service.js";
import { COORDINATOR_ACTOR, ServiceError } from "./service.js";
import type { StoredTask, VaultStore } from "./vault/store.js";

export interface WorkspaceGit {
  prepareWorktree(project: Project, branch: string | null): Promise<{ dir: string; ref: string }>;
  readFile(project: Project, relPath: string): Promise<string | null>;
  writeFile(project: Project, relPath: string, text: string): Promise<void>;
}

export interface CoordinatorOptions {
  service: TaskService;
  store: VaultStore;
  pi: StageRunner;
  worker: (StageRunner & WorkerProbe) | null;
  git: WorkspaceGit;
  watchdog: WatchdogConfig;
  stageRunTimeoutMs: number;
  lockTtlMs: number;
  workerProbeIntervalMs: number;
  autoArchiveDays: number;
  prompts: { opencode: string; pi: string };
  adminParticipantId: string;
  maxServerRuns?: number;
  random?: () => number;
  /** Re-try delay after a plain failure ("revert"), AIF re-polls; we wait a little. */
  revertCooldownMs?: number;
}

export interface RunInfo {
  project: string;
  taskId: string;
  stage: StageDefinition["label"] | "triage";
  agent: RuntimeProfile;
  model: string;
  prompt: string;
  planPath: string | null;
  startedAt: string;
}

const SERVER_LOCK = "coordinator";
const PC_LOCK = "worker:pc";

function lockOwner(stage: StageDefinition): string {
  return stage.where === "pc" ? PC_LOCK : SERVER_LOCK;
}
const HEARTBEAT_EVERY_MS = 60_000;
const MAX_REVERTS = 3;

export function planPathFor(task: Task): string {
  if (task.plannerMode === "full" && task.branch) {
    const stem = task.branch.split("/").pop() ?? task.id.toLowerCase();
    return `.ai-factory/plans/${stem}.md`;
  }
  return ".ai-factory/PLAN.md";
}

export function buildPrompt(template: string, stage: StageDefinition, task: Task, planPath: string): string {
  const head = template.replace("{skill}", stage.skill);
  const ref = `${task.project}/${task.id}`;
  const context = [`# ${ref}: ${task.title}`, "", task.description.trim()];
  switch (stage.label) {
    case "planner":
      return [`${head} ${task.plannerMode}`, "", ...context, "", `Сохрани план в ${planPath}.`].join("\n");
    case "improver":
    case "plan-checker":
      return [`${head} ${planPath}`, "", ...context].join("\n");
    case "implementer":
      return task.reworkRequested && task.reviewComments.trim()
        ? [head, "", ...context, "", "## Замечания ревью", task.reviewComments.trim()].join("\n")
        : head;
    case "verifier":
      return [head, "", ...context].join("\n");
    case "reviewer":
      return [
        head,
        "",
        ...context,
        "",
        "Ответ оформи разделами `## Blocking Findings` (список; пусто, если блокирующих нет) и `## Advisories`.",
      ].join("\n");
  }
}

function key(project: string, id: string): string {
  return `${project}/${id}`;
}

export class Coordinator {
  private readonly o: CoordinatorOptions;
  private readonly random: () => number;
  private readonly running = new Map<string, RunInfo>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly planChecked = new Map<string, string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly reverts = new Map<string, number>();
  private readonly waitingWorker = new Set<string>();
  private readonly waitingModel = new Set<string>();
  private worker: { online: boolean; busy: boolean; checkedAt: number | null; detail: string } = {
    online: false,
    busy: false,
    checkedAt: null,
    detail: "not probed",
  };
  private lastModels: ModelsConfig | null = null;
  private modelsError: string | null = null;
  private readonly triaged = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: CoordinatorOptions) {
    this.o = opts;
    this.random = opts.random ?? Math.random;
  }

  private now(): Date {
    return this.o.service.clock();
  }

  /* v8 ignore start -- timer wiring; tick() is tested directly */
  start(intervalMs: number): void {
    this.stopped = false;
    const loop = (): void => {
      void this.tick().catch((err: unknown) => {
        console.error("[coordinator] tick failed:", err instanceof Error ? err.message : err);
      });
    };
    loop();
    this.timer = setInterval(loop, intervalMs);
  }
  /* v8 ignore stop */

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  runInfo(project: string, id: string): RunInfo | null {
    return this.running.get(key(project, id)) ?? null;
  }

  status(): {
    running: RunInfo[];
    worker: { configured: boolean; online: boolean; busy: boolean; checkedAt: string | null; detail: string };
    waitingWorker: string[];
    waitingModel: string[];
  } {
    return {
      running: [...this.running.values()],
      worker: {
        configured: this.o.worker !== null,
        online: this.worker.online,
        busy: this.worker.busy,
        checkedAt: this.worker.checkedAt === null ? null : new Date(this.worker.checkedAt).toISOString(),
        detail: this.worker.detail,
      },
      waitingWorker: [...this.waitingWorker],
      waitingModel: [...this.waitingModel],
    };
  }

  /** One coordinator cycle. Stage runs are started in the background (see `idle()`). */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.o.store.ensureBoards(); // Р-034: new projects get Доска.md
      const all = await this.o.service.listAllActive();
      for (const { project, tasks } of all) {
        await this.systemPass(project, tasks);
      }
      const fresh = await this.o.service.listAllActive();
      await this.stagePass(fresh);
      await this.triagePass(fresh);
      // Status must be honest even with no PC tasks: probe on the regular interval (cached otherwise).
      await this.ensureWorkerProbe(false).catch(() => false);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------ system pass

  private async applySystem(task: Task, t: SystemTransition | null, ctx: ActorContext = COORDINATOR_ACTOR): Promise<boolean> {
    if (!t) return false;
    const r = await this.o.service.mutate(task.project, task.id, ctx, (s) =>
      s.task.status === t.expectedStatus ? { patch: t.patch, action: t.action, reason: t.reason } : null,
    );
    return r !== null;
  }

  private async systemPass(project: Project, stored: StoredTask[]): Promise<void> {
    const now = this.now();
    for (const { task } of stored) {
      const k = key(task.project, task.id);
      if (this.running.has(k)) continue;
      if (shouldReleaseClaim(task, now)) {
        await this.o.service.mutate(task.project, task.id, COORDINATOR_ACTOR, (s) =>
          shouldReleaseClaim(s.task, now) ? { patch: { lockedBy: null, lockedUntil: null }, action: "task.claim_released" } : null,
        );
        continue;
      }
      if (await this.applySystem(task, recoverStale(task, now, this.o.watchdog, this.random()))) continue;
      if (await this.applySystem(task, releaseDueBlocked(task, now, this.o.watchdog))) continue;
      if (await this.applySystem(task, fireScheduled(task, now))) continue;
      if (shouldAutoArchive(task, now, this.o.autoArchiveDays)) {
        await this.o.service.setArchived(task.project, task.id, true, COORDINATOR_ACTOR, `auto-archive after ${String(this.o.autoArchiveDays)} days`);
      }
      if (task.status !== "plan_ready") this.planChecked.delete(k);
    }
    for (const task of pickAutoQueueTasks(stored.map((s) => s.task), project, now)) {
      await this.o.service.mutate(task.project, task.id, COORDINATOR_ACTOR, (s) =>
        s.task.status === "backlog" && s.task.executionOwner === "ai"
          ? { patch: { status: "planning", scheduledAt: null }, action: "task.auto_queue_started" }
          : null,
      );
    }
  }

  // ------------------------------------------------------------- stage pass

  private runningCount(where: "server" | "pc"): number {
    let n = 0;
    for (const r of this.running.values()) {
      if ((r.stage === "implementer" ? "pc" : "server") === where) n++;
    }
    return n;
  }

  private projectBusy(project: Project): boolean {
    if (project.parallelEnabled) return false;
    for (const r of this.running.values()) if (r.project === project.id) return true;
    return false;
  }

  private async ensureWorkerProbe(force: boolean): Promise<boolean> {
    const w = this.o.worker;
    if (!w) return false;
    const nowMs = this.now().getTime();
    if (!force && this.worker.checkedAt !== null && nowMs - this.worker.checkedAt < this.o.workerProbeIntervalMs) {
      return this.worker.online && !this.worker.busy;
    }
    const wasOnline = this.worker.online;
    const p = await w.probe();
    this.worker = { ...p, checkedAt: nowMs };
    if (p.online !== wasOnline) this.o.service.emitRaw("worker.status", { online: p.online, busy: p.busy });
    return p.online && !p.busy;
  }

  private async stagePass(all: { project: Project; tasks: StoredTask[] }[]): Promise<void> {
    const now = this.now();
    const models = await this.loadModels(all.map((a) => a.project.id));
    let workerChecked = false;
    let workerReady = false;
    for (const { project, tasks } of all) {
      for (const stage of PIPELINE) {
        for (const task of selectStageCandidates(tasks.map((t) => t.task), stage.label, now, 100)) {
          const k = key(project.id, task.id);
          if (this.running.has(k) || this.projectBusy(project)) continue;
          if ((this.cooldownUntil.get(k) ?? 0) > now.getTime()) continue;
          if (stage.label === "plan-checker" && this.planChecked.get(k) === task.plan) continue;
          if (stage.label === "implementer" && task.status === "plan_ready" && this.planChecked.get(k) !== task.plan) continue;
          const needsPc = stage.where === "pc" || stage.label === "plan-checker";
          if (needsPc) {
            if (!this.o.worker) {
              await this.markWaitingWorker(task, "worker is not configured");
              continue;
            }
            if (!workerChecked) {
              workerReady = await this.ensureWorkerProbe(false);
              workerChecked = true;
            }
            if (!workerReady) {
              await this.markWaitingWorker(task, this.worker.detail);
              continue;
            }
            await this.clearWaitingWorker(task);
          }
          const where = stage.where;
          if (where === "pc" && this.runningCount("pc") >= 1) continue;
          if (where === "server" && this.runningCount("server") >= (this.o.maxServerRuns ?? 1)) continue;
          if (!models) {
            await this.markWaitingModel(task, stage, null, "models.json is missing or invalid");
            continue;
          }
          const agent: RuntimeProfile = where === "pc" ? task.runtimeProfile : "pi";
          const state = pruneModelsState(await this.o.store.readModelsState(), now);
          const sel = selectModel(models, stage.modelRole, agent, state, now, where === "pc" ? task.modelOverride : null);
          if (!sel.ok) {
            await this.markWaitingModel(task, stage, sel.nextCheckAt, "all models of the chain are unavailable");
            continue;
          }
          if (this.waitingModel.delete(k)) {
            await this.o.service.note(project.id, task.id, COORDINATOR_ACTOR, "task.model_available", null, { model: sel.model, stage: stage.label });
          }
          const claimed = await this.claim(project, task, stage, agent, sel.model);
          if (!claimed) continue;
          const promise = this.execute(project, claimed, stage, agent, sel.model, models)
            .catch((err: unknown) => {
              console.error(`[coordinator] ${k} ${stage.label} crashed:`, err instanceof Error ? err.message : err);
            })
            .finally(() => {
              this.running.delete(k);
              this.inflight.delete(promise);
            });
          this.inflight.add(promise);
        }
      }
    }
  }

  /**
   * Addition to AIF (spec 3.7): Pi writes an analysis of a stuck `blocked_external` task into
   * the task (implementation log), the status is not changed. Once per blocked reason.
   */
  private async triagePass(all: { project: Project; tasks: StoredTask[] }[]): Promise<void> {
    const now = this.now();
    const models = this.lastModels;
    if (!models) return;
    for (const { project, tasks } of all) {
      for (const { task } of tasks) {
        if (task.status !== "blocked_external" || task.executionOwner !== "ai" || task.paused) continue;
        const k = key(project.id, task.id);
        const marker = task.blockedReason ?? "";
        if (this.triaged.get(k) === marker || this.running.has(k)) continue;
        if (this.runningCount("server") >= (this.o.maxServerRuns ?? 1)) return;
        const sel = selectModel(models, "review", "pi", pruneModelsState(await this.o.store.readModelsState(), now), now);
        if (!sel.ok) return;
        this.triaged.set(k, marker);
        const prompt = [
          `# ${k}: ${task.title}`,
          "",
          `Задача заблокирована (blocked_external) на этапе «${task.blockedFromStatus ?? "?"}».`,
          `Причина: ${marker || "не указана"}`,
          "",
          "Разбери причину по коду и описанию задачи. Ответь коротко: что случилось, что проверить, как снять блок. Ничего не меняй в репозитории.",
        ].join("\n");
        this.running.set(k, { project: project.id, taskId: task.id, stage: "triage", agent: "pi", model: sel.model, prompt, planPath: null, startedAt: now.toISOString() });
        const promise = this.runTriage(project, task, sel.model, prompt, models)
          .catch((err: unknown) => {
            console.error(`[coordinator] ${k} triage crashed:`, err instanceof Error ? err.message : err);
          })
          .finally(() => {
            this.running.delete(k);
            this.inflight.delete(promise);
          });
        this.inflight.add(promise);
      }
    }
  }

  private async runTriage(project: Project, task: Task, model: string, prompt: string, models: ModelsConfig): Promise<void> {
    const reviewer = getStage("reviewer");
    const cwd = (await this.o.git.prepareWorktree(project, task.branch)).dir;
    const result = await this.o.pi.run({
      project,
      task,
      stage: reviewer,
      agent: "pi",
      model,
      prompt,
      cwd,
      env: { HANDOFF_MODE: "1", HANDOFF_TASK_ID: key(project.id, task.id) },
      timeoutMs: this.o.stageRunTimeoutMs,
      onHeartbeat: () => undefined,
    });
    if (result.kind === "error" && result.error.kind === "runtime" && (result.error.category === "rate_limit" || result.error.category === "no_subscription")) {
      const state = markModelUnavailable(await this.o.store.readModelsState(), model, result.error.category, result.error.resetAt ?? null, this.now(), models.defaultCooldownMinutes);
      await this.o.store.writeModelsState(state);
      this.triaged.delete(key(project.id, task.id));
      return;
    }
    if (result.kind !== "ok" || !result.text.trim()) return;
    const stamp = this.now().toISOString();
    await this.o.service.mutate(project.id, task.id, COORDINATOR_ACTOR, (s) =>
      s.task.status !== "blocked_external"
        ? null
        : {
            patch: { implementationLog: [s.task.implementationLog.trim(), `### Разбор блокировки ${stamp}`, result.text.trim()].filter(Boolean).join("\n\n") },
            action: "task.triage_written",
            metadata: { model: result.model },
          },
    );
  }

  /** Spec 3.8: invalid models.json → keep the last valid version, journal `models.invalid` once per error. */
  private async loadModels(projects: string[]): Promise<ModelsConfig | null> {
    try {
      const cfg = await this.o.store.readModels();
      if (cfg) {
        this.lastModels = cfg;
        this.modelsError = null;
      }
      return cfg ?? this.lastModels;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.modelsError !== message) {
        this.modelsError = message;
        for (const p of projects) {
          await this.o.service.note(p, null, COORDINATOR_ACTOR, "models.invalid", message.slice(0, 500), { usingPrevious: this.lastModels !== null });
        }
      }
      return this.lastModels;
    }
  }

  private async markWaitingWorker(task: Task, detail: string): Promise<void> {
    const k = key(task.project, task.id);
    if (this.waitingWorker.has(k)) return;
    this.waitingWorker.add(k);
    await this.o.service.note(task.project, task.id, COORDINATOR_ACTOR, "task.waiting_worker", "ПК недоступен — задача ждёт", { detail });
  }

  private async clearWaitingWorker(task: Task): Promise<void> {
    const k = key(task.project, task.id);
    if (!this.waitingWorker.delete(k)) return;
    await this.o.service.note(task.project, task.id, COORDINATOR_ACTOR, "task.worker_available", null, { detail: this.worker.detail });
  }

  private async markWaitingModel(task: Task, stage: StageDefinition, nextCheckAt: string | null, reason: string): Promise<void> {
    const k = key(task.project, task.id);
    if (this.waitingModel.has(k)) return;
    this.waitingModel.add(k);
    await this.o.service.note(task.project, task.id, COORDINATOR_ACTOR, "task.waiting_model", reason, { stage: stage.label, nextCheckAt });
  }

  private async claim(project: Project, task: Task, stage: StageDefinition, agent: RuntimeProfile, model: string): Promise<Task | null> {
    const now = this.now();
    const lockedUntil = new Date(now.getTime() + this.o.lockTtlMs).toISOString();
    const k = key(project.id, task.id);
    let planPath = task.planPath;
    const written = await this.o.service.mutate(project.id, task.id, COORDINATOR_ACTOR, (s) => {
      if (!isStageCandidate(s.task, stage.label, now)) return null;
      const patch: TaskPatch = startStagePatch(stage, lockOwner(stage), lockedUntil, now.toISOString());
      if (stage.label === "planner" && s.task.plannerMode === "full" && !s.task.branch) {
        patch.branch = branchNameFor({ project: s.task.project, id: s.task.id }, s.task.title);
      }
      if (stage.label === "implementer" && !s.task.branch) {
        patch.branch = branchNameFor({ project: s.task.project, id: s.task.id }, s.task.title);
      }
      planPath = planPathFor({ ...s.task, ...patch });
      if (s.task.planPath === null) patch.planPath = planPath;
      return { patch, action: "task.stage_started", metadata: { stage: stage.label, agent, model } };
    });
    if (!written) return null;
    const template = this.o.prompts[agent];
    this.running.set(k, {
      project: project.id,
      taskId: task.id,
      stage: stage.label,
      agent,
      model,
      prompt: buildPrompt(template, stage, written.task, planPath ?? planPathFor(written.task)),
      planPath: written.task.planPath,
      startedAt: now.toISOString(),
    });
    return written.task;
  }

  private async execute(project: Project, task: Task, stage: StageDefinition, agent: RuntimeProfile, model: string, models: ModelsConfig): Promise<void> {
    const k = key(project.id, task.id);
    const info = this.running.get(k);
    /* v8 ignore next */
    if (!info) return;
    let lastBeat = this.now().getTime();
    const onHeartbeat = (): void => {
      const nowMs = this.now().getTime();
      if (nowMs - lastBeat < HEARTBEAT_EVERY_MS) return;
      lastBeat = nowMs;
      void this.o.service.heartbeat(project.id, task.id, COORDINATOR_ACTOR, this.o.lockTtlMs).catch(() => undefined);
    };
    const planPath = info.planPath ?? planPathFor(task);
    let result: StageRunResult;
    try {
      let cwd = "";
      if (stage.where === "server") {
        cwd = (await this.o.git.prepareWorktree(project, task.branch)).dir;
        if (task.plan.trim() && stage.label !== "planner") await this.o.git.writeFile(project, planPath, task.plan);
      }
      const env: Record<string, string> = { HANDOFF_MODE: "1", HANDOFF_TASK_ID: k, HANDOFF_SKIP_REVIEW: task.skipReview ? "1" : "0" };
      if (task.branch) env["HANDOFF_BRANCH_NAME"] = task.branch;
      const runner = stage.where === "pc" ? this.o.worker : this.o.pi;
      /* v8 ignore next */
      if (!runner) throw new Error("worker runner missing");
      result = await runner.run({ project, task, stage, agent, model, prompt: info.prompt, cwd, env, timeoutMs: this.o.stageRunTimeoutMs, onHeartbeat });
    } catch (err) {
      result = { kind: "error", model, error: { kind: "other", reason: err instanceof Error ? err.message : String(err) } };
    }
    await this.finish(project, task, stage, agent, result, models, planPath);
  }

  private async finish(
    project: Project,
    task: Task,
    stage: StageDefinition,
    agent: RuntimeProfile,
    result: StageRunResult,
    models: ModelsConfig,
    planPath: string,
  ): Promise<void> {
    const k = key(project.id, task.id);
    switch (result.kind) {
      case "unavailable":
        this.worker = { ...this.worker, online: false, checkedAt: this.now().getTime(), detail: result.reason };
        await this.release(task, stage, "task.stage_deferred", result.reason, { stage: stage.label });
        await this.markWaitingWorker(task, result.reason);
        return;
      case "error":
        await this.handleError(task, stage, agent, result.error, result.model, models);
        return;
      case "ok":
        break;
    }
    try {
      await this.handleSuccess(project, task, stage, result, planPath);
      this.reverts.delete(k);
      this.cooldownUntil.delete(k);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isCommitProblem = err instanceof ServiceError && (err.code === "commit_not_found" || err.code === "validation");
      await this.handleError(task, stage, agent, isCommitProblem ? { kind: "fast_retry", reason } : { kind: "other", reason }, result.model, models, isCommitProblem);
    }
  }

  private async handleSuccess(project: Project, task: Task, stage: StageDefinition, result: Extract<StageRunResult, { kind: "ok" }>, planPath: string): Promise<void> {
    const k = key(project.id, task.id);
    const extra: TaskPatch = {};
    switch (stage.label) {
      case "planner":
      case "improver":
      case "plan-checker": {
        const fromFile = await this.o.git.readFile(project, planPath).catch(() => null);
        const plan = (fromFile ?? result.text).trim();
        if (!plan) throw new Error(`${stage.label} produced no plan`);
        extra.plan = plan;
        extra.planPath = planPath;
        if (stage.label === "plan-checker") this.planChecked.set(k, plan);
        else this.planChecked.delete(k);
        break;
      }
      case "implementer": {
        if (!result.sha || !result.branch) throw new ServiceError("validation", "worker reported no commit");
        await this.o.service.addCommit(project.id, task.id, result.sha, result.branch, COORDINATOR_ACTOR);
        // Mode 1: the worker does not call MCP, so the coordinator records the run in the log.
        extra.implementationLog = [
          task.implementationLog.trim(),
          `### Implement ${this.now().toISOString()}`,
          `Модель: ${result.model}; коммит ${result.sha} в ветке ${result.branch}.`,
          result.text.trim(),
        ]
          .filter(Boolean)
          .join("\n\n");
        break;
      }
      case "verifier":
        extra.implementationLog = [task.implementationLog.trim(), `### Verify ${this.now().toISOString()}`, result.text.trim()].filter(Boolean).join("\n\n");
        break;
      case "reviewer":
        extra.reviewComments = result.text.trim();
        break;
    }
    const handoff: { reason: string | null } = { reason: null };
    await this.o.service.mutate(project.id, task.id, COORDINATOR_ACTOR, (s) => {
      if (s.task.lockedBy !== lockOwner(stage) || s.task.status !== stage.inProgress) return null;
      const current = { ...s.task, ...extra };
      const review = stage.label === "reviewer" && current.autoMode ? evaluateReview(result.text, current.reviewIterationCount, current.maxReviewIterations) : null;
      const completion = completeStage(current, stage, review);
      if (completion.requiresCommit && !current.commitSha) throw new Error("terminal status requires a commit");
      handoff.reason = completion.handoffToHuman?.reason ?? null;
      const patch: TaskPatch = { ...extra, ...completion.patch, lastHeartbeatAt: null };
      if (handoff.reason === null) Object.assign(patch, { lockedBy: null, lockedUntil: null, stageStartedAt: null });
      return { patch, action: "task.stage_completed", metadata: { stage: stage.label, model: result.model, review: review?.status ?? null } };
    });
    if (handoff.reason !== null) {
      const fresh = await this.o.service.getTask(project.id, task.id);
      await this.o.service.handoff(
        project.id,
        task.id,
        {
          executionOwner: "human",
          assigneeIds: [this.o.adminParticipantId],
          expectedOwnershipRevision: fresh.task.ownershipRevision,
          reason: `manual review: ${handoff.reason}`,
          allowLockedBy: lockOwner(stage),
        },
        COORDINATOR_ACTOR,
      );
    }
  }

  private async release(task: Task, stage: StageDefinition, action: string, reason: string | null, metadata: Record<string, unknown>, patch: TaskPatch = {}, history = false): Promise<void> {
    await this.o.service.mutate(task.project, task.id, COORDINATOR_ACTOR, (s) => {
      if (s.task.lockedBy !== lockOwner(stage)) return null;
      return {
        patch: { status: stage.inProgress, lockedBy: null, lockedUntil: null, stageStartedAt: null, lastHeartbeatAt: null, ...patch },
        action,
        reason,
        metadata,
        history,
      };
    });
  }

  private async handleError(task: Task, stage: StageDefinition, agent: RuntimeProfile, error: StageError, model: string, models: ModelsConfig, bounded = false): Promise<void> {
    const k = key(task.project, task.id);
    const now = this.now();
    const fresh = await this.o.service.getTask(task.project, task.id);
    const recovery = classifyStageError({ error, retryCount: fresh.task.retryCount, now, random: this.random() });
    switch (recovery.kind) {
      case "switch_model": {
        const state = markModelUnavailable(await this.o.store.readModelsState(), model, recovery.category, recovery.resetAt, now, models.defaultCooldownMinutes);
        await this.o.store.writeModelsState(state);
        const next = selectModel(models, stage.modelRole, agent, state, now, stage.where === "pc" ? fresh.task.modelOverride : null);
        await this.release(
          task,
          stage,
          "task.model_switched",
          recovery.category,
          { stage: stage.label, role: stage.modelRole, from: model, to: next.ok ? next.model : null, until: state.models[model]?.unavailableUntil ?? null },
          {},
          true,
        );
        this.o.service.emitRaw("models.changed", { model, category: recovery.category });
        return;
      }
      case "fast_retry":
      case "revert": {
        const count = (this.reverts.get(k) ?? 0) + 1;
        this.reverts.set(k, count);
        if (bounded || count >= MAX_REVERTS) {
          this.reverts.delete(k);
          const retryCount = fresh.task.retryCount + 1;
          const quarantine = retryCount > this.o.watchdog.staleMaxRetry;
          await this.release(task, stage, "task.stage_failed", error.reason.slice(0, 500), { stage: stage.label, attempts: count }, {
            status: "blocked_external",
            blockedReason: `${stage.label} failed: ${error.reason.slice(0, 300)}${quarantine ? "; auto-retry limit reached" : ""}`,
            blockedFromStatus: stage.inProgress,
            retryAfter: quarantine ? null : new Date(now.getTime() + getRandomBackoffMinutes(this.random()) * 60_000).toISOString(),
            retryCount,
          });
          return;
        }
        this.cooldownUntil.set(k, now.getTime() + (this.o.revertCooldownMs ?? 5 * 60_000));
        await this.release(task, stage, "task.stage_failed", error.reason.slice(0, 500), { stage: stage.label, attempts: count });
        return;
      }
      case "blocked_external":
        await this.release(task, stage, "task.stage_blocked", recovery.blockedReason, { stage: stage.label, retryAfterSource: recovery.retryAfterSource }, {
          ...recoveryPatch(recovery, stage),
        });
        return;
    }
  }
}
