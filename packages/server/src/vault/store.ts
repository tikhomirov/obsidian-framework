/**
 * Vault storage: the only writer of `.md` task files, project files, the journal
 * and models.json state (Р-005, spec 4 and 6). Each project lives in `Проекты/<Папка>/`.
 */
import { join } from "node:path";
import type { JournalEvent, ModelsConfig, ModelsState, Project, Task } from "@of/core";
import {
  BOARD_FILE,
  boardMarkdown,
  EMPTY_MODELS_STATE,
  TaskFormatError,
  formatJournalRow,
  journalFileName,
  journalFileTemplate,
  parseJournal,
  parseModelsConfig,
  parseModelsState,
  parseProjectMarkdown,
  parseTaskMarkdown,
  serializeModelsConfig,
  serializeProjectMarkdown,
  serializeTaskMarkdown,
  isTaskId,
} from "@of/core";
import type { JournalRow } from "@of/core";
import { appendText, exists, listDir, moveFile, readText, writeTextAtomic } from "../fsutil.js";

export const TASKS_DIR = "Задачи";
export const ARCHIVE_DIR = "Архив";
export const JOURNAL_DIR = "_журнал";
export const PROJECT_FILE = "Проект.md";

export interface StoredTask {
  task: Task;
  text: string;
  archived: boolean;
  path: string;
}

export interface StoreOptions {
  vaultDir: string;
  projectsDir: string;
  frameworkDir: string;
  tzOffsetMinutes: number;
}

export interface BadFile {
  path: string;
  error: string;
}

export class VaultStore {
  private readonly opts: StoreOptions;
  private folderCache = new Map<string, string>();
  private readonly boardsChecked = new Set<string>();

  constructor(opts: StoreOptions) {
    this.opts = opts;
  }

  get vaultDir(): string {
    return this.opts.vaultDir;
  }

  private projectsRoot(): string {
    return join(this.opts.vaultDir, this.opts.projectsDir);
  }

  /** Scan `Проекты/*\/Проект.md` with `type: project`. */
  async listProjects(): Promise<{ projects: Project[]; bad: BadFile[] }> {
    const projects: Project[] = [];
    const bad: BadFile[] = [];
    const next = new Map<string, string>();
    for (const entry of await listDir(this.projectsRoot())) {
      if (!entry.isDir || entry.name.startsWith(".")) continue;
      const path = join(this.projectsRoot(), entry.name, PROJECT_FILE);
      const text = await readText(path);
      if (text === null) continue;
      try {
        const { project } = parseProjectMarkdown(text);
        if (next.has(project.id)) {
          bad.push({ path, error: `duplicate project id ${project.id}` });
          continue;
        }
        next.set(project.id, entry.name);
        projects.push(project);
      } catch (err) {
        if (err instanceof TaskFormatError) continue;
        /* v8 ignore next */
        throw err;
      }
    }
    this.folderCache = next;
    projects.sort((a, b) => a.id.localeCompare(b.id));
    return { projects, bad };
  }

  async projectFolder(projectId: string): Promise<string | null> {
    if (!this.folderCache.has(projectId)) await this.listProjects();
    const folder = this.folderCache.get(projectId);
    return folder === undefined ? null : join(this.projectsRoot(), folder);
  }

  /**
   * Р-034: make sure every project has `Доска.md` in its root. Never overwrites an existing file.
   * Returns vault-relative paths of created boards.
   */
  async ensureBoards(): Promise<string[]> {
    const created: string[] = [];
    const { projects } = await this.listProjects();
    for (const project of projects) {
      if (this.boardsChecked.has(project.id)) continue;
      const folder = this.folderCache.get(project.id);
      /* v8 ignore next */
      if (folder === undefined) continue;
      const path = join(this.projectsRoot(), folder, BOARD_FILE);
      if (!(await exists(path))) {
        await writeTextAtomic(path, boardMarkdown({ id: project.id, title: project.title }));
        created.push(`${this.opts.projectsDir}/${folder}/${BOARD_FILE}`);
      }
      this.boardsChecked.add(project.id);
    }
    return created;
  }

  async readProject(projectId: string): Promise<{ project: Project; text: string; path: string } | null> {
    const folder = await this.projectFolder(projectId);
    if (folder === null) return null;
    const path = join(folder, PROJECT_FILE);
    const text = await readText(path);
    if (text === null) return null;
    return { project: parseProjectMarkdown(text).project, text, path };
  }

  async writeProject(project: Project, previous: string, path: string): Promise<void> {
    await writeTextAtomic(path, serializeProjectMarkdown(project, previous));
  }

