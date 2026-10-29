/**
 * Watchdog and system transitions as pure functions. Mirrors aif-handoff
 * `agent/src/taskWatchdog.ts` and data queries (bf6a8b6, MIT).
 */
import { getRandomBackoffMinutes } from "./pipeline.js";
import { IN_PROGRESS_STATUSES } from "./types.js";
import type { Task, TaskPatch, TaskStatus } from "./types.js";

export interface WatchdogConfig {
  /** AIF `AGENT_STAGE_STALE_TIMEOUT_MS` (spec: 90 min), min 60 s. */
  staleTimeoutMs: number;
  /** AIF `AGENT_STAGE_STALE_MAX_RETRY` (spec: 3), min 1. */
  staleMaxRetry: number;
  /** AIF `AIF_AGENT_ATTEMPT_RECOVERY_ENABLED` (spec: true). */
  attemptRecoveryEnabled: boolean;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  staleTimeoutMs: 90 * 60_000,
  staleMaxRetry: 3,
  attemptRecoveryEnabled: true,
};

export interface SystemTransition {
  patch: TaskPatch;
  action: string;
  reason: string | null;
  expectedStatus: TaskStatus;
}

export function parseTimestampMs(value: string | null): number | null {
  if (value === null) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const normalized = !hasTimezone && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function isInProgress(status: TaskStatus): boolean {
  return (IN_PROGRESS_STATUSES as readonly TaskStatus[]).includes(status);
}

/** AIF `listDueBlockedExternalTasks` + `releaseDueBlockedTasks`. */
export function releaseDueBlocked(task: Task, now: Date, config: WatchdogConfig): SystemTransition | null {
  if (task.status !== "blocked_external" || task.executionOwner !== "ai" || task.paused) return null;
  if (task.retryAfter === null || task.blockedFromStatus === null) return null;
  const retryMs = parseTimestampMs(task.retryAfter);
  if (retryMs === null || retryMs > now.getTime()) return null;
  return {
    patch: {
      status: task.blockedFromStatus,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: config.attemptRecoveryEnabled ? task.retryCount : 0,
    },
    action: "task.watchdog_released",
    reason: null,
    expectedStatus: "blocked_external",
  };
}

/** AIF `listStaleInProgressTasks` filter. */
export function isWatchdogCandidate(task: Task, now: Date, config: WatchdogConfig): boolean {
  if (!isInProgress(task.status) || task.executionOwner !== "ai" || task.paused) return false;
  if (config.attemptRecoveryEnabled && task.stageStartedAt === null) return false;
  const lockMs = parseTimestampMs(task.lockedUntil);
  return task.lockedBy === null || (lockMs !== null && lockMs <= now.getTime());
}

/** AIF `recoverStaleInProgressTasks` for one task. `random` in [0,1). */
export function recoverStale(task: Task, now: Date, config: WatchdogConfig, random: number): SystemTransition | null {
  if (!isWatchdogCandidate(task, now, config)) return null;
  const heartbeatMs = parseTimestampMs(task.lastHeartbeatAt);
  const updatedMs = parseTimestampMs(task.updated);
  const referenceMs = heartbeatMs !== null && updatedMs !== null ? Math.max(heartbeatMs, updatedMs) : (heartbeatMs ?? updatedMs);
  if (referenceMs === null) return null;
  const staleTimeoutMs = Math.max(config.staleTimeoutMs, 60_000);
  const staleMaxRetry = Math.max(config.staleMaxRetry, 1);
  const ageMs = now.getTime() - referenceMs;
  if (ageMs < staleTimeoutMs) return null;
  const ageMinutes = Math.floor(ageMs / 60_000);
  const reasonBase = `Watchdog: task stale in ${task.status} for ${String(ageMinutes)}m`;
  if (task.retryCount >= staleMaxRetry) {
    return {
      patch: {
        status: "blocked_external",
        blockedReason: `${reasonBase}; auto-retry limit reached (${String(staleMaxRetry)})`,
        blockedFromStatus: task.status,
        retryAfter: null,
      },
      action: "task.watchdog_quarantined",
      reason: null,
      expectedStatus: task.status,
    };
  }
  const retryAfter = new Date(now.getTime() + getRandomBackoffMinutes(random) * 60_000).toISOString();
  return {
    patch: {
      status: "blocked_external",
      blockedReason: `${reasonBase}; auto-recover scheduled`,
      blockedFromStatus: task.status,
      retryAfter,
      retryCount: task.retryCount + 1,
    },
    action: "task.watchdog_recovery_scheduled",
    reason: null,
    expectedStatus: task.status,
  };
}

/** AIF `releaseStaleTaskClaims`: lock TTL expired, or heartbeat dead for 5 min. */
export function shouldReleaseClaim(task: Task, now: Date): boolean {
  if (task.lockedBy === null) return false;
  const lockMs = parseTimestampMs(task.lockedUntil);
  if (lockMs !== null && lockMs <= now.getTime()) return true;
  if (!isInProgress(task.status)) return false;
  const deadline = now.getTime() - 5 * 60_000;
  const updatedMs = parseTimestampMs(task.updated);
  const heartbeatMs = parseTimestampMs(task.lastHeartbeatAt);
  return updatedMs !== null && updatedMs <= deadline && (heartbeatMs === null || heartbeatMs <= deadline);
}

/** AIF `listDueScheduledTasks` → `backlog → planning` (scheduler). */
export function fireScheduled(task: Task, now: Date): SystemTransition | null {
  if (task.status !== "backlog" || task.executionOwner !== "ai" || task.paused || task.scheduledAt === null) return null;
  const ms = parseTimestampMs(task.scheduledAt);
  if (ms === null || ms > now.getTime()) return null;
  return {
    patch: {
      status: "planning",
      scheduledAt: null,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: 0,
      reworkRequested: false,
      reviewIterationCount: 0,
      manualReviewRequired: false,
      autoReviewState: null,
    },
    action: "task.scheduled_fired",
    reason: null,
    expectedStatus: "backlog",
  };
}

/** Max tasks in flight for auto-queue (AIF: 1, or `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` = 3 when parallel). */
export function autoQueueCapacity(parallelEnabled: boolean, perProjectMax = 3): number {
  return parallelEnabled ? perProjectMax : 1;
}

const NON_TERMINAL_IN_FLIGHT: readonly TaskStatus[] = ["planning", "improve", "plan_ready", "implementing", "review", "verify", "blocked_external"];

/**
 * AIF `processAutoQueueAdvance` for one project: which backlog tasks to start now.
 * In flight = non-terminal, non-backlog statuses. `worktreeClean` is the AIF dirty-tree gate.
 */
export function pickAutoQueueTasks(
  tasks: readonly Task[],
  project: { autoQueueMode: boolean; parallelEnabled: boolean },
  now: Date,
  worktreeClean = true,
): Task[] {
  if (!project.autoQueueMode || !worktreeClean) return [];
  const inFlight = tasks.filter((t) => NON_TERMINAL_IN_FLIGHT.includes(t.status)).length;
  const free = autoQueueCapacity(project.parallelEnabled) - inFlight;
  if (free <= 0) return [];
  return tasks
    .filter((t) => {
      if (t.status !== "backlog" || t.executionOwner !== "ai" || t.paused) return false;
      const ms = parseTimestampMs(t.scheduledAt);
      return t.scheduledAt === null || (ms !== null && ms <= now.getTime());
    })
    .sort((a, b) => a.position - b.position || a.created.localeCompare(b.created) || a.id.localeCompare(b.id))
    .slice(0, free);
}

/** Р-011 addition: auto-archive `verified` tasks after N days. */
export function shouldAutoArchive(task: Task, now: Date, days: number): boolean {
  if (task.status !== "verified" || days <= 0) return false;
  const ms = parseTimestampMs(task.updated);
  return ms !== null && now.getTime() - ms >= days * 86_400_000;
}
