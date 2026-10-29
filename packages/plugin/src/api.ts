/** HTTP client of the server API (spec 8). Transport is injected (Obsidian `requestUrl`). */
import type { RawModels } from "./modelsedit.js";
import type { JournalRow, ModelsState, Project, Task, TaskAssignee, TaskEvent, TaskPermissions, TaskStatus } from "@of/core";

export interface TaskView extends Task {
  archived: boolean;
  permissions: TaskPermissions;
}

export interface ServerStatus {
  version: string;
  projects: number;
  coordinator: {
    running: { project: string; taskId: string; stage: string; model: string }[];
    worker: { configured: boolean; online: boolean; busy: boolean; checkedAt: string | null; detail: string };
    waitingWorker: string[];
    waitingModel: string[];
  } | null;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Requester = (req: HttpRequest) => Promise<{ status: number; json: unknown }>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly request: Requester,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const req: HttpRequest = {
      url: `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
    };
    if (body !== undefined) req.body = JSON.stringify(body);
    let res: { status: number; json: unknown };
    try {
      res = await this.request(req);
    } catch (err) {
      throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
    }
    if (res.status < 200 || res.status >= 300) {
      const j = (res.json ?? {}) as { error?: unknown; message?: unknown };
      throw new ApiError(res.status, typeof j.error === "string" ? j.error : "http_error", typeof j.message === "string" ? j.message : `HTTP ${String(res.status)}`);
    }
    return res.json as T;
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.call("GET", "/health");
  }
  status(): Promise<ServerStatus> {
    return this.call("GET", "/status");
  }
  participants(): Promise<TaskAssignee[]> {
    return this.call("GET", "/participants");
  }
  projects(): Promise<Project[]> {
    return this.call("GET", "/projects");
  }
  tasks(project: string, includeArchived = false): Promise<TaskView[]> {
    return this.call("GET", `/tasks?project=${encodeURIComponent(project)}&full=1${includeArchived ? "&archived=1" : ""}`);
  }
  private static ref(project: string, id: string): string {
    return `/tasks/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  }
  task(project: string, id: string): Promise<TaskView> {
    return this.call("GET", ApiClient.ref(project, id));
  }
  createTask(project: string, input: { title: string; description?: string; plannerMode?: "fast" | "full"; priority?: number }): Promise<TaskView> {
    return this.call("POST", "/tasks", { projectId: project, ...input });
  }
  updateTask(project: string, id: string, patch: Record<string, unknown>): Promise<TaskView> {
    return this.call("PATCH", ApiClient.ref(project, id), patch);
  }
  applyEvent(project: string, id: string, event: TaskEvent, reason: string, expectedStatus: TaskStatus): Promise<TaskView> {
    return this.call("POST", `${ApiClient.ref(project, id)}/events/${event}`, { reason, expectedStatus });
  }
  handoff(
    project: string,
    id: string,
    input: { executionOwner: "ai" | "human"; assigneeIds: string[]; expectedOwnershipRevision: number; reason: string; resumeAction?: TaskEvent },
  ): Promise<TaskView> {
    return this.call("POST", `${ApiClient.ref(project, id)}/handoff`, input);
  }
  archive(project: string, id: string, archived: boolean, reason: string): Promise<TaskView> {
    return this.call("POST", `${ApiClient.ref(project, id)}/${archived ? "archive" : "restore"}`, { reason });
  }
  models(): Promise<ModelsResponse> {
    return this.call("GET", "/models");
  }
  saveModels(raw: unknown): Promise<ModelsResponse> {
    return this.call("PUT", "/models", raw);
  }
  resetModel(model: string): Promise<ModelsResponse> {
    return this.call("POST", "/models/reset", { model });
  }
  history(project: string, id: string): Promise<JournalRow[]> {
    return this.call("GET", `${ApiClient.ref(project, id)}/history`);
  }
}

/** Minimal SSE frame parser (for fetch-stream based `/events`). */
export class SseParser {
  private buf = "";
  constructor(private readonly onEvent: (type: string, data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk.replace(/\r\n/g, "\n");
    let i = this.buf.indexOf("\n\n");
    while (i >= 0) {
      const frame = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) this.onEvent(type, data.join("\n"));
      i = this.buf.indexOf("\n\n");
    }
  }
}

/** GET/PUT /models (Р-035). */
export interface ModelsResponse {
  raw: RawModels | null;
  path: string;
  error: string | null;
  state: ModelsState;
}