  async listTasks(projectId: string, includeArchived = false): Promise<{ tasks: StoredTask[]; bad: BadFile[] }> {
    const folder = await this.projectFolder(projectId);
    const tasks: StoredTask[] = [];
    const bad: BadFile[] = [];
    if (folder === null) return { tasks, bad };
    const dirs: [string, boolean][] = [[TASKS_DIR, false]];
    if (includeArchived) dirs.push([ARCHIVE_DIR, true]);
    for (const [dir, archived] of dirs) {
      for (const entry of await listDir(join(folder, dir))) {
        if (entry.isDir || !entry.name.endsWith(".md")) continue;
        const id = entry.name.slice(0, -3);
        if (!isTaskId(id)) continue;
        const path = join(folder, dir, entry.name);
        const text = await readText(path);
        if (text === null) continue;
        try {
          const task = parseTaskMarkdown(text, projectId);
          if (task.id !== id) throw new TaskFormatError(`id ${task.id} does not match file name ${id}`);
          tasks.push({ task, text, archived, path });
        } catch (err) {
          if (!(err instanceof TaskFormatError)) throw err;
          bad.push({ path, error: err.message });
        }
      }
    }
    return { tasks, bad };
  }

  async readTask(projectId: string, id: string): Promise<StoredTask | null> {
    const folder = await this.projectFolder(projectId);
    if (folder === null || !isTaskId(id)) return null;
    for (const [dir, archived] of [
      [TASKS_DIR, false],
      [ARCHIVE_DIR, true],
    ] as const) {
      const path = join(folder, dir, `${id}.md`);
      const text = await readText(path);
      if (text !== null) return { task: parseTaskMarkdown(text, projectId), text, archived, path };
    }
    return null;
  }

  async writeTask(task: Task, previous: StoredTask | null): Promise<StoredTask> {
    const folder = await this.projectFolder(task.project);
    if (folder === null) throw new Error(`Unknown project ${task.project}`);
    const archived = previous?.archived ?? false;
    const path = previous?.path ?? join(folder, TASKS_DIR, `${task.id}.md`);
    const text = serializeTaskMarkdown(task, previous?.text);
    await writeTextAtomic(path, text);
    return { task, text, archived, path };
  }

  async taskFileExists(projectId: string, id: string): Promise<boolean> {
    const folder = await this.projectFolder(projectId);
    if (folder === null) return false;
    return (await exists(join(folder, TASKS_DIR, `${id}.md`))) || exists(join(folder, ARCHIVE_DIR, `${id}.md`));
  }

  /** Archive = move the file, name unchanged (Р-011, spec 5). */
  async setArchived(stored: StoredTask, archived: boolean): Promise<StoredTask> {
    if (stored.archived === archived) return stored;
    const folder = await this.projectFolder(stored.task.project);
    if (folder === null) throw new Error(`Unknown project ${stored.task.project}`);
    const to = join(folder, archived ? ARCHIVE_DIR : TASKS_DIR, `${stored.task.id}.md`);
    await moveFile(stored.path, to);
    return { ...stored, archived, path: to };
  }

  async appendJournal(projectId: string, event: JournalEvent, now: Date): Promise<void> {
    const folder = await this.projectFolder(projectId);
    if (folder === null) throw new Error(`Unknown project ${projectId}`);
    const file = journalFileName(now, this.opts.tzOffsetMinutes);
    const path = join(folder, JOURNAL_DIR, file);
    if (!(await exists(path))) {
      await writeTextAtomic(path, journalFileTemplate(projectId, file.slice(0, 7)));
    }
    await appendText(path, `${formatJournalRow(event)}\n`);
  }

  async readJournal(projectId: string, maxFiles = 12): Promise<JournalRow[]> {
    const folder = await this.projectFolder(projectId);
    if (folder === null) return [];
    const files = (await listDir(join(folder, JOURNAL_DIR)))
      .filter((e) => !e.isDir && /^\d{4}-\d{2}\.md$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(-maxFiles);
    const rows: JournalRow[] = [];
    for (const name of files) {
      const text = await readText(join(folder, JOURNAL_DIR, name));
      if (text !== null) rows.push(...parseJournal(text));
    }
    return rows;
  }

  // ---- models.json (Р-024) ----

  modelsRelativePath(): string {
    return `${this.opts.frameworkDir}/models.json`;
  }

  modelsPath(): string {
    return join(this.opts.vaultDir, this.opts.frameworkDir, "models.json");
  }

  modelsStatePath(): string {
    return join(this.opts.vaultDir, this.opts.frameworkDir, "_состояние", "models-state.json");
  }

  async readModelsRaw(): Promise<string | null> {
    return readText(this.modelsPath());
  }

  async readModels(): Promise<ModelsConfig | null> {
    const text = await this.readModelsRaw();
    if (text === null) return null;
    return parseModelsConfig(JSON.parse(text) as unknown);
  }

  async writeModels(config: ModelsConfig): Promise<void> {
    await writeTextAtomic(this.modelsPath(), serializeModelsConfig(config));
  }

  async readModelsState(): Promise<ModelsState> {
    const text = await readText(this.modelsStatePath());
    if (text === null) return EMPTY_MODELS_STATE;
    try {
      return parseModelsState(JSON.parse(text) as unknown);
    } catch {
      return EMPTY_MODELS_STATE;
    }
  }

  async writeModelsState(state: ModelsState): Promise<void> {
    await writeTextAtomic(this.modelsStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  }
}
