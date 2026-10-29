import type { Project, RuntimeProfile, StageDefinition, StageError, Task } from "@of/core";

export interface StageRunRequest {
  project: Project;
  task: Task;
  stage: StageDefinition;
  agent: RuntimeProfile;
  model: string;
  prompt: string;
  /** Server stages: the clone dir. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onHeartbeat: () => void;
}

export type StageRunResult =
  | { kind: "ok"; text: string; sha: string | null; branch: string | null; model: string }
  | { kind: "error"; error: StageError; model: string }
  /** The PC/worker is not reachable: wait, not an error (Р-019). */
  | { kind: "unavailable"; reason: string };

export interface StageRunner {
  run(request: StageRunRequest): Promise<StageRunResult>;
}

export interface WorkerProbe {
  probe(): Promise<{ online: boolean; busy: boolean; detail: string }>;
}
