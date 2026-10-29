import { describe, expect, it } from "vitest";
import type { ModelsState, Task } from "@of/core";
import { createTask, resolveTaskPermissions } from "@of/core";
import type { HttpRequest, TaskView } from "../src/api.js";
import { ApiClient, ApiError, SseParser } from "../src/api.js";
import { COLUMN_TITLES, EVENT_TITLES, buildColumns, cardBadges, indicator, planMove } from "../src/board.js";
import { DEFAULT_SETTINGS, normalizeSettings, serverUrlWarning } from "../src/settings.js";
import { EventStream } from "../src/stream.js";
import type { RawModels } from "../src/modelsedit.js";
import { CHAINS, activeIndex, addModel, getChain, modelStatus, moveModel, parseRawJson, removeModel, sameModels, setCooldown, statusText } from "../src/modelsedit.js";
import { boardFileFor, boardProjectOf, findProjectFolder } from "../src/boardfile.js";

const ADMIN = {
  participantsModeEnabled: true,
  actor: { kind: "participant" as const, id: "owner", displayNameSnapshot: "Owner" },
  participantRole: "admin" as const,
  participantActive: true,
};

function view(patch: Partial<Task> & { archived?: boolean } = {}): TaskView {
  const { archived, ...rest } = patch;
  const t = { ...createTask({ title: "T" }, { project: "of", id: "TASK-001" }, { parallelEnabled: false, useSubagentsDefault: false }, "2026-01-01T00:00:00Z"), ...rest };
  return { ...t, archived: archived ?? false, permissions: resolveTaskPermissions(t, ADMIN) };
}

describe("ApiClient", () => {
  it("sends bearer + JSON and maps errors", async () => {
    const seen: HttpRequest[] = [];
    let reply: { status: number; json: unknown } = { status: 200, json: [{ id: "of" }] };
    const api = new ApiClient("http://100.64.0.1:8787/", "tok", (r) => {
      seen.push(r);
      return Promise.resolve(reply);
    });
    expect(await api.projects()).toEqual([{ id: "of" }]);
    expect(seen[0]).toMatchObject({ url: "http://100.64.0.1:8787/projects", method: "GET", headers: { authorization: "Bearer tok" } });
    expect(seen[0]?.body).toBeUndefined();
    await api.applyEvent("of", "TASK-001", "start_ai", "go", "backlog");
    expect(seen[1]).toMatchObject({ url: "http://100.64.0.1:8787/tasks/of/TASK-001/events/start_ai", method: "POST" });
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ reason: "go", expectedStatus: "backlog" });
    await api.tasks("of", true);
    expect(seen[2]?.url).toBe("http://100.64.0.1:8787/tasks?project=of&full=1&archived=1");
    await api.tasks("of");
    await api.task("of", "TASK-001");
    await api.createTask("of", { title: "x" });
    await api.updateTask("of", "TASK-001", { paused: true });
    await api.handoff("of", "TASK-001", { executionOwner: "human", assigneeIds: ["owner"], expectedOwnershipRevision: 0, reason: "r" });
    await api.archive("of", "TASK-001", true, "r");
    await api.history("of", "TASK-001");
    await api.status();
    await api.health();
    await api.participants();
    await api.models();
    await api.saveModels({ version: 1 });
    await api.resetModel("a/b");
    expect(seen.slice(-3).map((r) => `${r.method} ${r.url.replace("http://100.64.0.1:8787", "")} ${r.body ?? ""}`)).toEqual(["GET /models ", 'PUT /models {"version":1}', 'POST /models/reset {"model":"a/b"}']);
    expect(seen.map((r) => `${r.method} ${r.url.replace("http://100.64.0.1:8787", "")}`)).toEqual(expect.arrayContaining(["POST /tasks/of/TASK-001/archive", "POST /tasks", "GET /tasks/of/TASK-001/history"]));
    await api.archive("of", "TASK-001", false, "r");
    expect(seen.at(-1)?.url).toMatch(/\/restore$/);
    reply = { status: 409, json: { error: "status_conflict", message: "changed" } };
    await expect(api.projects()).rejects.toMatchObject({ status: 409, code: "status_conflict", message: "changed" });
    reply = { status: 500, json: null };
    await expect(api.projects()).rejects.toMatchObject({ code: "http_error", message: "HTTP 500" });
    const down = new ApiClient("http://x", "t", () => Promise.reject(new Error("ECONNREFUSED")));
    await expect(down.projects()).rejects.toBeInstanceOf(ApiError);
    const down2 = new ApiClient("http://x", "t", () => Promise.reject(new Error("x")));
    await expect(down2.projects()).rejects.toMatchObject({ code: "network" });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejection path
    const weird = new ApiClient("http://x", "t", () => Promise.reject("str"));
    await expect(weird.projects()).rejects.toMatchObject({ message: "str" });
  });

  it("SseParser handles frames, comments, CRLF and split chunks", () => {
    const got: [string, string][] = [];
    const p = new SseParser((t, d) => got.push([t, d]));
    p.push(": connected\n\n");
    p.push("event: task.changed\r\ndata: {\"a\"");
    p.push(":1}\r\n\r\ndata: x\ndata: y\n\n");
    expect(got).toEqual([
      ["task.changed", '{"a":1}'],
      ["message", "x\ny"],
    ]);
  });
});

