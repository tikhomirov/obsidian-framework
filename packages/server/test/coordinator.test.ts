import { describe, expect, it } from "vitest";
import type { Task } from "@of/core";
import { DEFAULT_WATCHDOG_CONFIG, getStage } from "@of/core";
import type { CoordinatorOptions, WorkspaceGit } from "../src/coordinator.js";
import { Coordinator, buildPrompt, planPathFor } from "../src/coordinator.js";
import type { StageRunRequest, StageRunResult, StageRunner, WorkerProbe } from "../src/runners/types.js";
import { COORDINATOR_ACTOR } from "../src/service.js";
import type { Fixture } from "./helpers.js";
import { OWNER, makeFixture } from "./helpers.js";

type Responder = (req: StageRunRequest) => StageRunResult | Promise<StageRunResult>;

class FakeRunner implements StageRunner {
  calls: StageRunRequest[] = [];
  constructor(public respond: Responder) {}
  async run(req: StageRunRequest): Promise<StageRunResult> {
    this.calls.push(req);
    req.onHeartbeat();
    return this.respond(req);
  }
}

class FakeWorker extends FakeRunner implements WorkerProbe {
  online = true;
  busy = false;
  probes = 0;
  probe(): Promise<{ online: boolean; busy: boolean; detail: string }> {
    this.probes++;
    return Promise.resolve({ online: this.online, busy: this.busy, detail: this.online ? "ok" : "ssh exit 255" });
  }
}

class FakeGit implements WorkspaceGit {
  files = new Map<string, string>();
  written: string[] = [];
  failPrepare = false;
  prepareWorktree(): Promise<{ dir: string; ref: string }> {
    if (this.failPrepare) return Promise.reject(new Error("clone failed"));
    return Promise.resolve({ dir: "/clones/of", ref: "origin/main" });
  }
  readFile(_p: unknown, rel: string): Promise<string | null> {
    return Promise.resolve(this.files.get(rel) ?? null);
  }
  writeFile(_p: unknown, rel: string, text: string): Promise<void> {
    this.written.push(rel);
    this.files.set(rel, text);
    return Promise.resolve();
  }
}

const ok = (text: string, model = "m/x", sha: string | null = null, branch: string | null = null): StageRunResult => ({ kind: "ok", text, sha, branch, model });

interface Rig {
  f: Fixture;
  pi: FakeRunner;
  worker: FakeWorker;
  git: FakeGit;
  c: Coordinator;
  tick(): Promise<void>;
  task(id?: string): Promise<Task>;
  actions(id?: string): Promise<string[]>;
}

async function rig(opts: { pi?: Responder; worker?: Responder | null; models?: boolean; extra?: Partial<CoordinatorOptions>; projectExtra?: string } = {}): Promise<Rig> {
  const f = await makeFixture({ models: opts.models ?? true, projectExtra: opts.projectExtra ?? "", verifier: { verify: () => Promise.resolve(true) } });
  const pi = new FakeRunner(opts.pi ?? (() => ok("plan text")));
  const worker = new FakeWorker(opts.worker ?? (() => ok("done", "anthropic/claude-sonnet-4-5", "abcdef1", "of/task-001-t")));
  const git = new FakeGit();
  const c = new Coordinator({
    service: f.service,
    store: f.store,
    pi,
    worker: opts.worker === null ? null : worker,
    git,
    watchdog: DEFAULT_WATCHDOG_CONFIG,
    stageRunTimeoutMs: 60_000,
    lockTtlMs: 30 * 60_000,
    workerProbeIntervalMs: 5 * 60_000,
    autoArchiveDays: 7,
    prompts: { opencode: "/{skill}", pi: "/skill:{skill}" },
    adminParticipantId: "owner",
    random: () => 0,
    ...opts.extra,
  });
  return {
    f,
    pi,
    worker,
    git,
    c,
    tick: async () => {
      await c.tick();
      await c.idle();
    },
    task: async (id = "TASK-001") => (await f.service.getTask("of", id)).task,
    actions: async (id = "TASK-001") => (await f.service.history("of", id)).map((r) => r.action),
  };
}

async function newTask(r: Rig, patch: Partial<Task> = {}, title = "T"): Promise<string> {
  const s = await r.f.service.createTask("of", { title }, OWNER);
  if (Object.keys(patch).length) await r.f.service.mutate("of", s.task.id, COORDINATOR_ACTOR, () => ({ patch, action: "test.setup" }));
  return s.task.id;
}

