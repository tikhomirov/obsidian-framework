import { describe, expect, it } from "vitest";
import { checkExpectedStatus, hasLiveLock, resolveHandoff } from "../src/ownership.js";
import type { TaskAssignee } from "../src/types.js";
import { NOW, makeTask } from "./helpers.js";

const owner: TaskAssignee = { participantId: "owner", displayName: "Owner", role: "admin", active: true };
const people = (id: string): TaskAssignee | null => (id === "owner" ? owner : id === "old" ? { ...owner, participantId: "old", active: false } : null);

describe("handoff (AIF taskOwnership.ts)", () => {
  it("ai → human bumps ownership_revision", () => {
    const r = resolveHandoff(makeTask("review"), { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0 }, people, NOW);
    expect(r).toEqual({ ok: true, patch: { executionOwner: "human", assignees: [owner], ownershipRevision: 1, stageStartedAt: null } });
  });
  it("human → ai from backlog starts planning", () => {
    const r = resolveHandoff(makeTask("backlog", { executionOwner: "human", assignees: [owner], ownershipRevision: 2 }), { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 2 }, people, NOW);
    expect(r).toMatchObject({ ok: true, patch: { status: "planning", ownershipRevision: 3, executionOwner: "ai", retryCount: 0 } });
  });
  it("human → ai plan_ready (auto_mode off) requires start_implementation", () => {
    const t = makeTask("plan_ready", { executionOwner: "human", autoMode: false });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 0 }, people, NOW)).toMatchObject({ ok: false, code: "invalid_ownership_transition" });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 0, resumeAction: "start_implementation" }, people, NOW)).toMatchObject({ ok: true, patch: { status: "implementing" } });
  });
  it("human → ai blocked requires retry_from_blocked and blocked_from", () => {
    const t = makeTask("blocked_external", { executionOwner: "human", blockedFromStatus: "verify" });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 0 }, people, NOW)).toMatchObject({ ok: false, code: "invalid_ownership_transition" });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 0, resumeAction: "retry_from_blocked" }, people, NOW)).toMatchObject({ ok: true, patch: { status: "verify" } });
    expect(resolveHandoff({ ...t, blockedFromStatus: null }, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 0, resumeAction: "retry_from_blocked" }, people, NOW)).toMatchObject({ ok: false });
  });
  it("conflicts", () => {
    const t = makeTask("review", { ownershipRevision: 4 });
    expect(resolveHandoff(t, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 3 }, people, NOW)).toMatchObject({ code: "ownership_revision_conflict" });
    expect(resolveHandoff(t, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 4, expectedExecutionOwner: "human" }, people, NOW)).toMatchObject({ code: "ownership_revision_conflict" });
    expect(resolveHandoff(t, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 4, expectedStatus: "done" }, people, NOW)).toMatchObject({ code: "ownership_revision_conflict" });
    expect(resolveHandoff({ ...t, status: "verified" }, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 4 }, people, NOW)).toMatchObject({ code: "invalid_ownership_transition" });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: ["owner"], expectedOwnershipRevision: 4 }, people, NOW)).toMatchObject({ code: "invalid_ownership_transition" });
    expect(resolveHandoff(t, { executionOwner: "human", assigneeIds: ["old"], expectedOwnershipRevision: 4 }, people, NOW)).toMatchObject({ code: "inactive_assignee" });
    expect(resolveHandoff(t, { executionOwner: "human", assigneeIds: ["nobody"], expectedOwnershipRevision: 4 }, people, NOW)).toMatchObject({ code: "inactive_assignee" });
    expect(resolveHandoff(t, { executionOwner: "ai", assigneeIds: [], expectedOwnershipRevision: 4 }, people, NOW)).toMatchObject({ code: "invalid_ownership_transition" });
  });
  it("locks", () => {
    const locked = makeTask("implementing", { lockedBy: "coord", lockedUntil: "2026-10-29T11:00:00Z" });
    expect(resolveHandoff(locked, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 0 }, people, NOW)).toMatchObject({ code: "task_locked" });
    expect(resolveHandoff(locked, { executionOwner: "human", assigneeIds: [], expectedOwnershipRevision: 0, allowLockedBy: "coord" }, people, NOW).ok).toBe(true);
    expect(hasLiveLock({ lockedBy: "c", lockedUntil: null }, NOW)).toBe(true);
    expect(hasLiveLock({ lockedBy: "c", lockedUntil: "2026-10-29T09:00:00Z" }, NOW)).toBe(false);
    expect(hasLiveLock({ lockedBy: null, lockedUntil: null }, NOW)).toBe(false);
  });
  it("expected_status check", () => {
    expect(checkExpectedStatus({ status: "review" }, undefined)).toBe(true);
    expect(checkExpectedStatus({ status: "review" }, "review")).toBe(true);
    expect(checkExpectedStatus({ status: "review" }, "done")).toBe(false);
  });
});
