import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "@of/core";
import { OWNER, makeFixture } from "./helpers.js";

describe("VaultStore", () => {
  it("lists projects, skips junk and duplicates", async () => {
    const f = await makeFixture();
    await mkdir(join(f.dir, "Проекты", "Пусто"), { recursive: true });
    await mkdir(join(f.dir, "Проекты", ".hidden"), { recursive: true });
    await mkdir(join(f.dir, "Проекты", "Заметка"), { recursive: true });
    await writeFile(join(f.dir, "Проекты", "Заметка", "Проект.md"), "---\ntype: note\n---\n");
    await mkdir(join(f.dir, "Проекты", "Копия"), { recursive: true });
    await writeFile(join(f.dir, "Проекты", "Копия", "Проект.md"), "---\ntype: project\nid: of\n---\n");
    await mkdir(join(f.dir, "Проекты", "Второй"), { recursive: true });
    await writeFile(join(f.dir, "Проекты", "Второй", "Проект.md"), "---\ntype: project\nid: ab\n---\n");
    const { projects, bad } = await f.store.listProjects();
    expect(projects.map((p) => p.id)).toEqual(["ab", "of"]);
    expect(bad).toHaveLength(1);
    expect(await f.store.projectFolder("zz")).toBeNull();
    expect(await f.store.readProject("zz")).toBeNull();
    expect(await f.store.listTasks("zz")).toEqual({ tasks: [], bad: [] });
    expect(await f.store.readTask("zz", "TASK-001")).toBeNull();
    expect(await f.store.readTask("of", "bad")).toBeNull();
    expect(await f.store.taskFileExists("zz", "TASK-001")).toBe(false);
    expect(await f.store.readJournal("zz")).toEqual([]);
    await expect(f.store.appendJournal("zz", { at: "x", actor: OWNER.actor, action: "a", taskId: null, from: null, to: null, reason: null, ownershipRevision: null, executionOwner: null, metadata: null }, new Date())).rejects.toThrow(/Unknown project/);
  });

  it("ensureBoards: creates Доска.md in the project root once, never overwrites, not a task (Р-034)", async () => {
    const f = await makeFixture();
    const board = join(f.dir, "Проекты", "Obsidian Framework", "Доска.md");
    expect(await f.store.ensureBoards()).toEqual(["Проекты/Obsidian Framework/Доска.md"]);
    const text = await readFile(board, "utf8");
    expect(text).toContain("type: board\nproject: of\n");
    await writeFile(board, "---\ntype: board\nproject: of\n---\nмоя доска\n");
    expect(await f.store.ensureBoards()).toEqual([]);
    expect(await readFile(board, "utf8")).toContain("моя доска");
    expect((await f.store.listTasks("of")).tasks).toHaveLength(0);
    const g = await makeFixture();
    await writeFile(join(g.dir, "Проекты", "Obsidian Framework", "Доска.md"), "своя\n");
    expect(await g.store.ensureBoards()).toEqual([]);
  });

  it("returns no projects when the projects dir is missing", async () => {
    const f = await makeFixture();
    const { VaultStore } = await import("../src/vault/store.js");
    const s = new VaultStore({ vaultDir: join(f.dir, "nope"), projectsDir: "Проекты", frameworkDir: "x", tzOffsetMinutes: 0 });
    expect((await s.listProjects()).projects).toEqual([]);
  });

  it("reads, writes, archives tasks and reports bad files", async () => {
    const f = await makeFixture();
    const task = createTask({ title: "Hello" }, { project: "of", id: "TASK-001" }, { parallelEnabled: false, useSubagentsDefault: false }, "2026-10-29T10:00:00.000Z");
    const stored = await f.store.writeTask(task, null);
    const folder = join(f.dir, "Проекты", "Obsidian Framework");
    await writeFile(join(folder, "Задачи", "TASK-002.md"), "no frontmatter");
    await writeFile(join(folder, "Задачи", "TASK-003.md"), (await readFile(stored.path, "utf8")).replace("id: TASK-001", "id: TASK-009"));
    await writeFile(join(folder, "Задачи", "README.md"), "x");
    await writeFile(join(folder, "Задачи", "note.txt"), "x");
    const { tasks, bad } = await f.store.listTasks("of");
    expect(tasks.map((t) => t.task.id)).toEqual(["TASK-001"]);
    expect(bad.map((b) => b.path.split("/").pop())).toEqual(expect.arrayContaining(["TASK-002.md", "TASK-003.md"]));
    expect(await f.store.taskFileExists("of", "TASK-001")).toBe(true);
    const archived = await f.store.setArchived(stored, true);
    expect(archived.archived).toBe(true);
    expect(await f.store.setArchived(archived, true)).toBe(archived);
    expect((await f.store.readTask("of", "TASK-001"))?.archived).toBe(true);
    expect((await f.store.listTasks("of", true)).tasks).toHaveLength(1);
    expect(await f.store.taskFileExists("of", "TASK-001")).toBe(true);
    const back = await f.store.setArchived(archived, false);
    expect(back.path).toContain("Задачи");
    await expect(f.store.writeTask({ ...task, project: "zz" }, null)).rejects.toThrow(/Unknown project/);
    await expect(f.store.setArchived({ ...back, task: { ...back.task, project: "zz" } }, true)).rejects.toThrow(/Unknown project/);
  });

  it("journal: monthly file with header, rows readable back", async () => {
    const f = await makeFixture();
    const e = { at: "2026-10-29T13:00:00+03:00", actor: OWNER.actor, action: "x", taskId: "TASK-001", from: null, to: null, reason: "a|b", ownershipRevision: null, executionOwner: null, metadata: null };
    await f.store.appendJournal("of", e, new Date("2026-10-29T10:00:00Z"));
    await f.store.appendJournal("of", e, new Date("2026-10-29T10:00:00Z"));
    const rows = await f.store.readJournal("of");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reason).toBe("a|b");
    const text = await readFile(join(f.dir, "Проекты", "Obsidian Framework", "_журнал", "2026-10.md"), "utf8");
    expect(text).toContain("| время |");
  });

  it("models.json + state", async () => {
    const f = await makeFixture();
    const cfg = await f.store.readModels();
    expect(cfg?.planning).toEqual(["omniroute/plan-a", "omniroute/plan-b"]);
    await f.store.writeModels({ ...cfg!, review: ["x/y"] });
    expect((await f.store.readModels())?.review).toEqual(["x/y"]);
    expect(await f.store.readModelsState()).toEqual({ version: 1, models: {} });
    await f.store.writeModelsState({ version: 1, models: { "a/b": { unavailableUntil: null, manual: true, category: "no_subscription", since: "x" } } });
    expect((await f.store.readModelsState()).models["a/b"]?.manual).toBe(true);
    await writeFile(f.store.modelsStatePath(), "{oops");
    expect(await f.store.readModelsState()).toEqual({ version: 1, models: {} });
    const g = await makeFixture({ models: false });
    expect(await g.store.readModels()).toBeNull();
  });
});
