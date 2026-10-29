/**
 * `handoff_sync_status` rules (spec 9; aif-handoff `mcp/src/tools/syncStatus.ts`).
 */
import type { Task, TaskPatch, TaskStatus } from "./types.js";

export interface SyncStatusInput {
  newStatus: TaskStatus;
  sourceTimestamp: string;
  direction: "aif_to_handoff" | "handoff_to_aif";
  paused?: boolean | undefined;
}

export type SyncStatusDecision =
  | { applied: true; patch: TaskPatch }
  | { applied: false; conflict: boolean; reason: string };

/**
 * - `done` / `verified` → refused (only human events leave them);
 * - same status → no-op;
 * - target newer than source (`updated` > `sourceTimestamp`) → conflict, not applied (last write wins);
 * - agent may only sync AI-owned tasks.
 */
export function decideSyncStatus(task: Task, input: SyncStatusInput, actorIsAgent: boolean, nowIso: string): SyncStatusDecision {
  if (task.status === "done" || task.status === "verified") {
    return {
      applied: false,
      conflict: false,
      reason: `Task is in terminal status '${task.status}'. Use human events (request_changes, approve_done) to transition.`,
    };
  }
  if (actorIsAgent && task.executionOwner !== "ai") {
    return { applied: false, conflict: false, reason: "ai_handoff_required: task is owned by a human" };
  }
  if (task.status === input.newStatus) {
    return { applied: false, conflict: false, reason: "Status already matches" };
  }
  const sourceMs = Date.parse(input.sourceTimestamp);
  const targetMs = Date.parse(task.updated);
  if (!Number.isFinite(sourceMs)) {
    return { applied: false, conflict: false, reason: "sourceTimestamp is not a valid ISO timestamp" };
  }
  if (Number.isFinite(targetMs) && targetMs > sourceMs) {
    return { applied: false, conflict: true, reason: "Target is newer than source (last write wins)" };
  }
  const patch: TaskPatch = { status: input.newStatus, lastSyncedAt: nowIso };
  if (input.paused !== undefined) patch.paused = input.paused;
  return { applied: true, patch };
}
