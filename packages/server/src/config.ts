/** Server configuration from env (+ optional tokens file). Secrets never get logged. */
import { readFileSync } from "node:fs";
import type { TaskAssignee } from "@of/core";
import { DEFAULT_WATCHDOG_CONFIG } from "@of/core";
import type { WatchdogConfig } from "@of/core";

export type TokenScope = "api" | "mcp" | "worker";

export interface TokenEntry {
  name: string;
  token: string;
  /** participant = human (plugin), agent = MCP/worker. */
  kind: "participant" | "agent";
  id: string;
  scopes: TokenScope[];
}

export interface WorkerSshConfig {
  target: string;
  identityFile: string | null;
  extraOptions: string[];
}

export interface ServerConfig {
  vaultDir: string;
  projectsDir: string;
  frameworkDir: string;
  host: string;
  port: number;
  tzOffsetMinutes: number;
  tokens: TokenEntry[];
  participants: TaskAssignee[];
  coordinatorEnabled: boolean;
  pollIntervalMs: number;
  watchdog: WatchdogConfig;
  stageRunTimeoutMs: number;
  useSubagentsDefault: boolean;
  worker: WorkerSshConfig | null;
  workerProbeIntervalMs: number;
  clonesDir: string;
  piBin: string;
  gitBin: string;
  autoArchiveDays: number;
  /** Prompts per runtime (Р-021): `{skill}` is replaced by the stage skill. */
  prompts: { opencode: string; pi: string };
  lockTtlMs: number;
  mcpRateLimitPerMinute: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function int(env: Env, key: string, def: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${key} must be an integer >= ${String(min)}`);
  return value;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${key} must be a boolean`);
}

const SCOPES: readonly TokenScope[] = ["api", "mcp", "worker"];

export function parseTokens(raw: unknown): TokenEntry[] {
  if (!Array.isArray(raw)) throw new ConfigError("tokens must be a JSON array");
  return raw.map((item, i): TokenEntry => {
    if (item === null || typeof item !== "object") throw new ConfigError(`tokens[${String(i)}] must be an object`);
    const o = item as Record<string, unknown>;
    const { name, token, kind, id, scopes } = o;
    if (typeof name !== "string" || !name) throw new ConfigError(`tokens[${String(i)}].name is required`);
    if (typeof token !== "string" || token.length < 24) throw new ConfigError(`tokens[${String(i)}].token must be >= 24 chars`);
    if (kind !== "participant" && kind !== "agent") throw new ConfigError(`tokens[${String(i)}].kind must be participant|agent`);
    if (typeof id !== "string" || !id) throw new ConfigError(`tokens[${String(i)}].id is required`);
    if (!Array.isArray(scopes) || scopes.some((s) => !SCOPES.includes(s as TokenScope))) {
      throw new ConfigError(`tokens[${String(i)}].scopes must be a subset of ${SCOPES.join(",")}`);
    }
    return { name, token, kind, id, scopes: scopes as TokenScope[] };
  });
}

export function parseParticipants(raw: unknown): TaskAssignee[] {
  if (!Array.isArray(raw)) throw new ConfigError("participants must be a JSON array");
  return raw.map((item, i): TaskAssignee => {
    const o = (item ?? {}) as Record<string, unknown>;
    const { id, displayName, role, active } = o;
    if (typeof id !== "string" || !id || typeof displayName !== "string") {
      throw new ConfigError(`participants[${String(i)}] needs id and displayName`);
    }
    if (role !== "admin" && role !== "member") throw new ConfigError(`participants[${String(i)}].role must be admin|member`);
    return { participantId: id, displayName, role: role, active: active !== false };
  });
}

function jsonFrom(env: Env, inlineKey: string, fileKey: string, readFile: (p: string) => string): unknown {
  const file = env[fileKey];
  if (file) return JSON.parse(readFile(file)) as unknown;
  const inline = env[inlineKey];
  return inline ? (JSON.parse(inline) as unknown) : undefined;
}

export function loadConfig(env: Env, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): ServerConfig {
  const vaultDir = env["OF_VAULT_DIR"];
  if (!vaultDir) throw new ConfigError("OF_VAULT_DIR is required");
  const tokensRaw = jsonFrom(env, "OF_TOKENS", "OF_TOKENS_FILE", readFile);
  const participantsRaw = jsonFrom(env, "OF_PARTICIPANTS", "OF_PARTICIPANTS_FILE", readFile) ?? [
    { id: "owner", displayName: "Owner", role: "admin", active: true },
  ];
  const target = env["OF_WORKER_SSH_TARGET"];
  return {
    vaultDir,
    projectsDir: env["OF_PROJECTS_DIR"] ?? "Проекты",
    frameworkDir: env["OF_FRAMEWORK_DIR"] ?? "Проекты/Obsidian Framework",
    host: env["OF_HOST"] ?? "127.0.0.1",
    port: int(env, "OF_PORT", 8787, 0),
    tzOffsetMinutes: int(env, "OF_TZ_OFFSET_MINUTES", 180, -720),
    tokens: tokensRaw === undefined ? [] : parseTokens(tokensRaw),
    participants: parseParticipants(participantsRaw),
    coordinatorEnabled: bool(env, "OF_COORDINATOR_ENABLED", true),
    pollIntervalMs: int(env, "OF_POLL_INTERVAL_MS", 30_000, 1000),
    watchdog: {
      staleTimeoutMs: Math.max(60_000, int(env, "AGENT_STAGE_STALE_TIMEOUT_MS", DEFAULT_WATCHDOG_CONFIG.staleTimeoutMs, 1)),
      staleMaxRetry: int(env, "AGENT_STAGE_STALE_MAX_RETRY", DEFAULT_WATCHDOG_CONFIG.staleMaxRetry, 1),
      attemptRecoveryEnabled: bool(env, "AIF_AGENT_ATTEMPT_RECOVERY_ENABLED", true),
    },
    stageRunTimeoutMs: int(env, "AGENT_STAGE_RUN_TIMEOUT_MS", 60 * 60_000, 60_000),
    useSubagentsDefault: bool(env, "AGENT_USE_SUBAGENTS", false),
    worker: target
      ? {
          target,
          identityFile: env["OF_WORKER_SSH_KEY"] ?? null,
          extraOptions: (env["OF_WORKER_SSH_OPTIONS"] ?? "").split(/\s+/).filter(Boolean),
        }
      : null,
    workerProbeIntervalMs: int(env, "OF_WORKER_PROBE_INTERVAL_MS", 5 * 60_000, 10_000),
    clonesDir: env["OF_CLONES_DIR"] ?? "/data/clones",
    piBin: env["OF_PI_BIN"] ?? "pi",
    gitBin: env["OF_GIT_BIN"] ?? "git",
    autoArchiveDays: int(env, "OF_AUTOARCHIVE_DAYS", 7, 0),
    prompts: {
      opencode: env["OF_PROMPT_OPENCODE"] ?? "/{skill}",
      pi: env["OF_PROMPT_PI"] ?? "/skill:{skill}",
    },
    lockTtlMs: int(env, "OF_LOCK_TTL_MS", 30 * 60_000, 60_000),
    mcpRateLimitPerMinute: int(env, "OF_MCP_RATE_LIMIT_PER_MINUTE", 120, 1),
  };
}
