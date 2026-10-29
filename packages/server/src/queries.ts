/** List filters shared by `GET /tasks` and `handoff_list_tasks` / `handoff_search_tasks` (AIF params). */
import type { ExecutionOwner, TaskStatus } from "@of/core";
import type { StoredTask } from "./vault/store.js";

export interface TaskFilter {
  status?: TaskStatus | undefined;
  executionOwner?: ExecutionOwner | undefined;
  assigneeId?: string | undefined;
  unassigned?: boolean | undefined;
}

export function filterTasks(list: readonly StoredTask[], f: TaskFilter): StoredTask[] {
  return list.filter(({ task }) => {
    if (f.status !== undefined && task.status !== f.status) return false;
    if (f.executionOwner !== undefined && task.executionOwner !== f.executionOwner) return false;
    if (f.assigneeId !== undefined && !task.assignees.some((a) => a.participantId === f.assigneeId)) return false;
    if (f.unassigned === true && task.assignees.length > 0) return false;
    return true;
  });
}

export function page<T>(list: readonly T[], limit: number | undefined, offset: number | undefined, def = 20, max = 100): T[] {
  const l = Math.min(Math.max(limit ?? def, 1), max);
  const o = Math.max(offset ?? 0, 0);
  return list.slice(o, o + l);
}

export function shortTask(s: StoredTask): Record<string, unknown> {
  const t = s.task;
  return {
    id: t.id,
    ref: `${t.project}/${t.id}`,
    project: t.project,
    title: t.title,
    status: t.status,
    executionOwner: t.executionOwner,
    assignees: t.assignees.map((a) => a.participantId),
    priority: t.priority,
    position: t.position,
    paused: t.paused,
    autoMode: t.autoMode,
    archived: s.archived,
    updated: t.updated,
  };
}