describe("board", () => {
  it("columns ordered by status, cards by priority/position; archived hidden", () => {
    const tasks = [
      view({ id: "TASK-001", status: "backlog", priority: 0, position: 2 }),
      view({ id: "TASK-002", status: "backlog", priority: 3, position: 5 }),
      view({ id: "TASK-003", status: "done" }),
      view({ id: "TASK-004", status: "verified", archived: true }),
    ];
    const cols = buildColumns(tasks, { hideEmpty: ["improve", "verify"] });
    expect(cols.map((c) => c.status)).toEqual(["backlog", "planning", "plan_ready", "implementing", "review", "blocked_external", "done", "verified"]);
    expect(cols[0]?.tasks.map((t) => t.id)).toEqual(["TASK-002", "TASK-001"]);
    expect(cols.find((c) => c.status === "verified")?.tasks).toEqual([]);
    expect(buildColumns(tasks, { showArchived: true }).find((c) => c.status === "verified")?.tasks).toHaveLength(1);
    expect(buildColumns([], {})).toHaveLength(10);
    expect(Object.keys(COLUMN_TITLES)).toHaveLength(10);
    expect(Object.keys(EVENT_TITLES)).toHaveLength(15);
  });

  it("planMove maps drags to human events", () => {
    expect(planMove(view({ status: "backlog" }), "backlog", ADMIN)).toEqual({ kind: "noop" });
    expect(planMove(view({ status: "backlog" }), "planning", ADMIN)).toEqual({ kind: "event", event: "start_ai", requiresReason: true });
    expect(planMove(view({ status: "backlog" }), "plan_ready", ADMIN)).toMatchObject({ event: "accept_existing_plan" });
    expect(planMove(view({ status: "done" }), "verified", ADMIN)).toMatchObject({ event: "approve_done" });
    expect(planMove(view({ status: "done" }), "implementing", ADMIN)).toMatchObject({ event: "request_changes" });
    expect(planMove(view({ status: "backlog" }), "done", ADMIN)).toMatchObject({ kind: "denied" });
    expect(planMove(view({ status: "backlog", archived: true }), "planning", ADMIN)).toMatchObject({ kind: "denied", message: expect.stringContaining("архиве") as unknown });
  });

  it("badges and indicator", () => {
    const t = view({ status: "blocked_external", blockedReason: "limit", paused: true, priority: 2, manualReviewRequired: true });
    const k = "of/TASK-001";
    const b = cardBadges(t, { running: new Set([k]), waitingWorker: new Set([k]), waitingModel: new Set([k]) });
    expect(b.map((x) => x.kind)).toEqual(["owner", "priority", "paused", "running", "waiting", "waiting", "blocked", "review"]);
    const human = view({ executionOwner: "human", assignees: [{ participantId: "owner", displayName: "Owner", role: "admin", active: true }] });
    expect(cardBadges(human, { running: new Set(), waitingWorker: new Set(), waitingModel: new Set() })[0]?.text).toBe("Owner");
    expect(cardBadges(view({ executionOwner: "human" }), { running: new Set(), waitingWorker: new Set(), waitingModel: new Set() })[0]?.text).toBe("человек");
    expect(indicator({ ok: false, workerOnline: null, error: "x" }).cls).toBe("of-ind-bad");
    expect(indicator({ ok: true, workerOnline: false, error: null }).text).toContain("ПК офлайн");
    expect(indicator({ ok: true, workerOnline: true, error: null }).cls).toBe("of-ind-ok");
    expect(indicator({ ok: true, workerOnline: null, error: null }).cls).toBe("of-ind-ok");
    expect(indicator({ ok: true, workerOnline: false, error: null, workerCheckedAt: null })).toMatchObject({ text: "OF: ● сервер · ПК ?", cls: "of-ind-unknown" });
    expect(indicator({ ok: true, workerOnline: false, error: null, workerCheckedAt: "2026-10-29T19:50:00.000Z", workerDetail: "timeout" }).title).toBe("ПК недоступен: timeout (проверено 19:50 UTC)");
    expect(indicator({ ok: true, workerOnline: true, error: null, workerCheckedAt: "2026-10-29T19:50:00.000Z", workerDetail: "0.1.0" }).title).toContain("0.1.0");
  });
});

