/** Task numbering (Р-014, Р-015): `TASK-NNN` per project, outside — `<project>/TASK-NNN`. */
const TASK_ID_RE = /^TASK-(\d{3,6})$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function formatTaskId(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Task number must be a positive integer, got ${String(n)}`);
  return `TASK-${String(n).padStart(3, "0")}`;
}

export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value);
}

export function isProjectId(value: string): boolean {
  return PROJECT_ID_RE.test(value);
}

export function taskNumber(id: string): number {
  const m = TASK_ID_RE.exec(id);
  if (!m?.[1]) throw new RangeError(`Not a task id: ${id}`);
  return Number(m[1]);
}

export interface TaskRef {
  project: string;
  id: string;
}

/** Accepts `of/TASK-012`, `of:TASK-012` or `TASK-012` (with a default project). */
export function parseTaskRef(value: string, defaultProject?: string): TaskRef | null {
  const trimmed = value.trim();
  const sep = /[/:]/.exec(trimmed);
  if (sep) {
    const project = trimmed.slice(0, sep.index);
    const id = trimmed.slice(sep.index + 1);
    return isProjectId(project) && isTaskId(id) ? { project, id } : null;
  }
  if (isTaskId(trimmed) && defaultProject !== undefined && isProjectId(defaultProject)) {
    return { project: defaultProject, id: trimmed };
  }
  return null;
}

export function formatTaskRef(ref: TaskRef): string {
  return `${ref.project}/${ref.id}`;
}

/** Next id: max of the stored counter and existing numbers + 1 (ID is issued by the backend, Р-010). */
export function nextTaskNumber(counter: number, existingIds: readonly string[]): number {
  const maxExisting = existingIds.filter(isTaskId).reduce((max, id) => Math.max(max, taskNumber(id)), 0);
  return Math.max(counter, maxExisting + 1, 1);
}

/** AIF-like branch name for `planner_mode: full`. */
export function branchNameFor(ref: TaskRef, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `of/${ref.id.toLowerCase()}${slug ? `-${slug}` : ""}`;
}
