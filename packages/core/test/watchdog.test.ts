import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCHDOG_CONFIG,
  autoQueueCapacity,
  fireScheduled,
  isWatchdogCandidate,
  parseTimestampMs,
  pickAutoQueueTasks,
  recoverStale,
  releaseDueBlocked,
  shouldAutoArchive,
  shouldReleaseClaim,
} from "../src/watchdog.js";
import { NOW, makeTask } from "./helpers.js";

const cfg = DEFAULT_WATCHDOG_CONFIG;
const old = "2026-10-29T08:00:00.000Z"; // 120 min before NOW

describe("watchdog (AIF taskWatchdog.ts)", () => {
  it("defaults: 90 min, 3 retries, attempt recovery on", () => {
    expect(cfg).toEqual({ staleTimeoutMs: 5_400_000, staleMaxRetry: 3, attemptRecoveryEnabled: true });
  });
  it("parses timestamps like AIF", () => {
    expect(parseTimestampMs("2026-10-29 10:00:00")).toBe(Date.parse("2026-10-29T10:00:00Z"));
    expect(parseTimestampMs("bad")).toBeNull();
    expect(parseTimestampMs(null)).toBeNull();
  });
  it("releases due blocked tasks", () => {
    const t = makeTask("blocked_external", { blockedFromStatus: "review", retryAfter: old, retryCount: 2 });
    expect(releaseDueBlocked(t, NOW, cfg)).toEqual({
      patch: { status: "review", blockedReason: null, blockedFromStatus: null, retryAfter: null, retryCount: 2 },
      action: "task.watchdog_released",
      reason: null,
      expectedStatus: "blocked_external",
    });
    expect(releaseDueBlocked(t, NOW, { ...cfg, attemptRecoveryEnabled: false })?.patch.retryCount).toBe(0);
    expect(releaseDueBlocked({ ...t, retryAfter: "2026-10-29T11:00:00Z" }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked({ ...t, retryAfter: null }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked({ ...t, blockedFromStatus: null }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked({ ...t, paused: true }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked({ ...t, executionOwner: "human" }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked({ ...t, retryAfter: "garbage" }, NOW, cfg)).toBeNull();
    expect(releaseDueBlocked(makeTask("review"), NOW, cfg)).toBeNull();
  });
  it("candidates: in-progress, ai, not paused, started stage (attempt recovery), unlocked", () => {
    const t = makeTask("implementing", { stageStartedAt: old, updated: old });
    expect(isWatchdogCandidate(t, NOW, cfg)).toBe(true);
    expect(isWatchdogCandidate({ ...t, stageStartedAt: null }, NOW, cfg)).toBe(false);
    expect(isWatchdogCandidate({ ...t, stageStartedAt: null }, NOW, { ...cfg, attemptRecoveryEnabled: false })).toBe(true);
    expect(isWatchdogCandidate({ ...t, status: "plan_ready" }, NOW, cfg)).toBe(false);
    expect(isWatchdogCandidate({ ...t, lockedBy: "c", lockedUntil: "2026-10-29T11:00:00Z" }, NOW, cfg)).toBe(false);
    expect(isWatchdogCandidate({ ...t, lockedBy: "c", lockedUntil: old }, NOW, cfg)).toBe(true);
    expect(isWatchdogCandidate({ ...t, paused: true }, NOW, cfg)).toBe(false);
    expect(isWatchdogCandidate({ ...t, executionOwner: "human" }, NOW, cfg)).toBe(false);
  });
  it("stale task → blocked with backoff, retry +1", () => {
    const t = makeTask("implementing", { stageStartedAt: old, updated: old, lastHeartbeatAt: old, retryCount: 1 });
    expect(recoverStale(t, NOW, cfg, 0)).toEqual({
      patch: {
        status: "blocked_external",
        blockedReason: "Watchdog: task stale in implementing for 120m; auto-recover scheduled",
        blockedFromStatus: "implementing",
        retryAfter: "2026-10-29T10:05:00.000Z",
        retryCount: 2,
      },
      action: "task.watchdog_recovery_scheduled",
      reason: null,
      expectedStatus: "implementing",
    });
  });
  it("after max retries → quarantine without retry_after", () => {
    const t = makeTask("review", { stageStartedAt: old, updated: old, retryCount: 3 });
    expect(recoverStale(t, NOW, cfg, 0)).toMatchObject({ action: "task.watchdog_quarantined", patch: { retryAfter: null, blockedFromStatus: "review" } });
  });
  it("fresh heartbeat keeps the task alive; no timestamps → skip", () => {
    const t = makeTask("implementing", { stageStartedAt: old, updated: old, lastHeartbeatAt: "2026-10-29T09:30:00Z" });
    expect(recoverStale(t, NOW, cfg, 0)).toBeNull();
    expect(recoverStale({ ...t, lastHeartbeatAt: null, updated: "x" }, NOW, cfg, 0)).toBeNull();
    expect(recoverStale({ ...t, lastHeartbeatAt: old, updated: "x" }, NOW, cfg, 0)).not.toBeNull();
    expect(recoverStale(makeTask("plan_ready"), NOW, cfg, 0)).toBeNull();
  });
  it("min timeout and min retries are enforced", () => {
    const t = makeTask("planning", { stageStartedAt: old, updated: "2026-10-29T09:59:30Z" });
    expect(recoverStale(t, NOW, { ...cfg, staleTimeoutMs: 1 }, 0)).toBeNull();
    expect(recoverStale({ ...t, updated: old, retryCount: 1 }, NOW, { ...cfg, staleMaxRetry: 0 }, 0)?.action).toBe("task.watchdog_quarantined");
  });
  it("releases stale claims", () => {
    expect(shouldReleaseClaim(makeTask("planning"), NOW)).toBe(false);
    expect(shouldReleaseClaim(makeTask("planning", { lockedBy: "c", lockedUntil: old }), NOW)).toBe(true);
    const live = { lockedBy: "c", lockedUntil: "2026-10-29T12:00:00Z" };
    expect(shouldReleaseClaim(makeTask("planning", { ...live, updated: old, lastHeartbeatAt: old }), NOW)).toBe(true);
    expect(shouldReleaseClaim(makeTask("planning", { ...live, updated: old, lastHeartbeatAt: null }), NOW)).toBe(true);
    expect(shouldReleaseClaim(makeTask("planning", { ...live, updated: old, lastHeartbeatAt: "2026-10-29T09:58:00Z" }), NOW)).toBe(false);
    expect(shouldReleaseClaim(makeTask("plan_ready", { ...live, updated: old }), NOW)).toBe(false);
    expect(shouldReleaseClaim(makeTask("planning", { ...live, updated: "2026-10-29T09:58:00Z" }), NOW)).toBe(false);
  });
  it("scheduler fires due backlog tasks", () => {
    const t = makeTask("backlog", { scheduledAt: old });
    expect(fireScheduled(t, NOW)).toMatchObject({ patch: { status: "planning", scheduledAt: null }, expectedStatus: "backlog" });
    expect(fireScheduled({ ...t, scheduledAt: "2026-10-29T11:00:00Z" }, NOW)).toBeNull();
    expect(fireScheduled({ ...t, scheduledAt: null }, NOW)).toBeNull();
    expect(fireScheduled({ ...t, scheduledAt: "bad" }, NOW)).toBeNull();
    expect(fireScheduled({ ...t, paused: true }, NOW)).toBeNull();
    expect(fireScheduled({ ...t, status: "planning" }, NOW)).toBeNull();
  });
  it("auto-queue: 1 in flight, or 3 with parallel", () => {
    expect(autoQueueCapacity(false)).toBe(1);
    expect(autoQueueCapacity(true)).toBe(3);
    const backlog = [
      makeTask("backlog", { id: "TASK-002", position: 2 }),
      makeTask("backlog", { id: "TASK-001", position: 1 }),
      makeTask("backlog", { id: "TASK-003", position: 0, paused: true }),
      makeTask("backlog", { id: "TASK-004", position: 0, scheduledAt: "2026-10-30T00:00:00Z" }),
      makeTask("backlog", { id: "TASK-005", position: 5, scheduledAt: old }),
    ];
    const on = { autoQueueMode: true, parallelEnabled: false };
    expect(pickAutoQueueTasks(backlog, on, NOW).map((t) => t.id)).toEqual(["TASK-001"]);
    expect(pickAutoQueueTasks([...backlog, makeTask("review")], on, NOW)).toEqual([]);
    expect(pickAutoQueueTasks([...backlog, makeTask("done")], { autoQueueMode: true, parallelEnabled: true }, NOW).map((t) => t.id)).toEqual(["TASK-001", "TASK-002", "TASK-005"]);
    expect(pickAutoQueueTasks(backlog, { autoQueueMode: false, parallelEnabled: false }, NOW)).toEqual([]);
    expect(pickAutoQueueTasks(backlog, on, NOW, false)).toEqual([]);
  });
  it("auto-archive verified tasks after N days", () => {
    expect(shouldAutoArchive(makeTask("verified", { updated: "2026-10-20T00:00:00Z" }), NOW, 7)).toBe(true);
    expect(shouldAutoArchive(makeTask("verified", { updated: "2026-10-28T00:00:00Z" }), NOW, 7)).toBe(false);
    expect(shouldAutoArchive(makeTask("done", { updated: "2026-10-20T00:00:00Z" }), NOW, 7)).toBe(false);
    expect(shouldAutoArchive(makeTask("verified", { updated: "2026-10-20T00:00:00Z" }), NOW, 0)).toBe(false);
  });
});
