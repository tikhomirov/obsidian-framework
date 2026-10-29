import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Authenticator, RateLimiter } from "../src/auth.js";
import type { CoordinatorView } from "../src/http.js";
import { readBody, startHttpServer } from "../src/http.js";
import { createMcpHandler, pickFields } from "../src/mcp.js";
import { COORDINATOR_ACTOR } from "../src/service.js";
import type { Fixture } from "./helpers.js";
import { MODELS_RAW, PARTICIPANTS, makeFixture } from "./helpers.js";

const T = {
  owner: "owner-token-000000000000000000000001",
  bob: "bob-token-0000000000000000000000002",
  worker: "worker-token-00000000000000000000003",
  mcp: "mcp-token-0000000000000000000000004",
};

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  servers = [];
});

async function boot(opts: { coordinator?: CoordinatorView | null; mcp?: boolean; rate?: number } = {}): Promise<{ f: Fixture; base: string; call: (method: string, path: string, token: string | null, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> & unknown[] }> }> {
  const f = await makeFixture();
  const auth = new Authenticator(
    [
      { name: "plugin", token: T.owner, kind: "participant", id: "owner", scopes: ["api"] },
      { name: "bob", token: T.bob, kind: "participant", id: "bob", scopes: ["api"] },
      { name: "worker", token: T.worker, kind: "agent", id: "pc", scopes: ["worker"] },
      { name: "mcp", token: T.mcp, kind: "agent", id: "pc-mcp", scopes: ["mcp"] },
    ],
    PARTICIPANTS,
  );
  const server = await startHttpServer(
    {
      service: f.service,
      store: f.store,
      bus: f.bus,
      auth,
      coordinator: opts.coordinator ?? null,
      lockTtlMs: 60_000,
      corsOrigins: ["app://obsidian.md"],
      mcp: opts.mcp === false ? null : createMcpHandler({ service: f.service, store: f.store, rateLimitPerMinute: opts.rate ?? 1000 }),
    },
    "127.0.0.1",
    0,
  );
  servers.push(server);
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> & unknown[] };
  };
  return { f, base, call };
}

