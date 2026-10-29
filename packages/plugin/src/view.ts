/** Board view (Р-011): columns per status, drag → human event with a required reason (Р-017). */
import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Menu, Modal, Notice, Setting, TFile } from "obsidian";
import type { TaskActionContext, TaskStatus } from "@of/core";
import type { ApiClient, ServerStatus, TaskView } from "./api.js";
import { ApiError } from "./api.js";
import { EVENT_TITLES, buildColumns, cardBadges, planMove } from "./board.js";
import type { PluginSettings } from "./settings.js";

export const VIEW_TYPE = "obsidian-framework-board";

export interface BoardHost {
  config: PluginSettings;
  api(): ApiClient | null;
  status: ServerStatus | null;
  actionContext(): TaskActionContext;
  /** Р-034: show the board file as a plain note. */
  openBoardAsNote(path: string): Promise<void>;
  /** Р-035: models.json editor. */
  openModels(): void;
}

export class ReasonModal extends Modal {
  private reason = "";
  constructor(
    app: App,
    private readonly heading: string,
    private readonly onSubmit: (reason: string) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(this.heading);
    new Setting(this.contentEl).setName("Причина (обязательно)").addTextArea((t) => {
      t.inputEl.rows = 3;
      t.inputEl.style.width = "100%";
      t.onChange((v) => (this.reason = v));
      window.setTimeout(() => {
        t.inputEl.focus();
      }, 0);
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Подтвердить")
        .setCta()
        .onClick(() => {
          if (!this.reason.trim()) {
            new Notice("Укажи причину");
            return;
          }
          this.close();
          this.onSubmit(this.reason.trim());
        }),
    );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class CreateTaskModal extends Modal {
  private title = "";
  private description = "";
  private mode: "fast" | "full" = "fast";
  constructor(
    app: App,
    private readonly onSubmit: (input: { title: string; description: string; plannerMode: "fast" | "full" }) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText("Новая задача");
    new Setting(this.contentEl).setName("Название").addText((t) => t.onChange((v) => (this.title = v)));
    new Setting(this.contentEl).setName("Описание").addTextArea((t) => {
      t.inputEl.rows = 6;
      t.onChange((v) => (this.description = v));
    });
    new Setting(this.contentEl).setName("Режим планирования").addDropdown((d) =>
      d
        .addOption("fast", "fast")
        .addOption("full", "full")
        .setValue("fast")
        .onChange((v) => (this.mode = v === "full" ? "full" : "fast")),
    );
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Создать")
        .setCta()
        .onClick(() => {
          if (!this.title.trim()) {
            new Notice("Нужно название");
            return;
          }
          this.close();
          this.onSubmit({ title: this.title.trim(), description: this.description, plannerMode: this.mode });
        }),
    );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly task: TaskView,
    private readonly api: ApiClient,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(`История ${this.task.id}: ${this.task.title}`);
    const box = this.contentEl.createDiv({ cls: "of-history" });
    box.setText("Загрузка…");
    void this.api
      .history(this.task.project, this.task.id)
      .then((rows) => {
        box.empty();
        if (rows.length === 0) box.setText("Пусто");
        const table = box.createEl("table");
        const head = table.createEl("tr");
        for (const h of ["время", "кто", "действие", "из → в", "причина"]) head.createEl("th", { text: h });
        for (const r of [...rows].reverse()) {
          const tr = table.createEl("tr");
          tr.createEl("td", { text: r.at.replace("T", " ").slice(0, 19) });
          tr.createEl("td", { text: r.actor });
          tr.createEl("td", { text: r.action });
          tr.createEl("td", { text: r.from || r.to ? `${r.from || "—"} → ${r.to || "—"}` : "" });
          tr.createEl("td", { text: r.reason });
        }
      })
      .catch((err: unknown) => {
        box.setText(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class BoardView extends ItemView {
  private tasks: TaskView[] = [];
  private dragging: TaskView | null = null;
  private error: string | null = null;
  /** Project and board file (`Проекты/<Проект>/Доска.md`, Р-034) shown in this leaf. */
  private project: string | null = null;
  private file: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: BoardHost,
  ) {
    super(leaf);
  }

  projectId(): string {
    return this.project ?? this.host.config.project;
  }
  boardFile(): string | null {
    return this.file;
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), project: this.project, file: this.file };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (state !== null && typeof state === "object") {
      const s = state as Record<string, unknown>;
      if (typeof s["project"] === "string") this.project = s["project"];
      if (typeof s["file"] === "string") this.file = s["file"];
    }
    await super.setState(state, result);
    await this.refresh();
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return `Доска — ${this.projectId()}`;
  }
  override getIcon(): string {
    return "kanban-square";
  }

  override async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const api = this.host.api();
    if (!api) {
      this.error = "Укажи адрес сервера и токен в настройках плагина";
      this.render();
      return;
    }
    try {
      this.tasks = await api.tasks(this.projectId(), this.host.config.showArchived);
      this.error = null;
    } catch (err) {
      this.error = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("of-board-root");
    const bar = root.createDiv({ cls: "of-toolbar" });
    bar.createEl("strong", { text: `Проект ${this.projectId()}` });
    const file = this.file;
    if (file !== null) {
      const note = bar.createEl("button", { text: "Как заметку", attr: { title: file } });
      note.onclick = () => void this.host.openBoardAsNote(file);
    }
    const add = bar.createEl("button", { text: "＋ Задача" });
    add.onclick = () => {
      this.openCreate();
    };
    const models = bar.createEl("button", { text: "Модели", attr: { title: "Цепочки моделей (models.json)" } });
    models.onclick = () => {
      this.host.openModels();
    };
    const reload = bar.createEl("button", { text: "⟳" });
    reload.onclick = () => void this.refresh();
    if (this.error) {
      root.createDiv({ cls: "of-error", text: this.error });
      return;
    }
    const st = this.host.status?.coordinator;
    const info = {
      running: new Set((st?.running ?? []).map((r) => `${r.project}/${r.taskId}`)),
      waitingWorker: new Set(st?.waitingWorker ?? []),
      waitingModel: new Set(st?.waitingModel ?? []),
    };
    const board = root.createDiv({ cls: "of-board" });
    const hide: TaskStatus[] = this.host.config.hideEmptyColumns ? ["improve", "verify", "blocked_external"] : [];
    for (const col of buildColumns(this.tasks, { hideEmpty: hide, showArchived: this.host.config.showArchived })) {
      const colEl = board.createDiv({ cls: "of-column" });
      colEl.dataset["status"] = col.status;
      colEl.createDiv({ cls: "of-column-title", text: `${col.title} · ${String(col.tasks.length)}` });
      colEl.ondragover = (e) => {
        e.preventDefault();
        colEl.addClass("of-drop");
      };
      colEl.ondragleave = () => { colEl.removeClass("of-drop"); };
      colEl.ondrop = (e) => {
        e.preventDefault();
        colEl.removeClass("of-drop");
        const t = this.dragging;
        this.dragging = null;
        if (t) this.move(t, col.status);
      };
      for (const task of col.tasks) {
        const card = colEl.createDiv({ cls: `of-card${task.archived ? " of-archived" : ""}` });
        card.draggable = true;
        card.ondragstart = () => (this.dragging = task);
        card.createDiv({ cls: "of-card-id", text: task.id });
        card.createDiv({ cls: "of-card-title", text: task.title });
        const badges = card.createDiv({ cls: "of-badges" });
        for (const b of cardBadges(task, info)) badges.createSpan({ cls: `of-badge of-badge-${b.kind}`, text: b.text, attr: { title: b.title } });
        card.onclick = () => void this.openFile(task);
        card.oncontextmenu = (e) => {
          e.preventDefault();
          this.menu(task, e);
        };
      }
    }
  }

  private move(task: TaskView, to: TaskStatus): void {
    const plan = planMove(task, to, this.host.actionContext());
    if (plan.kind === "noop") return;
    if (plan.kind === "denied") {
      new Notice(plan.message);
      return;
    }
    new ReasonModal(this.app, `${task.id}: ${EVENT_TITLES[plan.event]}`, (reason) => {
      void this.run(() => this.host.api()?.applyEvent(task.project, task.id, plan.event, reason, task.status));
    }).open();
  }

  private menu(task: TaskView, e: MouseEvent): void {
    const m = new Menu();
    for (const ev of task.permissions.permittedActions) {
      m.addItem((i) =>
        i.setTitle(EVENT_TITLES[ev]).onClick(() => {
          new ReasonModal(this.app, `${task.id}: ${EVENT_TITLES[ev]}`, (reason) => {
            void this.run(() => this.host.api()?.applyEvent(task.project, task.id, ev, reason, task.status));
          }).open();
        }),
      );
    }
    m.addSeparator();
    if (task.permissions.canHandoff) {
      const toHuman = task.executionOwner === "ai";
      m.addItem((i) =>
        i.setTitle(toHuman ? "Взять себе" : "Вернуть ИИ").onClick(() => {
          new ReasonModal(this.app, `${task.id}: ${toHuman ? "взять себе" : "вернуть ИИ"}`, (reason) => {
            const resumeAction = !toHuman && task.status === "blocked_external" ? "retry_from_blocked" : !toHuman && task.status === "plan_ready" && !task.autoMode ? "start_implementation" : undefined;
            void this.run(() =>
              this.host.api()?.handoff(task.project, task.id, {
                executionOwner: toHuman ? "human" : "ai",
                assigneeIds: toHuman ? [this.host.config.participantId] : [],
                expectedOwnershipRevision: task.ownershipRevision,
                reason,
                ...(resumeAction ? { resumeAction } : {}),
              }),
            );
          }).open();
        }),
      );
    }
    m.addItem((i) =>
      i.setTitle(task.paused ? "Снять с паузы" : "Пауза").onClick(() => {
        void this.run(() => this.host.api()?.updateTask(task.project, task.id, { paused: !task.paused }));
      }),
    );
    m.addItem((i) =>
      i.setTitle(task.archived ? "Восстановить из архива" : "В архив").onClick(() => {
        new ReasonModal(this.app, `${task.id}: ${task.archived ? "восстановить" : "в архив"}`, (reason) => {
          void this.run(() => this.host.api()?.archive(task.project, task.id, !task.archived, reason));
        }).open();
      }),
    );
    m.addItem((i) =>
      i.setTitle("История").onClick(() => {
        const api = this.host.api();
        if (api) new HistoryModal(this.app, task, api).open();
      }),
    );
    m.showAtMouseEvent(e);
  }

  private openCreate(): void {
    new CreateTaskModal(this.app, (input) => {
      void this.run(() => this.host.api()?.createTask(this.projectId(), input));
    }).open();
  }

  private async run(fn: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      new Notice(err instanceof ApiError ? `Ошибка: ${err.message}` : String(err));
    }
    await this.refresh();
  }

  private async openFile(task: TaskView): Promise<void> {
    const file = this.app.vault
      .getMarkdownFiles()
      .find((f) => f.basename === task.id && f.parent?.parent !== null && this.app.metadataCache.getFileCache(this.projectFile(f) ?? f)?.frontmatter?.["id"] === task.project);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Файл ${task.id}.md не найден в хранилище`);
  }

  private projectFile(f: TFile): TFile | null {
    const dir = f.parent?.parent;
    if (!dir) return null;
    const p = this.app.vault.getAbstractFileByPath(`${dir.path}/Проект.md`);
    return p instanceof TFile ? p : null;
  }
}