describe("settings", () => {
  it("normalizes", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ serverUrl: " http://100.70.1.2:8787/ ", token: " t ", project: "", refreshSeconds: 1, showArchived: "yes", hideEmptyColumns: false })).toMatchObject({
      serverUrl: "http://100.70.1.2:8787",
      token: "t",
      project: "of",
      refreshSeconds: 30,
      showArchived: false,
      hideEmptyColumns: false,
    });
    expect(normalizeSettings({ refreshSeconds: 60.4, serverUrl: "", participantId: " " })).toMatchObject({ refreshSeconds: 60, serverUrl: DEFAULT_SETTINGS.serverUrl, participantId: "owner" });
  });

  it("warns on non-Tailscale addresses (Р-003)", () => {
    expect(serverUrlWarning("http://100.101.1.2:8787")).toBeNull();
    expect(serverUrlWarning("https://home.tail1234.ts.net")).toBeNull();
    expect(serverUrlWarning("http://127.0.0.1:8787")).toBeNull();
    expect(serverUrlWarning("http://localhost:8787")).toBeNull();
    expect(serverUrlWarning("http://192.168.1.10:8787")).toMatch(/Tailscale/);
    expect(serverUrlWarning("http://100.200.1.1")).toMatch(/Tailscale/);
    expect(serverUrlWarning("ftp://100.64.0.1")).toMatch(/http/);
    expect(serverUrlWarning("::")).toMatch(/Неверный/);
  });
});