describe("HTTP API", () => {
  it("health, auth, scopes, CORS, /api alias", async () => {
    const { call, base } = await boot();
    expect((await call("GET", "/health", null)).json).toMatchObject({ ok: true });
    expect((await call("GET", "/api/health", null)).json).toMatchObject({ ok: true });
    expect((await call("GET", "/projects", null)).status).toBe(401);
    expect((await call("GET", "/projects", "wrong-token-xxxxxxxxxxxxxxxxxxxxxx")).status).toBe(401);
    expect((await call("GET", "/projects", T.owner)).json).toHaveLength(1);
    expect((await call("GET", "/api/projects", T.owner)).json).toHaveLength(1);
    expect((await call("GET", "/projects", T.worker)).status).toBe(200); // worker may read
    expect((await call("POST", "/tasks", T.worker, { projectId: "of", title: "x" })).status).toBe(403);
    expect((await call("GET", "/nope", T.owner)).status).toBe(404);
    const pre = await fetch(`${base}/projects`, { method: "OPTIONS", headers: { origin: "app://obsidian.md" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("app://obsidian.md");
    expect((await call("GET", "/status", T.owner)).json).toMatchObject({ version: "0.1.0", coordinator: null, projects: 1 });
    expect((await call("GET", "/participants", T.owner)).json).toHaveLength(3);
    expect((await call("GET", "/mcp", T.owner)).status).toBe(403);
  });

  it("task lifecycle over REST (spec 8)", async () => {
    const { call } = await boot();
    const created = await call("POST", "/tasks", T.owner, { projectId: "of", title: "Board", description: "drag & drop" });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ id: "TASK-001", status: "backlog", archived: false });
    expect((await call("POST", "/tasks", T.owner, { projectId: "of", title: "x", bogus: 1 })).status).toBe(400);
    expect((await call("POST", "/tasks", T.owner, "{bad")).status).toBe(400);
    expect((await call("GET", "/tasks?project=of", T.owner)).json[0]).toMatchObject({ ref: "of/TASK-001", status: "backlog" });
    expect((await call("GET", "/tasks", T.owner)).json).toHaveLength(1);
    expect((await call("GET", "/tasks?project=of&full=1", T.owner)).json[0]).toHaveProperty("permissions");
    expect((await call("GET", "/tasks?status=planning", T.owner)).json).toHaveLength(0);
    expect((await call("GET", "/tasks?owner=human", T.owner)).json).toHaveLength(0);
    expect((await call("GET", "/tasks?owner=robot", T.owner)).status).toBe(400);
    expect((await call("GET", "/tasks?limit=-1", T.owner)).status).toBe(400);
    expect((await call("GET", "/tasks?status=nope", T.owner)).status).toBe(400);
    expect((await call("GET", "/tasks?project=zz", T.owner)).status).toBe(404);
    expect((await call("GET", "/tasks/of/TASK-001", T.owner)).json).toMatchObject({ title: "Board" });
    expect((await call("GET", "/tasks/of:TASK-001?fields=title,nope", T.owner)).json).toEqual({ id: "TASK-001", project: "of", title: "Board" });
    expect((await call("GET", "/tasks/of/TASK-404", T.owner)).status).toBe(404);
    expect((await call("PATCH", "/tasks/of/TASK-001", T.owner, { priority: 4 })).json).toMatchObject({ priority: 4 });
    // human move needs a reason; agents may not use human events
    expect((await call("POST", "/tasks/of/TASK-001/events/start_ai", T.owner, {})).json).toMatchObject({ error: "reason_required" });
    expect((await call("POST", "/tasks/of/TASK-001/events/fly", T.owner, { reason: "x" })).status).toBe(400);
    expect((await call("POST", "/tasks/of/TASK-001/events/start_ai", T.owner, { reason: "go", expectedStatus: "backlog" })).json).toMatchObject({ status: "planning" });
    expect((await call("POST", "/tasks/of/TASK-001/events/start_ai", T.owner, { reason: "again" })).status).toBe(409);
    expect((await call("GET", "/tasks/of/TASK-001/history", T.owner)).json.length).toBeGreaterThanOrEqual(3);
    expect((await call("GET", "/projects/of/journal", T.owner)).json.length).toBeGreaterThanOrEqual(3);
    expect((await call("GET", "/tasks/search?q=drag", T.owner)).json).toHaveLength(1);
    expect((await call("GET", "/tasks/search?q=drag&owner=human", T.owner)).json).toHaveLength(0);
    expect((await call("GET", "/tasks/search?q=", T.owner)).status).toBe(400);
    expect((await call("GET", `/tasks/search?q=${"x".repeat(201)}`, T.owner)).status).toBe(400);
    expect((await call("PUT", "/tasks/of/TASK-001/plan", T.owner, { planContent: "# P\n\n## Steps\n- a" })).json).toMatchObject({ plan: "# P\n\n## Steps\n- a" });
    expect(((await call("POST", "/tasks/of/TASK-001/plan/annotate", T.owner, { planContent: "- b", sectionHeading: "Steps" })).json as unknown as { plan: string }).plan).toContain("- a\n\n- b");
    const h = await call("POST", "/tasks/of/TASK-001/handoff", T.owner, { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0, reason: "mine" });
    expect(h.json).toMatchObject({ executionOwner: "human", ownershipRevision: 1 });
    expect((await call("GET", "/tasks?assigneeId=owner", T.owner)).json).toHaveLength(1);
    expect((await call("GET", "/tasks?unassigned=true", T.owner)).json).toHaveLength(0);
    expect((await call("POST", "/tasks/of/TASK-001/archive", T.owner, {})).status).toBe(409);
    expect((await call("PATCH", "/projects/of", T.owner, { autoQueueMode: true })).json).toMatchObject({ autoQueueMode: true });
    expect((await call("PATCH", "/projects/of", T.bob, { autoQueueMode: true })).status).toBe(403);
    expect((await call("GET", "/projects/of", T.owner)).json).toMatchObject({ id: "of" });
  });

  it("archive/restore, commits, worker endpoints", async () => {
    const run = { project: "of", taskId: "TASK-001", stage: "implementer" as const, agent: "opencode" as const, model: "a/b", prompt: "/aif-implement", planPath: ".ai-factory/PLAN.md", startedAt: "x" };
    const { call, f } = await boot({ coordinator: { status: () => ({ ok: 1 }), runInfo: (p, id) => (p === "of" && id === "TASK-001" ? run : null) } });
    await call("POST", "/tasks", T.owner, { projectId: "of", title: "W" });
    await call("POST", "/tasks", T.owner, { projectId: "of", title: "W2" });
    await f.service.mutate("of", "TASK-001", COORDINATOR_ACTOR, () => ({ patch: { branch: "of/task-001-w", lockedBy: "worker:pc" }, action: "t" }));
    const info = await call("GET", "/tasks/of/TASK-001/run", T.worker);
    expect(info.json).toMatchObject({ agent: "opencode", model: "a/b", branch: "of/task-001-w", defaultBranch: "main", env: { HANDOFF_MODE: "1", HANDOFF_SKIP_REVIEW: "1", HANDOFF_BRANCH_NAME: "of/task-001-w" } });
    expect((await call("GET", "/tasks/of/TASK-002/run", T.worker)).json).toMatchObject({ error: "no_active_run" });
    expect((await call("GET", "/tasks/of/TASK-001/run", T.owner)).status).toBe(403);
    expect((await call("POST", "/tasks/of/TASK-001/heartbeat", T.worker, {})).json).toEqual({ ok: true });
    expect((await call("POST", "/tasks/of/TASK-002/heartbeat", T.worker)).json).toEqual({ ok: false });
    expect((await call("POST", "/tasks/of/TASK-001/commits", T.worker, { sha: "abcdef1", branch: "of/task-001-w" })).json).toMatchObject({ commitSha: "abcdef1" });
    expect((await call("POST", "/tasks/of/TASK-001/commits", T.worker, { sha: "nothex", branch: "x" })).status).toBe(400);
    expect((await call("POST", "/tasks/of/TASK-002/archive", T.owner, { reason: "dup" })).json).toMatchObject({ archived: true });
    expect((await call("GET", "/tasks?project=of&archived=1", T.owner)).json).toHaveLength(2);
    expect((await call("POST", "/tasks/of/TASK-002/restore", T.owner, {})).json).toMatchObject({ archived: false });
    expect((await call("GET", "/status", T.owner)).json).toMatchObject({ coordinator: { ok: 1 } });
    expect((await call("GET", "/tasks/of/TASK-1", T.owner)).status).toBe(404);
  });

  it("models endpoints", async () => {
    const { call } = await boot();
    const m = await call("GET", "/models", T.owner);
    expect(m.json).toMatchObject({ error: null, config: { planning: ["omniroute/plan-a", "omniroute/plan-b"] }, raw: MODELS_RAW, path: "Проекты/Obsidian Framework/models.json" });
    // raw round-trips through PUT unchanged (plugin editor, Р-035)
    const same = await call("PUT", "/models", T.owner, (m.json as unknown as { raw: unknown }).raw);
    expect((same.json as unknown as { raw: unknown }).raw).toEqual(MODELS_RAW);
    const bad = await call("PUT", "/models", T.owner, { version: 1 });
    expect(bad.status).toBe(400);
    expect((await call("PUT", "/models", T.worker, MODELS_RAW)).status).toBe(403);
    const put = await call("PUT", "/models", T.owner, { ...MODELS_RAW, roles: { ...MODELS_RAW.roles, review: ["x/y"] } });
    expect(put.json).toMatchObject({ config: { review: ["x/y"] } });
    const reset = await call("POST", "/models/reset", T.owner, { model: "x/y" });
    expect(reset.json).toMatchObject({ state: { models: {} } });
    expect((await call("GET", "/models/state", T.owner)).json).toEqual({ version: 1, models: {} });
  });

  it("models endpoint reports a broken models.json", async () => {
    const { call, f } = await boot();
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(f.store.modelsPath(), "{");
    expect(((await call("GET", "/api/models", T.owner)).json as unknown as { error: string }).error).toMatch(/JSON/);
    await rm(f.store.modelsPath());
    const missing = (await call("GET", "/api/models", T.owner)).json as unknown as { error: string; raw: unknown };
    expect(missing.error).toBe("models.json not found");
    expect(missing.raw).toBeNull();
  });

  it("SSE streams bus events", async () => {
    const { base, call } = await boot();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events?project=of&token=${T.owner}`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value as Uint8Array);
    expect(first).toContain(": connected");
    await call("POST", "/tasks", T.owner, { projectId: "of", title: "E" });
    let text = "";
    while (!text.includes("task.created")) text += new TextDecoder().decode((await reader.read()).value as Uint8Array);
    expect(text).toContain('"taskId":"TASK-001"');
    ctrl.abort();
    expect((await fetch(`${base}/events`)).status).toBe(401);
    expect((await call("GET", "/events", T.worker)).status).toBe(403);
  });

  it("MCP disabled → 404; rate limiter", async () => {
    const { call } = await boot({ mcp: false });
    expect((await call("POST", "/mcp", T.mcp, {})).status).toBe(404);
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    expect([rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, false]);
    t = 60_000;
    expect(rl.allow("a")).toBe(true);
  });

  it("readBody rejects huge bodies", async () => {
    function* gen(): Generator<Buffer> {
      yield Buffer.alloc(3 * 1024 * 1024);
    }
    await expect(readBody(gen() as never)).rejects.toThrow(/too large/);
  });
});

describe("MCP tools", () => {
  async function client(base: string, token: string): Promise<Client> {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  }
  const parse = (r: unknown): Record<string, unknown> & unknown[] => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown> & unknown[];

  it("lists tools (AIF names 1:1 + of_*) and runs them", async () => {
    const { base, f } = await boot();
    const c = await client(base, T.mcp);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "handoff_annotate_plan", "handoff_create_task", "handoff_get_task", "handoff_list_projects", "handoff_list_tasks",
      "handoff_push_plan", "handoff_search_tasks", "handoff_sync_status", "handoff_update_task", "of_add_commit", "of_models_get", "of_models_update",
    ]);
    expect(parse(await c.callTool({ name: "handoff_list_projects", arguments: {} }))).toHaveLength(1);
    const created = parse(await c.callTool({ name: "handoff_create_task", arguments: { projectId: "of", title: "From MCP", priority: 3, runtimeProfileId: "opencode" } }));
    expect(created).toMatchObject({ id: "TASK-001", status: "backlog" });
    const tooHigh = await c.callTool({ name: "handoff_create_task", arguments: { projectId: "of", title: "x", priority: 5 } });
    expect(tooHigh.isError).toBe(true);
    expect(parse(await c.callTool({ name: "handoff_list_tasks", arguments: { projectId: "of" } }))[0]).toMatchObject({ id: "TASK-001", executionOwner: "ai" });
    expect(parse(await c.callTool({ name: "handoff_list_tasks", arguments: {} }))).toHaveLength(1);
    expect(parse(await c.callTool({ name: "handoff_get_task", arguments: { taskId: "of/TASK-001", fields: ["title"] } }))).toEqual({ id: "TASK-001", project: "of", title: "From MCP", archived: false });
    const badRef = await c.callTool({ name: "handoff_get_task", arguments: { taskId: "TASK-001" } });
    expect(parse(badRef)).toMatchObject({ error: "validation" });
    expect(parse(await c.callTool({ name: "handoff_search_tasks", arguments: { query: "mcp" } }))).toHaveLength(1);
    expect(parse(await c.callTool({ name: "handoff_update_task", arguments: { taskId: "of/TASK-001", description: "d" } }))).toMatchObject({ id: "TASK-001" });
    const synced = parse(await c.callTool({ name: "handoff_sync_status", arguments: { taskId: "of/TASK-001", newStatus: "planning", sourceTimestamp: new Date(f.clock.ms + 1000).toISOString() } }));
    expect(synced).toMatchObject({ applied: true, status: "planning" });
    expect(parse(await c.callTool({ name: "handoff_push_plan", arguments: { taskId: "of/TASK-001", planContent: "# P" } }))).toMatchObject({ planLength: 3 });
    expect(parse(await c.callTool({ name: "handoff_annotate_plan", arguments: { taskId: "of/TASK-001", planContent: "n", sectionHeading: "Notes" } }))).toMatchObject({ id: "TASK-001" });
    expect(parse(await c.callTool({ name: "handoff_list_tasks", arguments: { executionOwner: "human" } }))).toHaveLength(0);
    expect(parse(await c.callTool({ name: "handoff_list_tasks", arguments: { projectId: "of", limit: 1, offset: 0 } }))).toHaveLength(1);
    expect(parse(await c.callTool({ name: "handoff_update_task", arguments: { taskId: "of/TASK-001", runtimeProfileId: "pi", roadmapAlias: "M1", runtimeOptions: { a: 1 } } }))).toMatchObject({ id: "TASK-001" });
    expect((await f.service.getTask("of", "TASK-001")).task).toMatchObject({ runtimeProfile: "pi", roadmap: "M1" });
    expect((await f.service.getTask("of", "TASK-001")).task.lastHeartbeatAt).not.toBeNull();
    expect(parse(await c.callTool({ name: "of_add_commit", arguments: { taskId: "of/TASK-001", sha: "abcdef1", branch: "of/x" } }))).toMatchObject({ commitSha: "abcdef1", commits: 1 });
    expect(parse(await c.callTool({ name: "of_models_get", arguments: {} }))).toMatchObject({ config: { review: ["omniroute/review-a"] } });
    expect(parse(await c.callTool({ name: "of_models_update", arguments: {} }))).toMatchObject({ error: "validation" });
    expect(parse(await c.callTool({ name: "of_models_update", arguments: { config: { version: 9 } } }))).toMatchObject({ error: "validation" });
    expect(parse(await c.callTool({ name: "of_models_update", arguments: { config: MODELS_RAW, resetModel: "omniroute/plan-a" } }))).toMatchObject({ state: { models: {} } });
    expect(parse(await c.callTool({ name: "handoff_get_task", arguments: { taskId: "of/TASK-404" } }))).toMatchObject({ error: "not_found" });
    const journal = await f.service.history("of", "TASK-001");
    expect(journal.some((r) => r.actor === "agent:pc-mcp")).toBe(true);
    await c.close();
  });

  it("rate limit and GET", async () => {
    const { base, call } = await boot({ rate: 1 });
    const c = await client(base, T.mcp);
    await c.callTool({ name: "handoff_list_projects", arguments: {} });
    expect(parse(await c.callTool({ name: "handoff_list_projects", arguments: {} }))).toMatchObject({ error: "rate_limited" });
    await c.close();
    expect((await call("GET", "/mcp", T.mcp)).status).toBe(405);
  });

  it("pickFields", () => {
    const t = { id: "TASK-001", project: "of", title: "x" } as never;
    expect(pickFields(t, undefined)).toEqual({ id: "TASK-001", project: "of", title: "x" });
    expect(pickFields(t, ["nope"])).toEqual({ id: "TASK-001", project: "of" });
  });
});
