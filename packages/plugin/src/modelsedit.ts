/** Р-035: editing models.json from the board — pure helpers (no Obsidian API). */
import type { ModelsState } from "@of/core";

export interface RawModels {
  version: 1;
  default_cooldown_minutes: number;
  roles: {
    worker: { opencode: string[]; pi: string[] };
    planning: string[];
    improve: string[];
    review: string[];
    verify: string[];
  };
}

export type ChainKey = "worker.opencode" | "worker.pi" | "planning" | "improve" | "review" | "verify";

export const CHAINS: { key: ChainKey; title: string }[] = [
  { key: "worker.opencode", title: "Воркер на ПК — OpenCode" },
  { key: "worker.pi", title: "Воркер на ПК — Pi" },
  { key: "planning", title: "Планирование и проверка плана (Pi)" },
  { key: "improve", title: "Улучшение плана (Pi)" },
  { key: "review", title: "Ревью и разбор блокировок (Pi)" },
  { key: "verify", title: "Проверка (Pi)" },
];

export function cloneModels(raw: RawModels): RawModels {
  return JSON.parse(JSON.stringify(raw)) as RawModels;
}

export function getChain(raw: RawModels, key: ChainKey): string[] {
  switch (key) {
    case "worker.opencode":
      return raw.roles.worker.opencode;
    case "worker.pi":
      return raw.roles.worker.pi;
    default:
      return raw.roles[key];
  }
}

function withChain(raw: RawModels, key: ChainKey, chain: string[]): RawModels {
  const next = cloneModels(raw);
  if (key === "worker.opencode") next.roles.worker.opencode = chain;
  else if (key === "worker.pi") next.roles.worker.pi = chain;
  else next.roles[key] = chain;
  return next;
}

/** Add a model at the end; trims, rejects empty, `provider/model` shape and duplicates. */
export function addModel(raw: RawModels, key: ChainKey, model: string): { raw: RawModels; error: string | null } {
  const m = model.trim();
  if (!m) return { raw, error: "Пустое имя модели" };
  if (!/^[^\s/]+\/\S+$/.test(m)) return { raw, error: "Формат: провайдер/модель" };
  const chain = getChain(raw, key);
  if (chain.includes(m)) return { raw, error: "Модель уже в цепочке" };
  return { raw: withChain(raw, key, [...chain, m]), error: null };
}

export function removeModel(raw: RawModels, key: ChainKey, index: number): RawModels {
  return withChain(raw, key, getChain(raw, key).filter((_, i) => i !== index));
}

/** Move a model up (-1) or down (+1); out-of-range moves are no-ops. */
export function moveModel(raw: RawModels, key: ChainKey, index: number, delta: -1 | 1): RawModels {
  const chain = [...getChain(raw, key)];
  const to = index + delta;
  if (index < 0 || index >= chain.length || to < 0 || to >= chain.length) return raw;
  const [item] = chain.splice(index, 1);
  if (item === undefined) return raw;
  chain.splice(to, 0, item);
  return withChain(raw, key, chain);
}

export function setCooldown(raw: RawModels, minutes: number): RawModels {
  const next = cloneModels(raw);
  next.default_cooldown_minutes = minutes;
  return next;
}

export type ModelStatus = { kind: "ok" } | { kind: "limit"; until: string; category: string } | { kind: "manual"; category: string };

export function modelStatus(state: ModelsState, model: string, now: Date): ModelStatus {
  const e = state.models[model];
  if (!e) return { kind: "ok" };
  if (e.manual) return { kind: "manual", category: e.category };
  if (e.unavailableUntil !== null && Date.parse(e.unavailableUntil) > now.getTime()) return { kind: "limit", until: e.unavailableUntil, category: e.category };
  return { kind: "ok" };
}

/** Index of the model the coordinator would pick now (first available), or -1. */
export function activeIndex(chain: string[], state: ModelsState, now: Date): number {
  return chain.findIndex((m) => modelStatus(state, m, now).kind === "ok");
}

export function statusText(s: ModelStatus, fmt: (iso: string) => string): string {
  switch (s.kind) {
    case "ok":
      return "доступна";
    case "limit":
      return `лимит до ${fmt(s.until)} (${s.category})`;
    case "manual":
      return `выключена до сброса (${s.category})`;
  }
}

export function parseRawJson(text: string): { raw: unknown; error: string | null } {
  try {
    return { raw: JSON.parse(text) as unknown, error: null };
  } catch (err) {
    return { raw: null, error: `Не JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function sameModels(a: RawModels, b: RawModels): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
