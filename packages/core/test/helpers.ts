import { createTask } from "../src/factory.js";
import type { Task, TaskStatus } from "../src/types.js";

export const NOW = new Date("2026-10-29T10:00:00.000Z");
export const NOW_ISO = NOW.toISOString();

export function makeTask(status: TaskStatus = "backlog", patch: Partial<Task> = {}): Task {
  const base = createTask({ title: "Task" }, { project: "of", id: "TASK-001" }, { parallelEnabled: false, useSubagentsDefault: false }, "2026-01-01T00:00:00.000Z");
  return { ...base, status, ...patch };
}

export const ADMIN = {
  participantsModeEnabled: true,
  actor: { kind: "participant" as const, id: "owner", displayNameSnapshot: "Owner" },
  participantRole: "admin" as const,
  participantActive: true,
};

export const LEGACY = {
  participantsModeEnabled: false,
  actor: { kind: "anonymous" as const, id: null, displayNameSnapshot: null },
};
