/**
 * Model chains (Р-024): `Проекты/Obsidian Framework/models.json` + backend state
 * `_состояние/models-state.json`. A limit only switches the model (Р-025).
 */
import type { RuntimeErrorCategory } from "./errors.js";
import type { ModelRole } from "./pipeline.js";
import type { RuntimeProfile } from "./types.js";
import { RUNTIME_PROFILES } from "./types.js";

export interface ModelsConfig {
  version: 1;
  defaultCooldownMinutes: number;
  worker: Record<RuntimeProfile, string[]>;
  planning: string[];
  improve: string[];
  review: string[];
  verify: string[];
}

export interface ModelAvailability {
  /** null + manual=true → until a human/agent resets it (no subscription). */
  unavailableUntil: string | null;
  manual: boolean;
  category: RuntimeErrorCategory;
  since: string;
}

export interface ModelsState {
  version: 1;
  models: Record<string, ModelAvailability>;
}

export const EMPTY_MODELS_STATE: ModelsState = { version: 1, models: {} };

export class ModelsConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`models.json is invalid: ${issues.join("; ")}`);
    this.name = "ModelsConfigError";
    this.issues = issues;
  }
}

const MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+(#[A-Za-z0-9._-]+)?$/;
const SERVER_ROLES = ["planning", "improve", "review", "verify"] as const;

function modelList(value: unknown, path: string, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of "provider/model" strings`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string" || !MODEL_RE.test(item)) issues.push(`${path}[${String(i)}] must be "provider/model"`);
    else out.push(item);
  });
  if (value.length === 0) issues.push(`${path} must not be empty`);
  return out;
}

/** Validate parsed JSON (schema in spec 3.8). Throws ModelsConfigError with all issues. */
export function parseModelsConfig(raw: unknown): ModelsConfig {
  const issues: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ModelsConfigError(["root must be an object"]);
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) issues.push("version must be 1");
  const cooldown = obj["default_cooldown_minutes"] ?? 300;
  if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 1 || cooldown > 10_080) {
    issues.push("default_cooldown_minutes must be an integer 1..10080");
  }
  const roles = obj["roles"];
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new ModelsConfigError([...issues, "roles must be an object"]);
  }
  const r = roles as Record<string, unknown>;
  const workerRaw = r["worker"];
  const worker = {} as Record<RuntimeProfile, string[]>;
  if (workerRaw === null || typeof workerRaw !== "object" || Array.isArray(workerRaw)) {
    issues.push("roles.worker must be an object { opencode: [...], pi: [...] }");
    for (const p of RUNTIME_PROFILES) worker[p] = [];
  } else {
    const w = workerRaw as Record<string, unknown>;
    for (const p of RUNTIME_PROFILES) worker[p] = modelList(w[p], `roles.worker.${p}`, issues);
  }
  const server = {} as Record<(typeof SERVER_ROLES)[number], string[]>;
  for (const role of SERVER_ROLES) server[role] = modelList(r[role], `roles.${role}`, issues);
  if (issues.length > 0) throw new ModelsConfigError(issues);
  return { version: 1, defaultCooldownMinutes: cooldown as number, worker, ...server };
}

export function serializeModelsConfig(config: ModelsConfig): string {
  return `${JSON.stringify(
    {
      version: 1,
      default_cooldown_minutes: config.defaultCooldownMinutes,
      roles: {
        worker: config.worker,
        planning: config.planning,
        improve: config.improve,
        review: config.review,
        verify: config.verify,
      },
    },
    null,
    2,
  )}\n`;
}

export function chainFor(config: ModelsConfig, role: ModelRole, agent: RuntimeProfile): string[] {
  return role === "worker" ? config.worker[agent] : config[role];
}

export function isModelAvailable(state: ModelsState, model: string, now: Date): boolean {
  const entry = state.models[model];
  if (!entry) return true;
  if (entry.manual) return false;
  return entry.unavailableUntil !== null && Date.parse(entry.unavailableUntil) <= now.getTime();
}

export type ModelSelection =
  | { ok: true; model: string; index: number; chain: string[] }
  /** All models are unavailable: the task waits (`task.waiting_model`) until `nextCheckAt` (null = manual). */
  | { ok: false; nextCheckAt: string | null; chain: string[] };

/** First available model of the role; `modelOverride` goes first (spec 3.8). */
export function selectModel(
  config: ModelsConfig,
  role: ModelRole,
  agent: RuntimeProfile,
  state: ModelsState,
  now: Date,
  modelOverride: string | null = null,
): ModelSelection {
  const base = chainFor(config, role, agent);
  const chain = modelOverride ? [modelOverride, ...base.filter((m) => m !== modelOverride)] : [...base];
  for (const [index, model] of chain.entries()) {
    if (isModelAvailable(state, model, now)) return { ok: true, model, index, chain };
  }
  const times = chain
    .map((m) => state.models[m])
    .filter((e): e is ModelAvailability => e !== undefined && !e.manual && e.unavailableUntil !== null)
    .map((e) => Date.parse(e.unavailableUntil ?? ""))
    .filter((ms) => Number.isFinite(ms));
  return { ok: false, nextCheckAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null, chain };
}

/** Mark a model unavailable after a limit (`rate_limit`) or end of subscription (`no_subscription`). */
export function markModelUnavailable(
  state: ModelsState,
  model: string,
  category: RuntimeErrorCategory,
  resetAt: string | null,
  now: Date,
  cooldownMinutes: number,
): ModelsState {
  const manual = category === "no_subscription";
  const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
  const until = manual
    ? null
    : new Date(Number.isFinite(resetMs) && resetMs > now.getTime() ? resetMs : now.getTime() + cooldownMinutes * 60_000).toISOString();
  return {
    version: 1,
    models: { ...state.models, [model]: { unavailableUntil: until, manual, category, since: now.toISOString() } },
  };
}

export function resetModel(state: ModelsState, model: string): ModelsState {
  const models = Object.fromEntries(Object.entries(state.models).filter(([key]) => key !== model));
  return { version: 1, models };
}

/** Drop entries whose time window has passed. */
export function pruneModelsState(state: ModelsState, now: Date): ModelsState {
  const models = Object.fromEntries(
    Object.entries(state.models).filter(([, e]) => e.manual || (e.unavailableUntil !== null && Date.parse(e.unavailableUntil) > now.getTime())),
  );
  return { version: 1, models };
}

export function parseModelsState(raw: unknown): ModelsState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_MODELS_STATE;
  const modelsRaw = (raw as Record<string, unknown>)["models"];
  if (modelsRaw === null || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) return EMPTY_MODELS_STATE;
  const models: Record<string, ModelAvailability> = {};
  for (const [key, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const until = v["unavailableUntil"];
    if ((typeof until === "string" || until === null) && typeof v["manual"] === "boolean" && typeof v["since"] === "string" && typeof v["category"] === "string") {
      models[key] = { unavailableUntil: until, manual: v["manual"], category: v["category"] as RuntimeErrorCategory, since: v["since"] };
    }
  }
  return { version: 1, models };
}

/** Pi / OpenCode `provider/model` → RPC `set_model` parts. */
export function splitModel(model: string): { provider: string; modelId: string } {
  const i = model.indexOf("/");
  return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
}