describe("EventStream", () => {
  function body(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
  }

  it("parses events, reconnects with backoff, stops", async () => {
    const events: [string, unknown][] = [];
    const states: boolean[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const s = new EventStream(
      "http://x/events",
      "tok",
      (_url, init) => {
        n++;
        expect(init.headers["authorization"]).toBe("Bearer tok");
        if (n === 1) return Promise.resolve({ ok: true, status: 200, body: body(['event: task.changed\ndata: {"taskId":"TASK-001"}\n\n', "data: raw\n\n"]) });
        if (n === 2) return Promise.resolve({ ok: false, status: 401, body: null });
        return Promise.reject(new Error("down"));
      },
      (t, d) => events.push([t, d]),
      (c) => states.push(c),
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );
    await s.loop(3);
    expect(events).toEqual([
      ["task.changed", { taskId: "TASK-001" }],
      ["message", "raw"],
    ]);
    expect(states).toEqual([true, false, false, false]);
    expect(sleeps).toEqual([2000, 4000, 8000]);
    s.start();
    s.start();
    s.stop();
    expect(s.isStopped()).toBe(true);
  });
});

describe("board file (Р-034)", () => {
  const proj = { path: "Проекты/OF/Проект.md", name: "Проект.md", folder: "Проекты/OF", frontmatter: { type: "project", id: "of", title: "Obsidian Framework" } };
  it("finds the project folder by Проект.md id", () => {
    const other = { path: "Проекты/X/Проект.md", name: "Проект.md", folder: "Проекты/X", frontmatter: { type: "project", id: "x" } };
    const note = { path: "a.md", name: "a.md", folder: "", frontmatter: { type: "project", id: "of" } };
    expect(findProjectFolder([note, other, proj], "of")).toEqual({ folder: "Проекты/OF", title: "Obsidian Framework" });
    expect(findProjectFolder([other], "x")).toEqual({ folder: "Проекты/X", title: "x" });
    expect(findProjectFolder([{ ...other, frontmatter: null }], "x")).toBeNull();
    expect(findProjectFolder([], "of")).toBeNull();
  });
  it("recognises a board by frontmatter or by name next to Проект.md", () => {
    const board = { path: "Проекты/OF/Доска.md", name: "Доска.md", folder: "Проекты/OF", frontmatter: { type: "board", project: "of" } };
    expect(boardProjectOf(board, null)).toBe("of");
    expect(boardProjectOf({ ...board, frontmatter: undefined }, proj.frontmatter)).toBe("of");
    expect(boardProjectOf({ ...board, frontmatter: undefined }, null)).toBeNull();
    expect(boardProjectOf({ ...board, name: "Другое.md", frontmatter: {} }, proj.frontmatter)).toBeNull();
  });
  it("builds path and content in the project root", () => {
    const f = boardFileFor("Проекты/OF", { id: "of", title: "Obsidian Framework" });
    expect(f.path).toBe("Проекты/OF/Доска.md");
    expect(f.content).toContain("type: board\nproject: of");
  });
});

describe("models editor (Р-035)", () => {
  const RAW: RawModels = {
    version: 1,
    default_cooldown_minutes: 60,
    roles: { worker: { opencode: ["o/a", "o/b"], pi: ["p/a"] }, planning: ["x/1", "x/2", "x/3"], improve: [], review: ["r/1"], verify: ["v/1"] },
  };
  const NOW = new Date("2026-10-29T12:00:00Z");

  it("reads and edits every chain immutably", () => {
    expect(CHAINS.map((c) => c.key)).toEqual(["worker.opencode", "worker.pi", "planning", "improve", "review", "verify"]);
    for (const { key } of CHAINS) {
      const r = addModel(RAW, key, "  new/m ");
      expect(r.error).toBeNull();
      expect(getChain(r.raw, key).at(-1)).toBe("new/m");
      expect(getChain(removeModel(r.raw, key, getChain(r.raw, key).length - 1), key)).toEqual(getChain(RAW, key));
    }
    expect(RAW.roles.worker.opencode).toEqual(["o/a", "o/b"]);
    expect(addModel(RAW, "planning", " ").error).toMatch(/Пустое/);
    expect(addModel(RAW, "planning", "noslash").error).toMatch(/Формат/);
    expect(addModel(RAW, "planning", "x/1").error).toMatch(/уже/);
    expect(getChain(moveModel(RAW, "planning", 2, -1), "planning")).toEqual(["x/1", "x/3", "x/2"]);
    expect(getChain(moveModel(RAW, "planning", 0, 1), "planning")).toEqual(["x/2", "x/1", "x/3"]);
    expect(moveModel(RAW, "planning", 0, -1)).toBe(RAW);
    expect(moveModel(RAW, "planning", 2, 1)).toBe(RAW);
    expect(moveModel(RAW, "planning", 9, -1)).toBe(RAW);
    expect(setCooldown(RAW, 30).default_cooldown_minutes).toBe(30);
    expect(sameModels(RAW, setCooldown(RAW, 60))).toBe(true);
    expect(sameModels(RAW, setCooldown(RAW, 61))).toBe(false);
  });

  it("status and active model", () => {
    const state: ModelsState = {
      version: 1,
      models: {
        "x/1": { unavailableUntil: "2026-10-29T13:00:00Z", manual: false, category: "rate_limit", since: "2026-10-29T11:00:00Z" },
        "x/2": { unavailableUntil: null, manual: true, category: "auth", since: "2026-10-29T11:00:00Z" },
        "r/1": { unavailableUntil: "2026-10-29T11:00:00Z", manual: false, category: "rate_limit", since: "2026-10-29T10:00:00Z" },
      },
    };
    const f = (iso: string): string => iso.slice(11, 16);
    expect(statusText(modelStatus(state, "x/1", NOW), f)).toBe("лимит до 13:00 (rate_limit)");
    expect(statusText(modelStatus(state, "x/2", NOW), f)).toBe("выключена до сброса (auth)");
    expect(statusText(modelStatus(state, "r/1", NOW), f)).toBe("доступна");
    expect(modelStatus(state, "none/x", NOW).kind).toBe("ok");
    expect(activeIndex(RAW.roles.planning, state, NOW)).toBe(2);
    expect(activeIndex(["x/1"], state, NOW)).toBe(-1);
  });

  it("parses JSON text", () => {
    expect(parseRawJson('{"a":1}')).toEqual({ raw: { a: 1 }, error: null });
    expect(parseRawJson("{").error).toMatch(/Не JSON/);
  });
});
