import { describe, expect, it } from "vitest";
import type { ExecResult, WorkerConfig, WorkerIO } from "../src/worker.js";
import { WorkerConfigError, agentCommand, classifyAgentFailure, findAgentError, parseCommand, parseRunInfo, parseWorkerConfig, runStatus, runTask } from "../src/worker.js";

const NOW = new Date("2026-10-29T10:00:00Z");

const cfg: WorkerConfig = parseWorkerConfig(
  { serverUrl: "http://100.64.0.1:8787/", token: "t", projects: { of: "/home/user/Projects/of" }, gitAuthorName: "Owner", gitAuthorEmail: "a@x" },
  "/home/user",
);

const RUN = {
  project: "of",
  taskId: "TASK-001",
  title: "Board",
  stage: "implementer",
  agent: "opencode",
  model: "anthropic/claude-sonnet-4-5",
  prompt: "/aif-implement",
  planPath: ".ai-factory/PLAN.md",
  plan: "# plan",
  branch: "of/task-001-board",
  defaultBranch: "main",
  env: { HANDOFF_MODE: "1", HANDOFF_TASK_ID: "of/TASK-001", EVIL: "x" },
};

type Script = (cmd: string, args: string[]) => Partial<ExecResult> | undefined;

function makeIO(script: Script, opts: { runStatus?: number; run?: unknown; locked?: boolean; exists?: boolean } = {}): WorkerIO & { out: string[]; calls: string[]; files: Map<string, string>; released: number } {
  const out: string[] = [];
  const calls: string[] = [];
  const files = new Map<string, string>();
  const state = { released: 0 };
  const io = {
    out,
    calls,
    files,
    get released() {
      return state.released;
    },
    exec: (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...script(cmd, args) });
    },
    fetchJson: (url: string) => {
      calls.push(`fetch ${url}`);
      return Promise.resolve({ status: opts.runStatus ?? 200, json: opts.run ?? RUN });
    },
    readFile: () => Promise.resolve(null),
    writeFile: (p: string, t: string) => {
      files.set(p, t);
      return Promise.resolve();
    },
    exists: () => Promise.resolve(opts.exists ?? false),
    mkdirp: () => Promise.resolve(),
    lock: () =>
      Promise.resolve(
        opts.locked
          ? null
          : () => {
              state.released++;
              return Promise.resolve();
            },
      ),
    isLocked: () => Promise.resolve(opts.locked ?? false),
    print: (l: string) => out.push(l),
    now: () => NOW,
  };
  return io;
}

const last = (io: { out: string[] }): Record<string, unknown> => JSON.parse(io.out.at(-1) ?? "{}") as Record<string, unknown>;

