/**
 * MCP over Streamable HTTP (stateless) at `/mcp`: aif-handoff tool names 1:1
 * (Р-016, spec 9) + `of_add_commit`, `of_models_get`, `of_models_update`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Task } from "@of/core";
import { EXECUTION_OWNERS, PRIORITY_MAX_MCP, parseModelsConfig, parseTaskRef, pruneModelsState, resetModel } from "@of/core";
import type { Principal } from "./auth.js";
import { RateLimiter } from "./auth.js";
import { VERSION } from "./http.js";
import type { ActorContext, TaskService } from "./service.js";
import { ServiceError } from "./service.js";
import type { TaskFilter } from "./queries.js";
import { filterTasks, page, shortTask } from "./queries.js";
import { commitShape, compact, createTaskShape, fromAif, statusSchema, syncShape, updateTaskShape } from "./schemas.js";
import type { VaultStore } from "./vault/store.js";

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true };
}

export function pickFields(task: Task, fields: string[] | undefined): Record<string, unknown> {
  if (!fields || fields.length === 0) return { ...task };
  const out: Record<string, unknown> = { id: task.id, project: task.project };
  for (const f of fields) if (f in task) out[f] = (task as unknown as Record<string, unknown>)[f];
  return out;
}

export interface McpDeps {
  service: TaskService;
  store: VaultStore;
  rateLimitPerMinute: number;
  writeRateLimitPerMinute?: number;
}

const taskIdSchema = z.string().describe("Task reference `<project>/TASK-NNN`, e.g. `of/TASK-012`");

export function buildMcpServer(deps: McpDeps, principal: Principal, limits: { read: RateLimiter; write: RateLimiter }): McpServer {
  const { service, store } = deps;
  const server = new McpServer({ name: "obsidian-framework", version: VERSION });
  const ctx: ActorContext = { actor: principal.actor, source: "mcp" };

  const ref = (taskId: string): { project: string; id: string } => {
    const r = parseTaskRef(taskId);
    if (!r) throw new ServiceError("validation", `Invalid task reference '${taskId}' (expected project/TASK-NNN)`);
    return r;
  };

  const wrap =
    <A>(kind: "read" | "write", fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      if (!limits[kind].allow(principal.name)) return fail("rate_limited", `Too many MCP ${kind} calls, slow down`);
      try {
        const result = await fn(args);
        const taskId = (args as { taskId?: unknown }).taskId;
        if (typeof taskId === "string") {
          const r = parseTaskRef(taskId);
          if (r) await service.touch(r.project, r.id, ctx);
        }
        return ok(result);
      } catch (err) {
        if (err instanceof ServiceError) return fail(err.code, err.message);
        return fail("internal", err instanceof Error ? err.message : String(err));
      }
    };

  const listFilter = {
    executionOwner: z.enum(EXECUTION_OWNERS).optional(),
    assigneeId: z.string().optional(),
    unassigned: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  };

  server.registerTool("handoff_list_projects", { description: "List projects (Проекты/*/Проект.md)." }, wrap("read", async () => service.listProjects()));

  server.registerTool(
    "handoff_list_tasks",
    { description: "List tasks (short form). Filters: projectId, status, executionOwner, assigneeId, unassigned; limit 20 (max 100), offset.", inputSchema: { projectId: z.string().optional(), status: statusSchema.optional(), ...listFilter } },
    wrap("read", async (a: { projectId?: string | undefined; status?: z.infer<typeof statusSchema> | undefined } & TaskFilter & { limit?: number | undefined; offset?: number | undefined }) => {
      const projects = a.projectId !== undefined ? [a.projectId] : (await service.listProjects()).map((p) => p.id);
      const all = [];
      for (const p of projects) all.push(...(await service.listTasks(p)));
      return page(filterTasks(all, a), a.limit, a.offset).map(shortTask);
    }),
  );

  server.registerTool(
    "handoff_get_task",
    { description: "Get one task; `fields` limits the returned properties.", inputSchema: { taskId: taskIdSchema, fields: z.array(z.string()).optional() } },
    wrap("read", async (a: { taskId: string; fields?: string[] | undefined }) => {
      const r = ref(a.taskId);
      const s = await service.getTask(r.project, r.id);
      return { ...pickFields(s.task, a.fields), archived: s.archived };
    }),
  );

  server.registerTool(
    "handoff_search_tasks",
    { description: "Full-text search over id, title, description, tags.", inputSchema: { query: z.string().min(1).max(200), projectId: z.string().optional(), ...listFilter } },
    wrap("read", async (a: { query: string; projectId?: string | undefined } & TaskFilter & { limit?: number | undefined; offset?: number | undefined }) => {
      const hits = await service.searchTasks(a.query, { project: a.projectId, limit: 10_000 });
      return page(filterTasks(hits, a), a.limit, a.offset).map(shortTask);
    }),
  );

  server.registerTool(
    "handoff_create_task",
    { description: "Create a task in backlog (execution_owner ai, priority 0..3 via MCP).", inputSchema: { projectId: z.string(), ...createTaskShape } },
    wrap("write", async (a: z.infer<z.ZodObject<typeof createTaskShape>> & { projectId: string }) => {
      const { projectId, ...input } = a;
      const s = await service.createTask(projectId, compact(fromAif(input)), ctx, PRIORITY_MAX_MCP);
      return { id: s.task.id, ref: `${s.task.project}/${s.task.id}`, project: s.task.project, status: s.task.status, title: s.task.title };
    }),
  );

  server.registerTool(
    "handoff_update_task",
    { description: "Update task fields (status changes go through handoff_sync_status).", inputSchema: { taskId: taskIdSchema, ...updateTaskShape } },
    wrap("write", async (a: z.infer<z.ZodObject<typeof updateTaskShape>> & { taskId: string }) => {
      const { taskId, ...input } = a;
      const r = ref(taskId);
      const s = await service.updateTask(r.project, r.id, compact(fromAif(input)), ctx, PRIORITY_MAX_MCP);
      return { id: s.task.id, status: s.task.status, updated: s.task.updated };
    }),
  );

  server.registerTool(
    "handoff_sync_status",
    { description: "Sync status from ai-factory (last write wins; done/verified refused; agent only on ai-owned tasks).", inputSchema: { taskId: taskIdSchema, ...syncShape } },
    wrap("write", async (a: { taskId: string; newStatus: z.infer<typeof statusSchema>; sourceTimestamp: string; direction: "aif_to_handoff" | "handoff_to_aif"; paused?: boolean | undefined }) => {
      const r = ref(a.taskId);
      const res = await service.syncStatus(r.project, r.id, compact({ newStatus: a.newStatus, sourceTimestamp: a.sourceTimestamp, direction: a.direction, paused: a.paused }), ctx);
      return { applied: res.applied, conflict: res.conflict, reason: res.reason, status: res.task.task.status };
    }),
  );

  server.registerTool(
    "handoff_push_plan",
    { description: "Replace the task plan with the given markdown (max 100 KB).", inputSchema: { taskId: taskIdSchema, planContent: z.string().max(100 * 1024) } },
    wrap("write", async (a: { taskId: string; planContent: string }) => {
      const r = ref(a.taskId);
      const s = await service.pushPlan(r.project, r.id, a.planContent, ctx);
      return { id: s.task.id, planLength: s.task.plan.length };
    }),
  );

  server.registerTool(
    "handoff_annotate_plan",
    { description: "Append content to the plan under a heading (created when missing).", inputSchema: { taskId: taskIdSchema, planContent: z.string().min(1).max(100 * 1024), sectionHeading: z.string().max(200).optional() } },
    wrap("write", async (a: { taskId: string; planContent: string; sectionHeading?: string | undefined }) => {
      const r = ref(a.taskId);
      const s = await service.annotatePlan(r.project, r.id, a.planContent, a.sectionHeading ?? null, ctx);
      return { id: s.task.id, planLength: s.task.plan.length };
    }),
  );

  server.registerTool(
    "of_add_commit",
    { description: "Attach a pushed commit to the task (verified in the remote repo, else commit_not_found).", inputSchema: { taskId: taskIdSchema, ...commitShape } },
    wrap("write", async (a: { taskId: string; sha: string; branch: string }) => {
      const r = ref(a.taskId);
      const s = await service.addCommit(r.project, r.id, a.sha, a.branch, ctx);
      return { id: s.task.id, commitSha: s.task.commitSha, commits: s.task.commits.length };
    }),
  );

  server.registerTool(
    "of_models_get",
    { description: "Read models.json chains and current model availability." },
    wrap("read", async () => ({ config: await store.readModels(), state: pruneModelsState(await store.readModelsState(), service.clock()) })),
  );

  server.registerTool(
    "of_models_update",
    {
      description: "Replace models.json (full JSON per spec 3.8) and/or reset one model's unavailability.",
      inputSchema: { config: z.record(z.unknown()).optional(), resetModel: z.string().optional() },
    },
    wrap("write", async (a: { config?: Record<string, unknown> | undefined; resetModel?: string | undefined }) => {
      if (a.config === undefined && a.resetModel === undefined) throw new ServiceError("validation", "Pass config and/or resetModel");
      if (a.config !== undefined) {
        try {
          await store.writeModels(parseModelsConfig(a.config));
        } catch (err) {
          throw new ServiceError("validation", err instanceof Error ? err.message : String(err));
        }
      }
      if (a.resetModel !== undefined) await store.writeModelsState(resetModel(await store.readModelsState(), a.resetModel));
      service.emitRaw("models.changed", { by: principal.id });
      return { config: await store.readModels(), state: await store.readModelsState() };
    }),
  );

  return server;
}

export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse, body: unknown, principal: Principal) => Promise<void> {
  const limits = { read: new RateLimiter(deps.rateLimitPerMinute), write: new RateLimiter(deps.writeRateLimitPerMinute ?? Math.max(1, Math.floor(deps.rateLimitPerMinute / 2))) };
  return async (req, res, body, principal) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "method_not_allowed", message: "Stateless MCP: use POST" }));
      return;
    }
    const server = buildMcpServer(deps, principal, limits);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
