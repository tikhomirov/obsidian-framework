/** Р-035: «Модели» — view and edit models.json from the board. Writes only through the API (PUT /models). */
import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type { ModelsState } from "@of/core";
import type { ApiClient } from "./api.js";
import { ApiError } from "./api.js";
import type { ChainKey, RawModels } from "./modelsedit.js";
import { CHAINS, activeIndex, addModel, cloneModels, getChain, modelStatus, moveModel, parseRawJson, removeModel, sameModels, setCooldown, statusText } from "./modelsedit.js";

const fmt = (iso: string): string => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function errText(err: unknown): string {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
}

export class ModelsModal extends Modal {
  private original: RawModels | null = null;
  private draft: RawModels | null = null;
  private state: ModelsState = { version: 1, models: {} };
  private path = "";
  private error: string | null = null;
  private jsonMode = false;
  private jsonText = "";

  constructor(
    app: App,
    private readonly api: () => ApiClient | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("of-models-modal");
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    const api = this.api();
    if (!api) {
      this.error = "Укажи адрес сервера и токен в настройках плагина";
      this.render();
      return;
    }
    try {
      const r = await api.models();
      this.original = r.raw;
      this.draft = r.raw ? cloneModels(r.raw) : null;
      this.state = r.state;
      this.path = r.path;
      this.error = r.error;
    } catch (err) {
      this.error = errText(err);
    }
    this.render();
  }

  private async save(raw: unknown): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      const r = await api.saveModels(raw);
      this.original = r.raw;
      this.draft = r.raw ? cloneModels(r.raw) : null;
      this.state = r.state;
      this.error = null;
      this.jsonMode = false;
      new Notice("models.json сохранён");
    } catch (err) {
      this.error = errText(err);
    }
    this.render();
  }

  private async reset(model: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      this.state = (await api.resetModel(model)).state;
      new Notice(`${model}: отметка снята`);
    } catch (err) {
      this.error = errText(err);
    }
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "Модели" });
    if (this.path) el.createDiv({ cls: "of-models-path", text: `${this.path} — запись только через сервер, с проверкой` });
    if (this.error) el.createDiv({ cls: "of-error", text: this.error });
    const bar = el.createDiv({ cls: "of-toolbar" });
    const dirty = this.draft !== null && this.original !== null && !sameModels(this.draft, this.original);
    if (this.jsonMode) this.renderJson(el, bar);
    else this.renderChains(el, bar, dirty);
  }

  private renderChains(el: HTMLElement, bar: HTMLElement, dirty: boolean): void {
    const draft = this.draft;
    const save = bar.createEl("button", { text: dirty ? "Сохранить" : "Сохранено", cls: dirty ? "mod-cta" : "" });
    save.disabled = !dirty;
    save.onclick = () => void this.save(this.draft);
    const undo = bar.createEl("button", { text: "Отменить правки" });
    undo.disabled = !dirty;
    undo.onclick = () => {
      this.draft = this.original ? cloneModels(this.original) : null;
      this.render();
    };
    const json = bar.createEl("button", { text: "Открыть как JSON" });
    json.onclick = () => {
      this.jsonMode = true;
      this.jsonText = `${JSON.stringify(this.draft ?? this.original ?? {}, null, 2)}\n`;
      this.render();
    };
    const reload = bar.createEl("button", { text: "⟳" });
    reload.onclick = () => void this.load();
    if (!draft) return;

    const cd = el.createDiv({ cls: "of-models-cooldown" });
    cd.createSpan({ text: "Пауза после лимита по умолчанию, мин: " });
    const cdIn = cd.createEl("input", { type: "number", value: String(draft.default_cooldown_minutes) });
    cdIn.onchange = () => {
      const v = Number(cdIn.value);
      if (Number.isInteger(v) && v > 0) {
        this.draft = setCooldown(draft, v);
        this.render();
      }
    };

    const now = new Date();
    for (const { key, title } of CHAINS) this.renderChain(el, draft, key, title, now);
  }

  private renderChain(el: HTMLElement, draft: RawModels, key: ChainKey, title: string, now: Date): void {
    const box = el.createDiv({ cls: "of-models-chain" });
    box.createEl("h4", { text: title });
    const chain = getChain(draft, key);
    const active = activeIndex(chain, this.state, now);
    if (chain.length === 0) box.createDiv({ cls: "of-muted", text: "пусто — задачи этой роли будут ждать модель" });
    chain.forEach((model, i) => {
      const row = box.createDiv({ cls: "of-models-row" });
      row.createSpan({ cls: "of-models-mark", text: i === active ? "★" : String(i + 1) });
      row.createSpan({ cls: "of-models-name", text: model });
      const st = modelStatus(this.state, model, now);
      row.createSpan({ cls: `of-models-status of-models-${st.kind}`, text: statusText(st, fmt) });
      if (st.kind !== "ok") {
        const r = row.createEl("button", { text: "Сбросить", attr: { title: "Снять отметку недоступности" } });
        r.onclick = () => void this.reset(model);
      }
      const up = row.createEl("button", { text: "↑" });
      up.disabled = i === 0;
      up.onclick = () => {
        this.draft = moveModel(draft, key, i, -1);
        this.render();
      };
      const down = row.createEl("button", { text: "↓" });
      down.disabled = i === chain.length - 1;
      down.onclick = () => {
        this.draft = moveModel(draft, key, i, 1);
        this.render();
      };
      const del = row.createEl("button", { text: "✕" });
      del.onclick = () => {
        this.draft = removeModel(draft, key, i);
        this.render();
      };
    });
    const add = box.createDiv({ cls: "of-models-add" });
    const input = add.createEl("input", { type: "text", placeholder: "провайдер/модель" });
    const btn = add.createEl("button", { text: "Добавить" });
    const doAdd = (): void => {
      const r = addModel(draft, key, input.value);
      if (r.error) {
        new Notice(r.error);
        return;
      }
      this.draft = r.raw;
      this.render();
    };
    btn.onclick = doAdd;
    input.onkeydown = (e) => {
      if (e.key === "Enter") doAdd();
    };
  }

  private renderJson(el: HTMLElement, bar: HTMLElement): void {
    const save = bar.createEl("button", { text: "Сохранить JSON", cls: "mod-cta" });
    const back = bar.createEl("button", { text: "Назад к цепочкам" });
    back.onclick = () => {
      this.jsonMode = false;
      this.render();
    };
    const area = el.createEl("textarea", { cls: "of-models-json" });
    area.value = this.jsonText;
    area.rows = 28;
    area.oninput = () => {
      this.jsonText = area.value;
    };
    save.onclick = () => {
      const p = parseRawJson(this.jsonText);
      if (p.error) {
        this.error = p.error;
        this.render();
        return;
      }
      void this.save(p.raw);
    };
  }
}