function happy(overrides: Record<string, Partial<ExecResult>> = {}): Script {
  let head = 0;
  return (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ""}`;
    if (overrides[key]) return overrides[key];
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--verify") return { code: 1 };
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: head++ === 0 ? "aaaaaaa\n" : "bbbbbbb\n" };
    if (cmd === "git" && args[0] === "status") return { stdout: " M file.ts\n" };
    if (cmd === "git" && args[0] === "branch") return { stdout: "" };
    return {};
  };
}

describe("worker config & command", () => {
  it("parses config with defaults and validation", () => {
    expect(cfg).toMatchObject({ serverUrl: "http://100.64.0.1:8787", worktreesDir: "/home/user/.cache/obsidian-framework/worktrees", opencodeBin: "opencode", timeoutMinutes: 120, remote: "origin" });
    expect(() => parseWorkerConfig(null, "/h")).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ serverUrl: "x", token: "t", projects: {} }, "/h")).toThrow(/serverUrl/);
    expect(() => parseWorkerConfig({ serverUrl: "http://x", projects: {} }, "/h")).toThrow(/token/);
    expect(() => parseWorkerConfig({ serverUrl: "http://x", token: "t" }, "/h")).toThrow(/projects/);
    expect(() => parseWorkerConfig({ serverUrl: "http://x", token: "t", projects: { of: "rel" } }, "/h")).toThrow(/absolute/);
    expect(parseWorkerConfig({ serverUrl: "http://x", token: "t", projects: {}, timeoutMinutes: 5 }, "/h").timeoutMinutes).toBe(5);
  });

  it("parses SSH_ORIGINAL_COMMAND strictly", () => {
    expect(parseCommand("status", [])).toEqual({ kind: "status" });
    expect(parseCommand(undefined, ["run", "of/TASK-012"])).toEqual({ kind: "run", project: "of", id: "TASK-012" });
    expect(parseCommand("run of:TASK-012", [])).toEqual({ kind: "run", project: "of", id: "TASK-012" });
    expect(parseCommand("run of/TASK-1; rm -rf /", []).kind).toBe("invalid");
    expect(parseCommand("run ../x", []).kind).toBe("invalid");
    expect(parseCommand("run TASK-012", [])).toEqual({ kind: "run", project: null, id: "TASK-012" });
    expect(parseCommand("bash", []).kind).toBe("invalid");
    expect(parseCommand("  ", ["status", "x"]).kind).toBe("invalid");
  });

  it("parses run info defensively", () => {
    const info = parseRunInfo(RUN);
    expect(info.env).toEqual({ HANDOFF_MODE: "1", HANDOFF_TASK_ID: "of/TASK-001" });
    expect(parseRunInfo({ ...RUN, branch: null, plan: 5 })).toMatchObject({ branch: null, plan: "" });
    expect(() => parseRunInfo({ ...RUN, agent: "bash" })).toThrow(/agent/);
    expect(() => parseRunInfo({ ...RUN, model: "x" })).toThrow(/model/);
    expect(() => parseRunInfo({ ...RUN, branch: "a..b" })).toThrow(/branch/);
    expect(() => parseRunInfo({ ...RUN, branch: 5 })).toThrow(/branch/);
    expect(() => parseRunInfo({ ...RUN, defaultBranch: "a b" })).toThrow(/default/);
    expect(() => parseRunInfo({ ...RUN, planPath: "/etc/passwd" })).toThrow(/planPath/);
    expect(() => parseRunInfo({ ...RUN, title: undefined })).toThrow(/title/);
    expect(() => parseRunInfo(null)).toThrow();
    expect(parseRunInfo({ ...RUN, planPath: null, env: undefined }).planPath).toBeNull();
  });

  it("agent commands and failure classification", () => {
    expect(agentCommand(cfg, parseRunInfo(RUN))).toEqual({ cmd: "opencode", args: ["run", "-m", "anthropic/claude-sonnet-4-5", "--format", "json", "/aif-implement"] });
    expect(agentCommand(cfg, parseRunInfo({ ...RUN, agent: "pi", model: "omniroute/q" })).args).toEqual(["-p", "--no-session", "--model", "omniroute/q", "/aif-implement"]);
    expect(classifyAgentFailure("429 Too Many Requests, try again in 1h", NOW)).toEqual({ result: "limit", resetAt: "2026-10-29T11:00:00.000Z" });
    expect(classifyAgentFailure("Payment required: subscription expired", NOW).result).toMatch(/no_subscription|error/);
    expect(classifyAgentFailure("segfault", NOW)).toEqual({ result: "error", resetAt: null });
    expect(findAgentError('{"type":"text"}\n{"type":"error","error":{"message":"rate limit"}}')).toBe("rate limit");
    expect(findAgentError('{"type":"error","error":"boom"}')).toBe("boom");
    expect(findAgentError('{"type":"error","error":{"code":1}}')).toBe('{"code":1}');
    expect(findAgentError('{"type":"error"}')).toBe("agent error");
    expect(findAgentError("plain\n{bad")).toBeNull();
  });
});

describe("runTask", () => {
  it("status prints busy flag", async () => {
    const io = makeIO(() => undefined, { locked: true });
    await runStatus(io);
    expect(last(io)).toMatchObject({ ok: true, busy: true });
  });

  it("happy path: worktree, plan file, agent, commit, push", async () => {
    const io = makeIO(happy());
    const r = await runTask(cfg, io, "of", "TASK-001");
    expect(r).toMatchObject({ result: "ok", sha: "bbbbbbb", branch: "of/task-001-board", model: "anthropic/claude-sonnet-4-5" });
    expect(io.calls).toEqual(
      expect.arrayContaining([
        "fetch http://100.64.0.1:8787/tasks/of/TASK-001/run",
        "git fetch --prune origin",
        "git worktree add -B of/task-001-board /home/user/.cache/obsidian-framework/worktrees/of/TASK-001 origin/main",
        "opencode run -m anthropic/claude-sonnet-4-5 --format json /aif-implement",
        "git add -A",
        "git -c user.name=Owner -c user.email=a@x commit -m of: of/TASK-001 Board",
        "git push origin HEAD:refs/heads/of/task-001-board",
      ]),
    );
    expect(io.files.get("/home/user/.cache/obsidian-framework/worktrees/of/TASK-001/.ai-factory/PLAN.md")).toBe("# plan\n");
    expect(last(io)).toMatchObject({ result: "ok" });
    expect(io.released).toBe(1);
  });

  it("existing worktree + remote branch already contains HEAD → no push", async () => {
    const io = makeIO(
      (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse") return { stdout: "ccccccc\n" };
        if (cmd === "git" && args[0] === "status") return { stdout: "" };
        if (cmd === "git" && args[0] === "branch") return { stdout: "  origin/of/task-001-board\n" };
        return {};
      },
      { exists: true },
    );
    const r = await runTask(cfg, io, "of", "TASK-001");
    expect(r).toMatchObject({ result: "ok", sha: "ccccccc" });
    expect(io.calls.some((c) => c.startsWith("git push"))).toBe(false);
    expect(io.calls).toContain("git merge --ff-only origin/of/task-001-board");
  });

  it("no changes → error", async () => {
    const io = makeIO((cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--verify") return { code: 0 };
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "aaaaaaa\n" };
      if (cmd === "git" && args[0] === "branch") return { code: 1 };
      return {};
    });
    expect(await runTask(cfg, io, "of", "TASK-001")).toMatchObject({ result: "error", message: "agent produced no commit" });
    expect(io.calls).toContain("git worktree add -B of/task-001-board /home/user/.cache/obsidian-framework/worktrees/of/TASK-001 origin/of/task-001-board");
  });

  it("agent limit / error / timeout", async () => {
    const lim = makeIO(happy({ "opencode run": { code: 1, stderr: "rate_limit_exceeded, retry in 30m" } }));
    expect(await runTask(cfg, lim, "of", "TASK-001")).toMatchObject({ result: "limit", resetAt: "2026-10-29T10:30:00.000Z" });
    const jsonErr = makeIO(happy({ "opencode run": { code: 0, stdout: '{"type":"error","error":{"message":"boom"}}\n' } }));
    expect(await runTask(cfg, jsonErr, "of", "TASK-001")).toMatchObject({ result: "error", message: "boom" });
    const silent = makeIO(happy({ "opencode run": { code: 7 } }));
    expect(await runTask(cfg, silent, "of", "TASK-001")).toMatchObject({ result: "error", message: "agent exit 7" });
    const slow = makeIO(happy({ "opencode run": { code: null, timedOut: true } }));
    expect(await runTask(cfg, slow, "of", "TASK-001")).toMatchObject({ result: "error", message: "agent timed out" });
  });

  it("busy, unknown project, server refusal, git failure, null branch", async () => {
    expect(await runTask(cfg, makeIO(happy(), { locked: true }), "of", "TASK-001")).toMatchObject({ result: "busy" });
    expect(await runTask(cfg, makeIO(happy()), "zz", "TASK-001")).toMatchObject({ result: "error", message: expect.stringContaining("not configured") as unknown });
    expect(await runTask(cfg, makeIO(happy(), { runStatus: 409 }), "of", "TASK-001")).toMatchObject({ result: "error", message: "server answered 409 for run info" });
    const gitFail = makeIO(happy({ "git fetch": { code: 128, stderr: "no network" } }));
    expect(await runTask(cfg, gitFail, "of", "TASK-001")).toMatchObject({ result: "error", message: expect.stringContaining("no network") as unknown });
    const noBranch = makeIO(happy(), { run: { ...RUN, branch: null, plan: "" } });
    expect(await runTask(cfg, noBranch, "of", "TASK-001")).toMatchObject({ result: "ok", branch: "of/task-001" });
    const bad = makeIO(happy(), { run: { ...RUN, agent: "x" } });
    expect(await runTask(cfg, bad, "of", "TASK-001")).toMatchObject({ result: "error" });
  });

  it("bare TASK id resolves to the only configured project", async () => {
    const io = makeIO(happy());
    expect(await runTask(cfg, io, null, "TASK-001")).toMatchObject({ result: "ok" });
    const two = parseWorkerConfig({ serverUrl: "http://x", token: "t", projects: { of: "/a", ab: "/b" } }, "/h");
    expect(await runTask(two, makeIO(happy()), null, "TASK-001")).toMatchObject({ result: "error", message: expect.stringContaining("needs a project") as unknown });
  });

  it("no author identity configured → plain commit", async () => {
    const plain = parseWorkerConfig({ serverUrl: "http://x", token: "t", projects: { of: "/r" } }, "/h");
    const io = makeIO(happy());
    await runTask(plain, io, "of", "TASK-001");
    expect(io.calls).toContain("git commit -m of: of/TASK-001 Board");
  });
});