describe("Coordinator", () => {
  it("planner → plan_ready with plan from the clone file", async () => {
    const r = await rig();
    r.git.files.set(".ai-factory/PLAN.md", "# Plan from file");
    await newTask(r, { status: "planning" });
    await r.tick();
    const t = await r.task();
    expect(t).toMatchObject({ status: "plan_ready", plan: "# Plan from file", planPath: ".ai-factory/PLAN.md", lockedBy: null, stageStartedAt: null });
    expect(r.pi.calls[0]?.model).toBe("omniroute/plan-a");
    expect(r.pi.calls[0]?.prompt).toMatch(/^\/skill:aif-plan fast/);
    expect(r.pi.calls[0]?.env).toMatchObject({ HANDOFF_MODE: "1", HANDOFF_TASK_ID: "of/TASK-001" });
    expect(await r.actions()).toEqual(expect.arrayContaining(["task.stage_started", "task.stage_completed"]));
  });

  it("planner in full mode sets a branch and plan path; improve when requested", async () => {
    const r = await rig();
    r.pi.respond = (req) => {
      if (req.stage.label === "improver") r.git.files.set(".ai-factory/plans/task-001-board-view.md", "improved plan");
      return ok(`plan for ${req.stage.label}`);
    };
    await newTask(r, { status: "planning", plannerMode: "full", runPlanImprove: true }, "Board view");
    await r.tick();
    let t = await r.task();
    expect(t.branch).toBe("of/task-001-board-view");
    expect(t.planPath).toBe(".ai-factory/plans/task-001-board-view.md");
    expect(t.status).toBe("improve");
    await r.tick();
    t = await r.task();
    expect(t.status).toBe("plan_ready");
    expect(t.plan).toBe("improved plan");
    expect(r.git.written).toContain(".ai-factory/plans/task-001-board-view.md");
  });

  it("empty planner output → failure with cooldown, three failures → blocked", async () => {
    const r = await rig({ pi: () => ok("  ") });
    await newTask(r, { status: "planning" });
    await r.tick();
    expect((await r.task()).status).toBe("planning");
    expect(await r.actions()).toContain("task.stage_failed");
    await r.tick();
    expect(r.pi.calls).toHaveLength(1); // cooldown
    r.f.clock.advance(6 * 60_000);
    await r.tick();
    r.f.clock.advance(6 * 60_000);
    await r.tick();
    const t = await r.task();
    expect(t.status).toBe("blocked_external");
    expect(t.blockedReason).toMatch(/planner failed/);
    expect(t.retryAfter).not.toBeNull();
  });

  it("plan_ready + auto: plan-checker once, then implementer on the PC, commit recorded", async () => {
    const r = await rig({ pi: () => ok("checked plan") });
    await newTask(r, { status: "plan_ready", plan: "# plan" });
    await r.tick();
    expect(r.pi.calls[0]?.stage.label).toBe("plan-checker");
    expect((await r.task()).status).toBe("plan_ready");
    await r.tick();
    expect(r.worker.calls).toHaveLength(1);
    expect(r.worker.calls[0]?.agent).toBe("opencode");
    expect(r.worker.calls[0]?.model).toBe("anthropic/claude-sonnet-4-5");
    const t = await r.task();
    expect(t.status).toBe("done");
    expect(t.commitSha).toBe("abcdef1");
    expect(t.implementationLog).toContain("### Implement ");
    expect(t.implementationLog).toContain("коммит abcdef1 в ветке of/task-001-t");
    expect(t.branch).toBe("of/task-001-t");
    expect(r.pi.calls).toHaveLength(1);
    expect(r.c.status().running).toEqual([]);
  });

  it("run info is exposed while the stage runs", async () => {
    let seen: unknown = null;
    const r = await rig({ pi: () => ok("p") });
    r.worker.respond = () => {
      seen = r.c.runInfo("of", "TASK-001");
      return ok("x", "anthropic/claude-sonnet-4-5", "abcdef1", "of/task-001-t");
    };
    await newTask(r, { status: "implementing", plan: "# plan" });
    await r.tick();
    expect(seen).toMatchObject({ stage: "implementer", agent: "opencode", model: "anthropic/claude-sonnet-4-5", prompt: "/aif-implement" });
    expect(r.c.runInfo("of", "TASK-001")).toBeNull();
  });

  it("probes the PC on the interval even with no tasks (honest status)", async () => {
    const r = await rig();
    expect(r.c.status().worker).toMatchObject({ online: false, checkedAt: null, detail: "not probed" });
    await r.tick();
    expect(r.c.status().worker).toMatchObject({ online: true });
    expect(r.c.status().worker.checkedAt).not.toBeNull();
    await r.tick();
    expect(r.worker.probes).toBe(1);
    r.f.clock.advance(5 * 60_000);
    r.worker.online = false;
    await r.tick();
    expect(r.worker.probes).toBe(2);
    expect(r.c.status().worker.online).toBe(false);
  });

  it("PC offline: plan_ready waits (no Pi tokens burned), one waiting_worker event", async () => {
    const r = await rig();
    r.worker.online = false;
    await newTask(r, { status: "plan_ready", plan: "# plan" });
    await r.tick();
    await r.tick();
    expect(r.pi.calls).toHaveLength(0);
    expect((await r.actions()).filter((a) => a === "task.waiting_worker")).toHaveLength(1);
    expect(r.worker.probes).toBe(1);
    expect(r.c.status().waitingWorker).toEqual(["of/TASK-001"]);
    r.f.clock.advance(5 * 60_000);
    r.worker.online = true;
    await r.tick();
    expect(r.pi.calls).toHaveLength(1);
    expect(r.c.status().worker.online).toBe(true);
  });

  it("no worker configured → waiting_worker", async () => {
    const r = await rig({ worker: null });
    await newTask(r, { status: "implementing" });
    await r.tick();
    expect(await r.actions()).toContain("task.waiting_worker");
    expect(r.c.status().worker.configured).toBe(false);
  });

  it("worker unreachable during the run → deferred, back to waiting", async () => {
    const r = await rig({ worker: () => ({ kind: "unavailable", reason: "ssh exit 255" }) });
    await newTask(r, { status: "implementing" });
    await r.tick();
    const t = await r.task();
    expect(t).toMatchObject({ status: "implementing", lockedBy: null, stageStartedAt: null });
    expect(await r.actions()).toEqual(expect.arrayContaining(["task.stage_deferred", "task.waiting_worker"]));
    expect(r.c.status().worker.online).toBe(false);
  });

  it("limit → model switched, next run uses the next model (process unchanged)", async () => {
    let n = 0;
    const r = await rig({
      pi: (req) => {
        n++;
        return n === 1 ? { kind: "error", model: req.model, error: { kind: "runtime", category: "rate_limit", reason: "429", resetAt: null } } : ok("plan");
      },
    });
    await newTask(r, { status: "planning" });
    await r.tick();
    let t = await r.task();
    expect(t.status).toBe("planning");
    const rows = await r.f.service.history("of", "TASK-001");
    const sw = rows.find((x) => x.action === "task.model_switched");
    expect(sw?.metadata).toContain('"to":"omniroute/plan-b"');
    expect((await r.f.store.readModelsState()).models["omniroute/plan-a"]).toBeDefined();
    await r.tick();
    t = await r.task();
    expect(t.status).toBe("plan_ready");
    expect(r.pi.calls[1]?.model).toBe("omniroute/plan-b");
  });

  it("all models unavailable → waiting_model once, then model_available", async () => {
    const r = await rig();
    await r.f.store.writeModelsState({
      version: 1,
      models: {
        "omniroute/plan-a": { unavailableUntil: "2026-10-29T11:00:00.000Z", manual: false, category: "rate_limit", since: "x" },
        "omniroute/plan-b": { unavailableUntil: null, manual: true, category: "no_subscription", since: "x" },
      },
    });
    await newTask(r, { status: "planning" });
    await r.tick();
    await r.tick();
    expect(r.pi.calls).toHaveLength(0);
    expect((await r.actions()).filter((a) => a === "task.waiting_model")).toHaveLength(1);
    expect(r.c.status().waitingModel).toEqual(["of/TASK-001"]);
    r.f.clock.advance(2 * 3600_000);
    await r.tick();
    expect(r.pi.calls).toHaveLength(1);
    expect(await r.actions()).toContain("task.model_available");
  });

  it("models.json missing → waiting_model", async () => {
    const r = await rig({ models: false });
    await newTask(r, { status: "planning" });
    await r.tick();
    expect(await r.actions()).toContain("task.waiting_model");
  });

  it("reviewer: blocking findings → rework; at max iterations → human", async () => {
    const r = await rig({ pi: () => ok("## Blocking Findings\n- bug\n\n## Advisories\n- none") });
    await newTask(r, { status: "review", commitSha: "abcdef1", maxReviewIterations: 2 });
    await r.tick();
    let t = await r.task();
    expect(t).toMatchObject({ status: "implementing", reworkRequested: true, reviewIterationCount: 1 });
    expect(t.reviewComments).toContain("bug");
    await r.f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { status: "review", commitSha: "abcdef1" }, action: "t" }));
    await r.tick();
    t = await r.task();
    expect(t).toMatchObject({ status: "review", executionOwner: "human", manualReviewRequired: true, lockedBy: null });
    expect(t.assignees.map((a) => a.participantId)).toEqual(["owner"]);
  });

  it("reviewer accepts → done; implementer rework prompt carries review comments", async () => {
    const r = await rig({ pi: () => ok("## Blocking Findings\n\n## Advisories\n- ok") });
    await newTask(r, { status: "review", commitSha: "abcdef1" });
    await r.tick();
    expect((await r.task()).status).toBe("done");
    const task = { ...(await r.task()), reworkRequested: true, reviewComments: "- fix x" };
    expect(buildPrompt("/{skill}", getStage("implementer"), task, "p")).toContain("## Замечания ревью");
  });

  it("verifier appends to the implementation log", async () => {
    const r = await rig({ pi: () => ok("all good") });
    await newTask(r, { status: "verify", skipReview: true, commitSha: "abcdef1" });
    await r.tick();
    const t = await r.task();
    expect(t.status).toBe("done");
    expect(t.implementationLog).toContain("all good");
  });

  it("implementer without commit → blocked (bounded), quarantine after max retries", async () => {
    const r = await rig({ worker: (req) => ok("nothing", req.model, null, null) });
    await newTask(r, { status: "implementing", retryCount: 3 });
    await r.tick();
    const t = await r.task();
    expect(t.status).toBe("blocked_external");
    expect(t.retryAfter).toBeNull();
    expect(t.blockedReason).toMatch(/auto-retry limit/);
  });

  it("runtime errors: non-retryable → blocked without retry; external → backoff", async () => {
    const r = await rig({ pi: (req) => ({ kind: "error", model: req.model, error: { kind: "runtime", category: "context_length", reason: "too long" } }) });
    await newTask(r, { status: "planning" });
    await r.tick();
    expect(await r.task()).toMatchObject({ status: "blocked_external", retryAfter: null });
    r.pi.respond = (req) => ({ kind: "error", model: req.model, error: { kind: "runtime", category: "timeout", reason: "t" } });
    await newTask(r, { status: "planning" });
    await r.tick();
    const t = await r.task("TASK-002");
    expect(t.status).toBe("blocked_external");
    expect(t.retryAfter).not.toBeNull();
    expect(t.retryCount).toBe(1);
  });

  it("runner exception (clone failure) is a plain failure", async () => {
    const r = await rig();
    r.git.failPrepare = true;
    await newTask(r, { status: "planning" });
    await r.tick();
    expect(await r.actions()).toContain("task.stage_failed");
    expect((await r.task()).lockedBy).toBeNull();
  });

  it("system pass: scheduled, auto-queue, claims, watchdog, release, archive", async () => {
    const r = await rig({ projectExtra: "auto_queue_mode: true\n", pi: () => ok("plan") });
    r.worker.online = false;
    const past = "2026-10-29T09:00:00.000Z";
    await newTask(r, { scheduledAt: past, position: 100 }); // TASK-001 scheduled → planning
    await newTask(r, { status: "implementing", lockedBy: "ghost", lockedUntil: past }); // TASK-002 claim released
    await newTask(r, { status: "implementing", stageStartedAt: past, lastHeartbeatAt: "2026-10-29T07:00:00.000Z" }); // TASK-003 watchdog
    await newTask(r, { status: "blocked_external", blockedFromStatus: "planning", retryAfter: past }); // TASK-004 released
    await newTask(r, { status: "verified" }); // TASK-005 archive later
    await r.f.service.mutate("of", "TASK-003", COORDINATOR_ACTOR, () => ({ patch: {}, action: "t", journal: false }));
    await r.c.tick();
    await r.c.idle();
    expect((await r.actions("TASK-001"))).toContain("task.scheduled_fired");
    expect(await r.actions("TASK-002")).toContain("task.claim_released");
    expect(await r.actions("TASK-004")).toContain("task.watchdog_released");
    r.f.clock.advance(8 * 86_400_000);
    await r.c.tick();
    await r.c.idle();
    expect((await r.f.service.getTask("of", "TASK-005")).archived).toBe(true);
    expect(await r.actions("TASK-003")).toEqual(expect.arrayContaining([expect.stringMatching(/^task\.watchdog_/)]));
  });

  it("auto-queue starts the first backlog task", async () => {
    const r = await rig({ projectExtra: "auto_queue_mode: true\n", pi: () => ok("plan") });
    await newTask(r);
    await r.c.tick();
    await r.c.idle();
    expect(await r.actions()).toContain("task.auto_queue_started");
  });

  it("stop() waits for in-flight runs; tick after stop is a no-op", async () => {
    const r = await rig();
    await newTask(r, { status: "planning" });
    await r.c.tick();
    await r.c.stop();
    expect((await r.task()).status).toBe("plan_ready");
    await r.c.tick();
    expect(r.pi.calls).toHaveLength(1);
  });

  it("PC stage lock is worker:pc; worker_available after waiting", async () => {
    let lockSeen: string | null = null;
    const r = await rig();
    r.worker.online = false;
    await newTask(r, { status: "implementing" });
    await r.tick();
    r.f.clock.advance(5 * 60_000);
    r.worker.online = true;
    r.worker.respond = async () => {
      lockSeen = (await r.task()).lockedBy;
      return ok("x", "anthropic/claude-sonnet-4-5", "abcdef1", "of/task-001-t");
    };
    await r.tick();
    expect(lockSeen).toBe("worker:pc");
    expect(await r.actions()).toEqual(expect.arrayContaining(["task.waiting_worker", "task.worker_available"]));
    expect(r.worker.calls[0]?.env).toMatchObject({ HANDOFF_SKIP_REVIEW: "1" });
  });

  it("model switch writes a history line with role", async () => {
    const r = await rig({ pi: (req) => ({ kind: "error", model: req.model, error: { kind: "runtime", category: "no_subscription", reason: "402" } }) });
    await newTask(r, { status: "planning" });
    await r.tick();
    const t = await r.task();
    expect(t.history).toContain("task.model_switched");
    const row = (await r.f.service.history("of", "TASK-001")).find((x) => x.action === "task.model_switched");
    expect(row?.metadata).toContain('"role":"planning"');
    expect((await r.f.store.readModelsState()).models["omniroute/plan-a"]?.manual).toBe(true);
  });

  it("invalid models.json → keep last valid, models.invalid once", async () => {
    const r = await rig({ pi: () => ok("plan") });
    await r.tick(); // loads the valid config
    const { writeFile } = await import("node:fs/promises");
    await writeFile(r.f.store.modelsPath(), "{broken");
    await newTask(r, { status: "planning" });
    await r.tick();
    await r.tick();
    expect((await r.task()).status).toBe("plan_ready");
    const rows = (await r.f.service.projectJournal("of")).filter((x) => x.action === "models.invalid");
    expect(rows).toHaveLength(1);
  });

  it("invalid models.json without a previous version → waiting_model", async () => {
    const r = await rig();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(r.f.store.modelsPath(), "{broken");
    await newTask(r, { status: "planning" });
    await r.tick();
    expect(await r.actions()).toContain("task.waiting_model");
  });

  it("blocked task triage: Pi writes an analysis, status unchanged, once per reason", async () => {
    const r = await rig({ pi: (req) => ok(req.prompt.includes("заблокирована") ? "Причина: нет доступа к API" : "plan") });
    await r.tick(); // load models
    await newTask(r, { status: "blocked_external", blockedReason: "Runtime error (context_length)", blockedFromStatus: "planning" });
    await r.tick();
    let t = await r.task();
    expect(t.status).toBe("blocked_external");
    expect(t.implementationLog).toContain("Разбор блокировки");
    expect(r.pi.calls.at(-1)?.model).toBe("omniroute/review-a");
    const n = r.pi.calls.length;
    await r.tick();
    expect(r.pi.calls.length).toBe(n);
    // limit during triage → model marked, retried later
    await r.f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { blockedReason: "other" }, action: "t" }));
    r.pi.respond = (req) => ({ kind: "error", model: req.model, error: { kind: "runtime", category: "rate_limit", reason: "429" } });
    await r.tick();
    expect((await r.f.store.readModelsState()).models["omniroute/review-a"]).toBeDefined();
    t = await r.task();
    expect(t.status).toBe("blocked_external");
  });

  it("helpers: planPathFor / buildPrompt", async () => {
    const r = await rig();
    await newTask(r);
    const t = await r.task();
    expect(planPathFor(t)).toBe(".ai-factory/PLAN.md");
    expect(planPathFor({ ...t, plannerMode: "full", branch: "of/task-001-x" })).toBe(".ai-factory/plans/task-001-x.md");
    expect(buildPrompt("/skill:{skill}", getStage("reviewer"), t, "p")).toContain("## Blocking Findings");
    expect(buildPrompt("/skill:{skill}", getStage("verifier"), t, "p")).toMatch(/^\/skill:aif-verify/);
    expect(buildPrompt("/skill:{skill}", getStage("plan-checker"), t, "x.md")).toMatch(/^\/skill:aif-plan x\.md/);
  });
});
