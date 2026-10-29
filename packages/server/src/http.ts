/**
 * HTTP API (spec 8) on node:http: JSON, Bearer tokens, SSE `/api/events`, MCP at `/mcp`.
 * Listens only on the configured host (Tailscale address / 127.0.0.1, Р-003).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { z } from "zod";
import type { ModelsConfig, ModelsState } from "@of/core";
import { ModelsConfigError, PRIORITY_MAX_API, parseModelsConfig, pruneModelsState, resetModel, serializeModelsConfig } from "@of/core";
import type { Authenticator, Principal } from "./auth.js";
import type { BusEvent, EventBus } from "./bus.js";
import type { TokenScope } from "./config.js";
import type { RunInfo } from "./coordinator.js";
import type { ActorContext, TaskService } from "./service.js";
import { ServiceError } from "./service.js";
import type { TaskFilter } from "./queries.js";
import { filterTasks, page, shortTask } from "./queries.js";
import {
  annotateShape,
  commitShape,
  compact,
  createTaskShape,
  eventBodyShape,
  eventSchema,
  handoffShape,
  modelsResetShape,
  planShape,
  projectPatchShape,
  reasonShape,
  statusSchema,
  updateTaskShape,
} from "./schemas.js";
import type { VaultStore } from "./vault/store.js";

export const VERSION = "0.1.0";
const MAX_BODY = 2 * 1024 * 1024;

export interface CoordinatorView {
  status(): unknown;
  runInfo(project: string, id: string): RunInfo | null;
}

export interface HttpDeps {
  service: TaskService;
  store: VaultStore;
  bus: EventBus;
  auth: Authenticator;
  coordinator: CoordinatorView | null;
  lockTtlMs: number;
  corsOrigins: string[];
  mcp: ((req: IncomingMessage, res: ServerResponse, body: unknown, principal: Principal) => Promise<void>) | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  principal: Principal;
  body: unknown;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  scope: TokenScope;
  handler: Handler;
  raw?: boolean;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "payload_too_large", "Body is too large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
}

function parse<S extends z.ZodRawShape>(shape: S, body: unknown): z.infer<z.ZodObject<S>> {
  const r = z.object(shape).strict().safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, "validation", "Invalid request body", r.error.issues);
  return r.data;
}

function ctxOf(p: Principal, source: ActorContext["source"] = "api"): ActorContext {
  return { actor: p.actor, source };
}

const P = "([a-z0-9][a-z0-9._-]{0,63})";
const T = "(TASK-\\d{3,})";

export function createRouter(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { service, store } = deps;
  const taskOut = (s: Awaited<ReturnType<TaskService["getTask"]>>, p: Principal): unknown => service.view(s, ctxOf(p));

  /**
   * `config` — parsed, `raw` — the same in the file format (what PUT /models accepts), `path` — vault-relative
   * location of models.json (shown by the plugin, Р-035).
   */
  const readModels = async (): Promise<{ config: ModelsConfig | null; raw: unknown; path: string; error: string | null; state: ModelsState }> => {
    let config: ModelsConfig | null = null;
    let error: string | null = null;
    try {
      config = await store.readModels();
      if (config === null) error = "models.json not found";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      config,
      raw: config === null ? null : (JSON.parse(serializeModelsConfig(config)) as unknown),
      path: store.modelsRelativePath(),
      error,
      state: pruneModelsState(await store.readModelsState(), service.clock()),
    };
  };

  const human = (p: Principal): void => {
    if (p.kind !== "participant") throw new HttpError(403, "forbidden", "Only a human participant may do this (spec 10)");
  };
  const ownerParam = (url: URL): "ai" | "human" | undefined => {
    const v = url.searchParams.get("owner") ?? url.searchParams.get("executionOwner");
    if (v === null) return undefined;
    if (v !== "ai" && v !== "human") throw new HttpError(400, "validation", "owner must be ai|human");
    return v;
  };
  const num = (url: URL, k: string): number | undefined => {
    const v = url.searchParams.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "validation", `${k} must be a non-negative integer`);
    return n;
  };
  const filters = (url: URL): TaskFilter => {
    const statusRaw = url.searchParams.get("status");
    return {
      status: statusRaw === null ? undefined : statusSchema.parse(statusRaw),
      executionOwner: ownerParam(url),
      assigneeId: url.searchParams.get("assigneeId") ?? undefined,
      unassigned: url.searchParams.get("unassigned") === "true" || url.searchParams.get("unassigned") === "1",
    };
  };
  const projectsFor = async (url: URL): Promise<string[]> => {
    const p = url.searchParams.get("project") ?? url.searchParams.get("projectId");
    return p !== null ? [p] : (await service.listProjects()).map((x) => x.id);
  };
  const tp = (params: string[]): [string, string] => [params[0] ?? "", params[1] ?? ""];

  const routes: Route[] = [
    { method: "GET", pattern: /^\/status$/, scope: "api", handler: async () => ({ version: VERSION, coordinator: deps.coordinator?.status() ?? null, projects: (await service.listProjects()).length }) },
    { method: "GET", pattern: /^\/participants$/, scope: "api", handler: () => Promise.resolve(service.listParticipants()) },
    { method: "GET", pattern: /^\/projects$/, scope: "api", handler: () => service.listProjects() },
    { method: "GET", pattern: new RegExp(`^/projects/${P}$`), scope: "api", handler: ({ params }) => service.getProject(params[0] ?? "") },
    {
      method: "PATCH",
      pattern: new RegExp(`^/projects/${P}$`),
      scope: "api",
      handler: ({ params, body, principal }) => {
        human(principal);
        return service.updateProject(params[0] ?? "", compact(parse(projectPatchShape, body)), ctxOf(principal));
      },
    },
    { method: "GET", pattern: new RegExp(`^/projects/${P}/journal$`), scope: "api", handler: ({ params }) => service.projectJournal(params[0] ?? "") },
    {
      method: "GET",
      pattern: /^\/tasks$/,
      scope: "api",
      handler: async ({ url, principal }) => {
        const all = [];
        const archived = url.searchParams.get("archived") === "1" || url.searchParams.get("archived") === "true";
        for (const p of await projectsFor(url)) all.push(...(await service.listTasks(p, { includeArchived: archived })));
        const list = filterTasks(all, filters(url));
        if (url.searchParams.get("full") === "1") return list.map((s) => taskOut(s, principal));
        return page(list, num(url, "limit"), num(url, "offset"), 100, 1000).map(shortTask);
      },
    },
    {
      method: "GET",
      pattern: /^\/tasks\/search$/,
      scope: "api",
      handler: async ({ url }) => {
        const q = url.searchParams.get("q") ?? "";
        if (q.length > 200) throw new HttpError(400, "validation", "q is limited to 200 chars");
        const project = url.searchParams.get("project") ?? url.searchParams.get("projectId") ?? undefined;
        const hits = filterTasks(await service.searchTasks(q, { project, limit: 10_000 }), filters(url));
        return page(hits, num(url, "limit"), num(url, "offset")).map(shortTask);
      },
    },
    {
      method: "POST",
      pattern: /^\/tasks$/,
      scope: "api",
      handler: async ({ body, principal }) => {
        const { projectId, ...input } = parse({ projectId: z.string(), ...createTaskShape }, body);
        return taskOut(await service.createTask(projectId, compact(input), ctxOf(principal), PRIORITY_MAX_API), principal);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}$`),
      scope: "api",
      handler: async ({ params, principal, url }) => {
        const view = taskOut(await service.getTask(...tp(params)), principal) as Record<string, unknown>;
        const fields = url.searchParams.get("fields");
        if (!fields) return view;
        const out: Record<string, unknown> = { id: view["id"], project: view["project"] };
        for (const f of fields.split(",").map((x) => x.trim())) if (f in view) out[f] = view[f];
        return out;
      },
    },
    {
      method: "PATCH",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}$`),
      scope: "api",
      handler: async ({ params, body, principal }) => taskOut(await service.updateTask(...tp(params), compact(parse(updateTaskShape, body)), ctxOf(principal)), principal),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/events/([a-z_]+)$`),
      scope: "api",
      handler: async ({ params, body, principal }) => {
        human(principal);
        const event = eventSchema.safeParse(params[2]);
        if (!event.success) throw new HttpError(400, "validation", `Unknown event '${params[2] ?? ""}'`);
        const input = parse(eventBodyShape, body);
        const stored = await service.applyEvent(...tp(params), event.data, ctxOf(principal), {
          reason: input.reason,
          expectedStatus: input.expectedStatus,
          requireReason: true,
        });
        return taskOut(stored, principal);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/handoff$`),
      scope: "api",
      handler: async ({ params, body, principal }) => {
        human(principal);
        return taskOut(await service.handoff(...tp(params), compact(parse(handoffShape, body)), ctxOf(principal)), principal);
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/plan$`),
      scope: "api",
      handler: async ({ params, body, principal }) => taskOut(await service.pushPlan(...tp(params), parse(planShape, body).planContent, ctxOf(principal)), principal),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/plan/annotate$`),
      scope: "api",
      handler: async ({ params, body, principal }) => {
        const input = parse(annotateShape, body);
        return taskOut(await service.annotatePlan(...tp(params), input.planContent, input.sectionHeading ?? null, ctxOf(principal)), principal);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/(archive|restore)$`),
      scope: "api",
      handler: async ({ params, body, principal }) => {
        human(principal);
        const input = parse(reasonShape, body);
        return taskOut(await service.setArchived(...tp(params), params[2] === "archive", ctxOf(principal), input.reason ?? null), principal);
      },
    },
    { method: "GET", pattern: new RegExp(`^/tasks/${P}[/:]${T}/history$`), scope: "api", handler: ({ params }) => service.history(...tp(params)) },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/commits$`),
      scope: "worker",
      handler: async ({ params, body, principal }) => {
        const input = parse(commitShape, body);
        return taskOut(await service.addCommit(...tp(params), input.sha, input.branch, ctxOf(principal, "worker")), principal);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/run$`),
      scope: "worker",
      handler: async ({ params }) => {
        const [project, id] = tp(params);
        const run = deps.coordinator?.runInfo(project, id) ?? null;
        if (!run) throw new HttpError(409, "no_active_run", "The coordinator has no active run for this task");
        const stored = await service.getTask(project, id);
        const proj = await service.getProject(project);
        const env: Record<string, string> = { HANDOFF_MODE: "1", HANDOFF_TASK_ID: `${project}/${id}`, HANDOFF_SKIP_REVIEW: stored.task.skipReview ? "1" : "0" };
        if (stored.task.branch) env["HANDOFF_BRANCH_NAME"] = stored.task.branch;
        return {
          project,
          taskId: id,
          title: stored.task.title,
          stage: run.stage,
          agent: run.agent,
          model: run.model,
          prompt: run.prompt,
          plannerMode: stored.task.plannerMode,
          planPath: run.planPath,
          plan: stored.task.plan,
          branch: stored.task.branch,
          defaultBranch: proj.defaultBranch,
          repo: proj.repo,
          env,
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/tasks/${P}[/:]${T}/heartbeat$`),
      scope: "worker",
      handler: async ({ params, principal }) => {
        const r = await service.heartbeat(...tp(params), ctxOf(principal, "worker"), deps.lockTtlMs);
        return { ok: r !== null };
      },
    },
    { method: "GET", pattern: /^\/models$/, scope: "api", handler: readModels },
    { method: "GET", pattern: /^\/models\/state$/, scope: "api", handler: async () => (await readModels()).state },
    {
      method: "PUT",
      pattern: /^\/models$/,
      scope: "api",
      handler: async ({ body, principal }) => {
        let config: ModelsConfig;
        try {
          config = parseModelsConfig(body);
        } catch (err) {
          if (err instanceof ModelsConfigError) throw new HttpError(400, "validation", err.message, err.issues);
          /* v8 ignore next */
          throw err;
        }
        await store.writeModels(config);
        service.emitRaw("models.changed", { by: principal.id });
        return readModels();
      },
    },
    {
      method: "POST",
      pattern: /^\/models\/reset$/,
      scope: "api",
      handler: async ({ body, principal }) => {
        const { model } = parse(modelsResetShape, body);
        await store.writeModelsState(resetModel(await store.readModelsState(), model));
        service.emitRaw("models.changed", { reset: model, by: principal.id });
        return readModels();
      },
    },
  ];

  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && deps.corsOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
      res.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice(4) || "/";
      const method = req.method ?? "GET";
      if (method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === "/health") {
        send(res, 200, { ok: true, version: VERSION });
        return;
      }
      const principal = deps.auth.authenticate(req.headers.authorization ?? (url.pathname === "/events" ? bearerFromQuery(url) : undefined));
      if (!principal) throw new HttpError(401, "unauthorized", "Missing or invalid token");
      if (url.pathname === "/mcp") {
        if (!principal.scopes.includes("mcp")) throw new HttpError(403, "forbidden", "Token has no mcp scope");
        if (!deps.mcp) throw new HttpError(404, "not_found", "MCP is disabled");
        const body = method === "POST" ? await readBody(req) : undefined;
        await deps.mcp(req, res, body, principal);
        return;
      }
      if (url.pathname === "/events" && method === "GET") {
        if (!principal.scopes.includes("api")) throw new HttpError(403, "forbidden", "Token has no api scope");
        sse(req, res, deps.bus, url.searchParams.get("project"));
        return;
      }
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        if (!principal.scopes.includes(route.scope) && !(route.scope === "api" && method === "GET" && principal.scopes.includes("worker"))) {
          throw new HttpError(403, "forbidden", `Token has no ${route.scope} scope`);
        }
        const params = m.slice(1).map((v) => decodeURIComponent(v));
        const body = method === "GET" ? undefined : await readBody(req);
        const result = await route.handler({ req, res, url, params, principal, body });
        send(res, 200, result);
        return;
      }
      throw new HttpError(404, "not_found", "Route not found");
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) send(res, err.status, { error: err.code, message: err.message, details: err.details });
      else if (err instanceof ServiceError) send(res, err.httpStatus, { error: err.code, message: err.message });
      else if (err instanceof z.ZodError) send(res, 400, { error: "validation", message: "Invalid request", details: err.issues });
      else {
        console.error("[http] internal error:", err instanceof Error ? err.message : err);
        send(res, 500, { error: "internal", message: "Internal error" });
      }
    }
  };
}

function bearerFromQuery(url: URL): string | undefined {
  const t = url.searchParams.get("token");
  return t ? `Bearer ${t}` : undefined;
}

function sse(req: IncomingMessage, res: ServerResponse, bus: EventBus, project: string | null): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  const write = (e: BusEvent): void => {
    if (project !== null && e.project !== null && e.project !== project) return;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const unsubscribe = bus.subscribe(write);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

export function startHttpServer(deps: HttpDeps, host: string, port: number): Promise<Server> {
  const handler = createRouter(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
