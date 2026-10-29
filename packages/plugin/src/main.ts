/** Obsidian Framework plugin (stage 3): board, status indicator, settings. */
import type { RequestUrlParam } from "obsidian";
import { Notice, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type { App, ViewState } from "obsidian";
import { TFile, WorkspaceLeaf } from "obsidian";
import type { TaskActionContext, TaskAssignee } from "@of/core";
import type { Requester, ServerStatus } from "./api.js";
import { ApiClient } from "./api.js";
import { indicator } from "./board.js";
import type { PluginSettings } from "./settings.js";
import { normalizeSettings, serverUrlWarning } from "./settings.js";
import { EventStream } from "./stream.js";
import type { NoteRef } from "./boardfile.js";
import { boardFileFor, boardProjectOf, findProjectFolder } from "./boardfile.js";
import type { BoardHost } from "./view.js";
import { BoardView, CreateTaskModal, VIEW_TYPE } from "./view.js";
import { ModelsModal } from "./modelsview.js";

const obsidianRequest: Requester = async (req) => {
  const param: RequestUrlParam = { url: req.url, method: req.method, headers: req.headers, throw: false };
  if (req.body !== undefined) param.body = req.body;
  const res = await requestUrl(param);
  let json: unknown = null;
  try {
    json = res.json as unknown;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

export default class ObsidianFrameworkPlugin extends Plugin implements BoardHost {
  config: PluginSettings = normalizeSettings({});
  status: ServerStatus | null = null;
  private participants: TaskAssignee[] = [];
  private statusEl: HTMLElement | null = null;
  private stream: EventStream | null = null;
  private refreshTimer: number | null = null;
  private serverOk = false;
  /** Board files the user chose to see as plain notes in this session (Р-034). */
  private readonly asNote = new Set<string>();

  override async onload(): Promise<void> {
    this.config = normalizeSettings(await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.addRibbonIcon("kanban-square", "Доска задач", () => void this.openBoard());
    this.addCommand({ id: "open-board", name: "Открыть доску задач", callback: () => void this.openBoard() });
    this.addCommand({ id: "open-models", name: "Модели (models.json)", callback: () => {
        this.openModels();
      },
    });
    this.addCommand({
      id: "create-task",
      name: "Новая задача",
      callback: () => {
        new CreateTaskModal(this.app, (input) => {
          void this.api()
            ?.createTask(this.config.project, input)
            .then((t) => new Notice(`Создана ${t.id}`))
            .catch((e: unknown) => new Notice(String(e)));
        }).open();
      },
    });
    // Р-034: opening `Проекты/<Проект>/Доска.md` shows the board (same approach as the Kanban plugin:
    // the markdown view state is swapped for the board view before the view is created).
    this.patchSetViewState();
    this.statusEl = this.addStatusBarItem();
    this.addSettingTab(new FrameworkSettingTab(this.app, this));
    this.restart();
  }

  override onunload(): void {
    this.stream?.stop();
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
  }

  api(): ApiClient | null {
    if (!this.config.token || !this.config.serverUrl) return null;
    return new ApiClient(this.config.serverUrl, this.config.token, obsidianRequest);
  }

  actionContext(): TaskActionContext {
    const p = this.participants.find((x) => x.participantId === this.config.participantId);
    return {
      participantsModeEnabled: true,
      actor: { kind: "participant", id: this.config.participantId, displayNameSnapshot: p?.displayName ?? null },
      participantRole: p?.role ?? null,
      participantActive: p?.active ?? false,
    };
  }

  restart(): void {
    this.stream?.stop();
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    const api = this.api();
    if (api) {
      this.stream = new EventStream(
        `${this.config.serverUrl}/events?project=${encodeURIComponent(this.config.project)}`,
        this.config.token,
        (url, init) => fetch(url, init),
        () => void this.refreshViews(false),
        () => void this.refreshStatus(),
      );
      this.stream.start();
    }
    this.refreshTimer = window.setInterval(() => void this.refreshViews(true), this.config.refreshSeconds * 1000);
    this.registerInterval(this.refreshTimer);
    void this.refreshViews(true);
  }

  async refreshStatus(): Promise<void> {
    const api = this.api();
    try {
      if (!api) throw new Error("not configured");
      this.status = await api.status();
      if (this.participants.length === 0) this.participants = await api.participants();
      this.serverOk = true;
    } catch {
      this.serverOk = false;
      this.status = null;
    }
    const w = this.status?.coordinator?.worker;
    const ind = indicator({
      ok: this.serverOk,
      workerOnline: w?.configured ? w.online : null,
      error: null,
      workerCheckedAt: w?.configured ? w.checkedAt : undefined,
      workerDetail: w?.detail,
    });
    if (this.statusEl) {
      this.statusEl.setText(ind.text);
      this.statusEl.setAttr("title", ind.title);
      this.statusEl.className = `status-bar-item ${ind.cls}`;
    }
  }

  async refreshViews(withStatus: boolean): Promise<void> {
    if (withStatus) await this.refreshStatus();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof BoardView) await v.refresh();
    }
  }

  private noteRef(f: TFile): NoteRef {
    return { path: f.path, name: f.name, folder: f.parent?.path ?? "", frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter ?? null };
  }

  private boardProject(file: TFile): string | null {
    const ref = this.noteRef(file);
    const sibling = this.app.vault.getAbstractFileByPath(ref.folder ? `${ref.folder}/Проект.md` : "Проект.md");
    const siblingFm = sibling instanceof TFile ? (this.app.metadataCache.getFileCache(sibling)?.frontmatter ?? null) : null;
    return boardProjectOf(ref, siblingFm);
  }

  /** View state for a board file, or null when `state` is not a markdown view of a board file. */
  boardViewState(state: ViewState): ViewState | null {
    if (state.type !== "markdown") return null;
    const path = state.state?.["file"];
    if (typeof path !== "string" || this.asNote.has(path)) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const project = this.boardProject(file);
    if (project === null) return null;
    return { ...state, type: VIEW_TYPE, state: { project, file: path } };
  }

  private patchSetViewState(): void {
    const proto = WorkspaceLeaf.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- original is re-bound via call()
    const original = proto.setViewState;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- needed inside the prototype patch
    const plugin = this;
    proto.setViewState = function (this: WorkspaceLeaf, viewState: ViewState, eState?: unknown): Promise<void> {
      return original.call(this, plugin.boardViewState(viewState) ?? viewState, eState);
    };
    this.register(() => {
      proto.setViewState = original;
    });
  }

  openModels(): void {
    new ModelsModal(this.app, () => this.api()).open();
  }

  async openBoardAsNote(path: string): Promise<void> {
    this.asNote.add(path);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view instanceof BoardView && l.view.boardFile() === path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await (leaf ?? this.app.workspace.getLeaf("tab")).openFile(file);
  }

  /** Open (and create when missing) `Проекты/<Проект>/Доска.md` for the configured project. */
  async openBoard(): Promise<void> {
    const project = this.config.project;
    const notes = this.app.vault.getMarkdownFiles().filter((f) => f.name === "Проект.md").map((f) => this.noteRef(f));
    const found = findProjectFolder(notes, project);
    let path: string | null = null;
    if (found) {
      const board = boardFileFor(found.folder, { id: project, title: found.title });
      path = board.path;
      if (!this.app.vault.getAbstractFileByPath(path) && !(await this.app.vault.adapter.exists(path))) {
        await this.app.vault.create(path, board.content);
      }
      this.asNote.delete(path);
    } else {
      new Notice(`Проект ${project}: Проект.md не найден в хранилище — доска без файла`);
    }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view instanceof BoardView && l.view.projectId() === project);
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    const stale = existing?.view instanceof BoardView && path !== null && existing.view.boardFile() !== path;
    if (!existing || stale) await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { project, ...(path ? { file: path } : {}) } });
    await this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.config);
    this.restart();
  }
}

class FrameworkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianFrameworkPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.config;
    const warn = containerEl.createDiv({ cls: "of-settings-warn" });
    const update = (): void => {
      warn.setText(serverUrlWarning(s.serverUrl) ?? "");
    };
    new Setting(containerEl)
      .setName("Адрес сервера")
      .setDesc("Только Tailscale-адрес сервера, например http://100.x.y.z:8787")
      .addText((t) =>
        t.setValue(s.serverUrl).onChange(async (v) => {
          this.plugin.config = normalizeSettings({ ...s, serverUrl: v });
          update();
          await this.plugin.saveSettings();
        }),
      );
    update();
    new Setting(containerEl)
      .setName("Токен")
      .setDesc("Токен участника (scope api). Хранится в настройках плагина в хранилище.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.token).onChange(async (v) => {
          this.plugin.config = normalizeSettings({ ...this.plugin.config, token: v });
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("Проект").addText((t) =>
      t.setValue(s.project).onChange(async (v) => {
        this.plugin.config = normalizeSettings({ ...this.plugin.config, project: v });
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Мой id участника").addText((t) =>
      t.setValue(s.participantId).onChange(async (v) => {
        this.plugin.config = normalizeSettings({ ...this.plugin.config, participantId: v });
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Показывать архив").addToggle((t) =>
      t.setValue(s.showArchived).onChange(async (v) => {
        this.plugin.config = normalizeSettings({ ...this.plugin.config, showArchived: v });
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Скрывать пустые служебные колонки").addToggle((t) =>
      t.setValue(s.hideEmptyColumns).onChange(async (v) => {
        this.plugin.config = normalizeSettings({ ...this.plugin.config, hideEmptyColumns: v });
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Проверить соединение").addButton((b) =>
      b.setButtonText("Проверить").onClick(async () => {
        await this.plugin.refreshStatus();
        new Notice(this.plugin.status ? `Сервер ${this.plugin.status.version}: OK` : "Сервер недоступен");
      }),
    );
  }
}
