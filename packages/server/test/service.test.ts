import { describe, expect, it } from "vitest";
import { COORDINATOR_ACTOR, ServiceError } from "../src/service.js";
import { AGENT, OWNER, BOB, makeFixture } from "./helpers.js";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ServiceError) return err.code;
    throw err;
  }
  return "ok";
}

describe("TaskService", () => {
  it("projects: list/get/update (admin only)", async () => {
    const f = await makeFixture();
    expect((await f.service.listProjects()).map((p) => p.id)).toEqual(["of"]);
    expect(await code(f.service.getProject("zz"))).toBe("not_found");
    const p = await f.service.updateProject("of", { autoQueueMode: true }, OWNER);
    expect(p.autoQueueMode).toBe(true);
    expect((await f.service.getProject("of")).autoQueueMode).toBe(true);
    expect(await code(f.service.updateProject("of", { autoQueueMode: false }, BOB))).toBe("forbidden");
    expect(await code(f.service.updateProject("of", { autoQueueMode: false }, AGENT))).toBe("forbidden");
    expect(await code(f.service.updateProject("zz", {}, OWNER))).toBe("not_found");
    expect(f.events.some((e) => e.type === "project.changed")).toBe(true);
    expect(f.service.listParticipants()).toHaveLength(3);
    expect(f.service.participant("nobody")).toBeNull();
  });

  it("creates tasks with sequential ids, journal, history", async () => {
    const f = await makeFixture();
    const a = await f.service.createTask("of", { title: "  First " }, OWNER);
    const b = await f.service.createTask("of", { title: "Second", priority: 2 }, AGENT, 3);
    expect([a.task.id, b.task.id]).toEqual(["TASK-001", "TASK-002"]);
    expect(a.task.title).toBe("First");
    expect(b.task.position).toBeGreaterThan(a.task.position);
    expect(a.task.history).toContain("task.created");
    expect((await f.service.getProject("of")).nextTaskNumber).toBe(3);
    expect(await code(f.service.createTask("of", { title: " " }, OWNER))).toBe("validation");
    expect(await code(f.service.createTask("of", { title: "x", priority: 4 }, AGENT, 3))).toBe("validation");
    expect(await code(f.service.createTask("zz", { title: "x" }, OWNER))).toBe("not_found");
    const list = await f.service.listTasks("of");
    expect(list.map((t) => t.task.id)).toEqual(["TASK-001", "TASK-002"]);
    expect(await f.service.listTasks("of", { status: "planning" })).toEqual([]);
    const hist = await f.service.history("of", "TASK-001");
    expect(hist.map((r) => r.action)).toEqual(["task.created"]);
    expect((await f.service.projectJournal("of")).length).toBe(2);
    expect(f.events.filter((e) => e.type === "task.created")).toHaveLength(2);
    const view = f.service.view(a, OWNER);
    expect(view.permissions.permittedActions).toContain("start_ai");
    expect(view.archived).toBe(false);
  });

  it("search", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "Board drag", tags: ["plugin"] }, OWNER);
    await f.service.createTask("of", { title: "Server", description: "MCP tools" }, OWNER);
    expect((await f.service.searchTasks("mcp")).map((t) => t.task.id)).toEqual(["TASK-002"]);
    expect((await f.service.searchTasks("PLUGIN", { project: "of" })).map((t) => t.task.id)).toEqual(["TASK-001"]);
    expect((await f.service.searchTasks("task-", { limit: 1 }))).toHaveLength(1);
    expect(await code(f.service.searchTasks("  "))).toBe("validation");
  });

  it("updateTask validates and respects ownership", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    const u = await f.service.updateTask("of", "TASK-001", { title: "New", priority: 5, maxReviewIterations: 5, useSubagents: true, runPostVerify: true, scheduledAt: null, blockedReason: "x" }, OWNER);
    expect(u.task).toMatchObject({ title: "New", priority: 5, maxReviewIterations: 5, useSubagents: true, runPostVerify: false, runPlanImprove: false });
    expect(await code(f.service.updateTask("of", "TASK-001", {}, OWNER))).toBe("validation");
    expect(await code(f.service.updateTask("of", "TASK-001", { title: " " }, OWNER))).toBe("validation");
    expect(await code(f.service.updateTask("of", "TASK-001", { priority: 9 }, OWNER))).toBe("validation");
    expect(await code(f.service.updateTask("of", "TASK-001", { maxReviewIterations: 0 }, OWNER))).toBe("validation");
    expect(await code(f.service.updateTask("of", "TASK-001", { scheduledAt: "nope" }, OWNER))).toBe("validation");
    expect(await code(f.service.updateTask("of", "TASK-404", { title: "x" }, OWNER))).toBe("not_found");
    await f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0 }, OWNER);
    expect(await code(f.service.updateTask("of", "TASK-001", { description: "x" }, AGENT))).toBe("ai_handoff_required");
    expect(await code(f.service.pushPlan("of", "TASK-001", "plan", AGENT))).toBe("ai_handoff_required");
  });

  it("events: reason required, expected status, permissions", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    expect(await code(f.service.applyEvent("of", "TASK-001", "start_ai", OWNER, { requireReason: true }))).toBe("reason_required");
    expect(await code(f.service.applyEvent("of", "TASK-001", "start_ai", OWNER, { reason: "go", expectedStatus: "planning" }))).toBe("status_conflict");
    expect(await code(f.service.applyEvent("of", "TASK-001", "approve_done", OWNER, { reason: "x" }))).toBe("action_not_allowed");
    expect(await code(f.service.applyEvent("of", "TASK-001", "start_ai", BOB, { reason: "x" }))).toBe("actor_not_authorized");
    const s = await f.service.applyEvent("of", "TASK-001", "start_ai", OWNER, { reason: "go", expectedStatus: "backlog", requireReason: true });
    expect(s.task.status).toBe("planning");
    expect(s.task.history).toContain("backlog → planning — go");
    const rows = await f.service.history("of", "TASK-001");
    expect(rows.at(-1)).toMatchObject({ action: "task.event.start_ai", from: "backlog", to: "planning", reason: "go" });
  });

  it("request_changes clears commit", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { status: "done", commitSha: "abcdef1" }, action: "test" }));
    const s = await f.service.applyEvent("of", "TASK-001", "request_changes", OWNER, { reason: "fix" });
    expect(s.task).toMatchObject({ status: "implementing", commitSha: null });
  });

  it("handoff: admin, assignee, coordinator; conflicts", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    expect(await code(f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["bob"], expectedOwnershipRevision: 0 }, BOB))).toBe("forbidden");
    expect(await code(f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["bob"], expectedOwnershipRevision: 5 }, OWNER))).toBe("ownership_revision_conflict");
    expect(await code(f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["old"], expectedOwnershipRevision: 0 }, OWNER))).toBe("inactive_assignee");
    const h = await f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["bob"], expectedOwnershipRevision: 0, reason: "me" }, OWNER);
    expect(h.task).toMatchObject({ executionOwner: "human", ownershipRevision: 1 });
    expect(h.task.assignees.map((a) => a.participantId)).toEqual(["bob"]);
    const back = await f.service.handoff("of", "TASK-001", { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 1 }, BOB);
    expect(back.task).toMatchObject({ executionOwner: "ai", status: "planning", ownershipRevision: 2 });
    // coordinator handing off its own locked task
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { status: "review", lockedBy: "coordinator", lockedUntil: "2099-01-01T00:00:00.000Z" }, action: "t" }));
    expect(await code(f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 2 }, OWNER))).toBe("task_locked");
    const c = await f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 2, allowLockedBy: "coordinator" }, COORDINATOR_ACTOR);
    expect(c.task).toMatchObject({ lockedBy: null, executionOwner: "human" });
  });

  it("sync_status: applied, no-op, conflict, terminal, human-owned", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    const later = new Date(f.clock.ms + 1000).toISOString();
    const same = await f.service.syncStatus("of", "TASK-001", { newStatus: "backlog", sourceTimestamp: later, direction: "aif_to_handoff" }, AGENT);
    expect(same.applied).toBe(false);
    const ok = await f.service.syncStatus("of", "TASK-001", { newStatus: "planning", sourceTimestamp: later, direction: "aif_to_handoff", paused: false }, AGENT);
    expect(ok).toMatchObject({ applied: true, conflict: false });
    expect(ok.task.task.status).toBe("planning");
    const old = await f.service.syncStatus("of", "TASK-001", { newStatus: "plan_ready", sourceTimestamp: "2020-01-01T00:00:00Z", direction: "aif_to_handoff" }, AGENT);
    expect(old.conflict).toBe(true);
  });

  it("plans: push and annotate under a heading", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    await f.service.pushPlan("of", "TASK-001", "# Plan\n\n## Steps\n- a\n\n## Notes\nn", AGENT);
    const a = await f.service.annotatePlan("of", "TASK-001", "- b", "Steps", AGENT);
    expect(a.task.plan).toBe("# Plan\n\n## Steps\n- a\n\n- b\n\n## Notes\nn");
    const b = await f.service.annotatePlan("of", "TASK-001", "x", "## Notes", AGENT);
    expect(b.task.plan.endsWith("## Notes\nn\n\nx\n")).toBe(true);
    const c = await f.service.annotatePlan("of", "TASK-001", "new", null, AGENT);
    expect(c.task.plan).toContain("## Annotations\n\nnew");
    await f.service.createTask("of", { title: "Empty" }, OWNER);
    expect((await f.service.annotatePlan("of", "TASK-002", "z", " ", AGENT)).task.plan).toBe("## Annotations\n\nz\n");
    expect(await code(f.service.annotatePlan("of", "TASK-002", "  ", null, AGENT))).toBe("validation");
    await f.service.handoff("of", "TASK-002", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0 }, OWNER);
    expect(await code(f.service.annotatePlan("of", "TASK-002", "z", null, AGENT))).toBe("ai_handoff_required");
  });

  it("touch refreshes heartbeat silently for ai tasks only", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    await f.service.touch("of", "TASK-001", AGENT);
    expect((await f.service.getTask("of", "TASK-001")).task.lastHeartbeatAt).toBe(f.clock.now().toISOString());
    await f.service.touch("of", "TASK-404", AGENT);
    await f.service.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0 }, OWNER);
    f.clock.advance(1000);
    await f.service.touch("of", "TASK-001", AGENT);
    expect((await f.service.getTask("of", "TASK-001")).task.lastHeartbeatAt).not.toBe(f.clock.now().toISOString());
  });

  it("commits: validation, verification, dedupe", async () => {
    let verified = true;
    const f = await makeFixture({ verifier: { verify: () => Promise.resolve(verified) } });
    await f.service.createTask("of", { title: "T" }, OWNER);
    expect(await code(f.service.addCommit("of", "TASK-001", "zz", "main", AGENT))).toBe("validation");
    expect(await code(f.service.addCommit("of", "TASK-001", "abcdef1", "a..b", AGENT))).toBe("validation");
    const s = await f.service.addCommit("of", "TASK-001", "abcdef1", "of/task-001", AGENT);
    expect(s.task.commits).toHaveLength(1);
    expect(s.task.commitSha).toBe("abcdef1");
    expect((await f.service.addCommit("of", "TASK-001", "abcdef1", "of/task-001", AGENT)).task.commits).toHaveLength(1);
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { commitSha: null }, action: "t" }));
    expect((await f.service.addCommit("of", "TASK-001", "abcdef1", "of/task-001", AGENT)).task.commitSha).toBe("abcdef1");
    verified = false;
    expect(await code(f.service.addCommit("of", "TASK-001", "abcdef2", "of/task-001", AGENT))).toBe("commit_not_found");
  });

  it("archive / restore", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { status: "planning" }, action: "t" }));
    expect(await code(f.service.setArchived("of", "TASK-001", true, OWNER))).toBe("action_not_allowed");
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { status: "verified" }, action: "t" }));
    const a = await f.service.setArchived("of", "TASK-001", true, OWNER, "old");
    expect(a.archived).toBe(true);
    expect(a.task.history).toContain("task.archived");
    expect(await f.service.setArchived("of", "TASK-001", true, OWNER)).toMatchObject({ archived: true });
    expect(await f.service.listTasks("of")).toEqual([]);
    expect(await f.service.listTasks("of", { includeArchived: true })).toHaveLength(1);
    expect((await f.service.setArchived("of", "TASK-001", false, OWNER)).archived).toBe(false);
    expect(await code(f.service.setArchived("of", "TASK-404", false, OWNER))).toBe("not_found");
  });

  it("heartbeat, note, mutate null, emitRaw", async () => {
    const f = await makeFixture();
    await f.service.createTask("of", { title: "T" }, OWNER);
    expect(await f.service.heartbeat("of", "TASK-001", COORDINATOR_ACTOR, 60_000)).toBeNull();
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { lockedBy: "coordinator" }, action: "t" }));
    const before = (await f.service.history("of", "TASK-001")).length;
    const hb = await f.service.heartbeat("of", "TASK-001", COORDINATOR_ACTOR, 60_000);
    expect(hb?.task.lastHeartbeatAt).toBe(f.clock.now().toISOString());
    expect((await f.service.history("of", "TASK-001")).length).toBe(before);
    expect(await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => null)).toBeNull();
    await f.service.note("of", "TASK-001", COORDINATOR_ACTOR, "task.waiting_worker", "pc off", { a: 1 });
    expect((await f.service.history("of", "TASK-001")).at(-1)?.action).toBe("task.waiting_worker");
    f.service.emitRaw("models.changed", { x: 1 });
    expect(f.events.at(-1)?.type).toBe("models.changed");
    expect(await code(f.service.mutate("of", "TASK-404", COORDINATOR_ACTOR, () => null))).toBe("not_found");
    expect(await code(f.service.history("of", "TASK-404"))).toBe("not_found");
  });

  it("serialises concurrent creates (single writer)", async () => {
    const f = await makeFixture();
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.createTask("of", { title: `T${String(i)}` }, OWNER)));
    expect(new Set(created.map((c) => c.task.id)).size).toBe(8);
    expect(f.service.clock()).toBeInstanceOf(Date);
    const all = await f.service.listAllActive();
    expect(all[0]?.tasks).toHaveLength(8);
  });

  it("listAllActive skips paused projects", async () => {
    const f = await makeFixture({ projectExtra: "status: paused\n" });
    expect(await f.service.listAllActive()).toEqual([]);
  });
});
