/**
 * of-worker (Р-019/Р-020): runs one PC stage for the coordinator.
 * Invoked by sshd forced command (`command="of-worker",restrict`), the request is
 * in SSH_ORIGINAL_COMMAND: `run <project>/TASK-NNN` or `status`.
 * Prints progress lines and ONE final JSON line:
 * `{"result":"ok"|"limit"|"no_subscription"|"error"|"busy", model, sha, branch, resetAt, message}`.
 */
import { classifyByMessageFallback, extractResetAt, isTaskId, parseTaskRef } from "@of/core";

export const WORKER_VERSION = "0.1.0";

export interface WorkerConfig {
  serverUrl: string;
  token: string;
  /** project id → local git repo on the PC. */
  projects: Record<string, string>;
  worktreesDir: string;
  opencodeBin: string;
  piBin: string;
  timeoutMinutes: number;
  remote: string;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
}

export interface RunInfo {
  project: string;
  taskId: string;
  title: string;
  stage: string;
  agent: "opencode" | "pi";
  model: string;
  prompt: string;
  planPath: string | null;
  plan: string;
  branch: string | null;
  defaultBranch: string;
  env: Record<string, string>;
}

export interface FinalLine {
  result: "ok" | "limit" | "no_subscription" | "error" | "busy";
  model: string | null;
  sha: string | null;
  branch: string | null;
  resetAt: string | null;
  message: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WorkerIO {
  exec(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onOutput?: (chunk: string) => void }): Promise<ExecResult>;
  fetchJson(url: string, init: { method: string; token: string; body?: unknown }): Promise<{ status: number; json: unknown }>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  /** Exclusive lock; returns a release fn or null when another run holds it. */
  lock(): Promise<(() => Promise<void>) | null>;
  isLocked(): Promise<boolean>;
  print(line: string): void;
  now(): Date;
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

export function parseWorkerConfig(raw: unknown, home: string): WorkerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new WorkerConfigError("worker.json must be an object");
  const o = raw as Record<string, unknown>;
  const str = (k: string, def?: string): string => {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (def !== undefined) return def;
    throw new WorkerConfigError(`worker.json: "${k}" is required`);
  };
  const projectsRaw = o["projects"];
  if (projectsRaw === null || typeof projectsRaw !== "object" || Array.isArray(projectsRaw)) {
    throw new WorkerConfigError('worker.json: "projects" must map project id → repo path');
  }
  const projects: Record<string, string> = {};
  for (const [k, v] of Object.entries(projectsRaw as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.startsWith("/")) throw new WorkerConfigError(`worker.json: projects.${k} must be an absolute path`);
    projects[k] = v;
  }
  const timeout = o["timeoutMinutes"];
  const serverUrl = str("serverUrl").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(serverUrl)) throw new WorkerConfigError("worker.json: serverUrl must be http(s)://…");
  return {
    serverUrl,
    token: str("token"),
    projects,
    worktreesDir: str("worktreesDir", `${home}/.cache/obsidian-framework/worktrees`),
    opencodeBin: str("opencodeBin", "opencode"),
    piBin: str("piBin", "pi"),
    timeoutMinutes: typeof timeout === "number" && timeout > 0 ? timeout : 120,
    remote: str("remote", "origin"),
    gitAuthorName: typeof o["gitAuthorName"] === "string" ? o["gitAuthorName"] : null,
    gitAuthorEmail: typeof o["gitAuthorEmail"] === "string" ? o["gitAuthorEmail"] : null,
  };
}

export function parseCommand(original: string | undefined, argv: string[]): { kind: "status" } | { kind: "run"; project: string | null; id: string } | { kind: "invalid"; message: string } {
  const words = (original?.trim() ? original.trim().split(/\s+/) : argv).filter(Boolean);
  const [cmd, arg, ...rest] = words;
  if (cmd === "status" && arg === undefined) return { kind: "status" };
  if (cmd === "run" && arg !== undefined && rest.length === 0) {
    const ref = parseTaskRef(arg);
    if (ref) return { kind: "run", project: ref.project, id: ref.id };
    if (isTaskId(arg)) return { kind: "run", project: null, id: arg };
    return { kind: "invalid", message: `invalid task reference '${arg}'` };
  }
  return { kind: "invalid", message: "usage: of-worker status | of-worker run <project>/TASK-NNN" };
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+(#[A-Za-z0-9._-]+)?$/;

export function parseRunInfo(raw: unknown): RunInfo {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string") throw new Error(`run info: ${k} missing`);
    return v;
  };
  const agent = s("agent");
  if (agent !== "opencode" && agent !== "pi") throw new Error("run info: unknown agent");
  const model = s("model");
  if (!MODEL_RE.test(model)) throw new Error("run info: invalid model");
  const branch = o["branch"];
  if (branch !== null && (typeof branch !== "string" || !SAFE_BRANCH.test(branch) || branch.includes(".."))) throw new Error("run info: invalid branch");
  const defaultBranch = s("defaultBranch");
  if (!SAFE_BRANCH.test(defaultBranch)) throw new Error("run info: invalid default branch");
  const planPath = o["planPath"];
  if (planPath !== null && (typeof planPath !== "string" || planPath.includes("..") || planPath.startsWith("/"))) throw new Error("run info: invalid planPath");
  const envRaw = (o["env"] ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) if (/^HANDOFF_[A-Z_]+$/.test(k) && typeof v === "string") env[k] = v;
  return {
    project: s("project"),
    taskId: s("taskId"),
    title: s("title"),
    stage: s("stage"),
    agent,
    model,
    prompt: s("prompt"),
    planPath,
    plan: typeof o["plan"] === "string" ? o["plan"] : "",
    branch,
    defaultBranch,
    env,
  };
}

function final(io: WorkerIO, line: FinalLine): FinalLine {
  io.print(JSON.stringify(line));
  return line;
}

/** Map agent output to a final result (limits only switch the model, Р-025). */
export function classifyAgentFailure(output: string, now: Date): { result: "limit" | "no_subscription" | "error"; resetAt: string | null } {
  const category = classifyByMessageFallback(output);
  if (category === "rate_limit") return { result: "limit", resetAt: extractResetAt(output, now) };
  if (category === "no_subscription") return { result: "no_subscription", resetAt: null };
  return { result: "error", resetAt: null };
}

/** OpenCode `--format json` / Pi output → assistant-visible error text if any. */
export function findAgentError(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o["type"] === "error") {
        const e = o["error"];
        if (typeof e === "string") return e;
        if (e && typeof e === "object") {
          const msg = (e as Record<string, unknown>)["message"] ?? (e as Record<string, unknown>)["data"];
          return typeof msg === "string" ? msg : JSON.stringify(e);
        }
        return "agent error";
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function agentCommand(cfg: WorkerConfig, info: RunInfo): { cmd: string; args: string[] } {
  if (info.agent === "opencode") return { cmd: cfg.opencodeBin, args: ["run", "-m", info.model, "--format", "json", info.prompt] };
  return { cmd: cfg.piBin, args: ["-p", "--no-session", "--model", info.model, info.prompt] };
}

export async function runStatus(io: WorkerIO): Promise<void> {
  io.print(JSON.stringify({ ok: true, busy: await io.isLocked(), version: WORKER_VERSION }));
}

/** `run TASK-012` without a project is allowed when the worker serves exactly one project (spec 3.7). */
export function resolveProject(cfg: WorkerConfig, project: string | null): string | null {
  if (project !== null) return project;
  const ids = Object.keys(cfg.projects);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

export async function runTask(cfg: WorkerConfig, io: WorkerIO, projectRef: string | null, id: string): Promise<FinalLine> {
  const project = resolveProject(cfg, projectRef);
  if (project === null) return final(io, { result: "error", model: null, sha: null, branch: null, resetAt: null, message: "task reference needs a project (<project>/TASK-NNN)" });
  const release = await io.lock();
  if (!release) return final(io, { result: "busy", model: null, sha: null, branch: null, resetAt: null, message: "another run is active" });
  let model: string | null = null;
  let branch: string | null = null;
  try {
    const repo = cfg.projects[project];
    if (!repo) return final(io, { result: "error", model, sha: null, branch, resetAt: null, message: `project ${project} is not configured in worker.json` });
    const r = await io.fetchJson(`${cfg.serverUrl}/tasks/${project}/${id}/run`, { method: "GET", token: cfg.token });
    if (r.status !== 200) return final(io, { result: "error", model, sha: null, branch, resetAt: null, message: `server answered ${String(r.status)} for run info` });
    const info = parseRunInfo(r.json);
    model = info.model;
    branch = info.branch ?? `of/${id.toLowerCase()}`;
    const git = async (args: string[], cwd: string): Promise<ExecResult> => io.exec("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 600_000 });
    const must = async (args: string[], cwd: string): Promise<string> => {
      const res = await git(args, cwd);
      if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.trim().slice(0, 300)}`);
      return res.stdout.trim();
    };

    // 1. Dedicated worktree: never touch the user's own checkout.
    await must(["fetch", "--prune", cfg.remote], repo);
    const wt = `${cfg.worktreesDir}/${project}/${id}`;
    if (!(await io.exists(wt))) {
      await io.mkdirp(`${cfg.worktreesDir}/${project}`);
      const remoteBranch = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${cfg.remote}/${branch}`], repo);
      const base = remoteBranch.code === 0 ? `${cfg.remote}/${branch}` : `${cfg.remote}/${info.defaultBranch}`;
      await must(["worktree", "add", "-B", branch, wt, base], repo);
    } else {
      await git(["merge", "--ff-only", `${cfg.remote}/${branch}`], wt);
    }
    const startSha = await must(["rev-parse", "HEAD"], wt);
    if (info.plan.trim() && info.planPath) await io.writeFile(`${wt}/${info.planPath}`, `${info.plan.trim()}\n`);

    // 2. Agent run with heartbeats.
    const { cmd, args } = agentCommand(cfg, info);
    io.print(JSON.stringify({ type: "started", agent: info.agent, model, branch }));
    const beat = setInterval(() => {
      io.print(JSON.stringify({ type: "heartbeat", at: io.now().toISOString() }));
      void io.fetchJson(`${cfg.serverUrl}/tasks/${project}/${id}/heartbeat`, { method: "POST", token: cfg.token, body: {} }).catch(() => undefined);
    }, 60_000);
    let res: ExecResult;
    try {
      res = await io.exec(cmd, args, { cwd: wt, env: { ...info.env, HANDOFF_BRANCH_NAME: branch, HANDOFF_BRANCH_PREPARED: "1" }, timeoutMs: cfg.timeoutMinutes * 60_000 });
    } finally {
      clearInterval(beat);
    }
    const agentError = findAgentError(res.stdout);
    if (res.timedOut) return final(io, { result: "error", model, sha: null, branch, resetAt: null, message: "agent timed out" });
    if (res.code !== 0 || agentError !== null) {
      const text = [agentError ?? "", res.stderr, res.stdout.slice(-4000)].join("\n");
      const c = classifyAgentFailure(text, io.now());
      return final(io, { result: c.result, model, sha: null, branch, resetAt: c.resetAt, message: (agentError ?? res.stderr.trim()).slice(0, 1000) || `agent exit ${String(res.code)}` });
    }

    // 3. Commit leftovers and push the branch (Р-020).
    const dirty = await must(["status", "--porcelain"], wt);
    if (dirty) {
      await must(["add", "-A"], wt);
      const ident: string[] = [];
      if (cfg.gitAuthorName) ident.push("-c", `user.name=${cfg.gitAuthorName}`);
      if (cfg.gitAuthorEmail) ident.push("-c", `user.email=${cfg.gitAuthorEmail}`);
      await must([...ident, "commit", "-m", `of: ${project}/${id} ${info.title}`.slice(0, 200)], wt);
    }
    const sha = await must(["rev-parse", "HEAD"], wt);
    const remoteHas = await git(["branch", "-r", "--contains", sha], wt);
    const alreadyPushed = remoteHas.code === 0 && remoteHas.stdout.split("\n").some((l) => l.trim() === `${cfg.remote}/${branch ?? ""}`);
    if (sha === startSha && !alreadyPushed) {
      return final(io, { result: "error", model, sha: null, branch, resetAt: null, message: "agent produced no commit" });
    }
    if (!alreadyPushed) await must(["push", cfg.remote, `HEAD:refs/heads/${branch}`], wt);
    return final(io, { result: "ok", model, sha, branch, resetAt: null, message: res.stdout.slice(-2000) });
  } catch (err) {
    return final(io, { result: "error", model, sha: null, branch, resetAt: null, message: err instanceof Error ? err.message : String(err) });
  } finally {
    await release();
  }
}
