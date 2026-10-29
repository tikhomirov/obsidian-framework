import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { getStage } from "@of/core";
import type { ChildLike, Exec, ExecResult } from "../src/runners/process.js";
import { LineSplitter, makeExec } from "../src/runners/process.js";
import { PiRpcRunner } from "../src/runners/pi.js";
import { SshWorker, parseWorkerFinal } from "../src/runners/ssh.js";
import { runtimeError } from "../src/runners/errors.js";
import type { StageRunRequest } from "../src/runners/types.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  stdin = {
    write: (d: string) => {
      this.written.push(d);
      return true;
    },
    end: () => true,
  };
  kill(): boolean {
    this.killed = true;
    return true;
  }
  out(obj: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
  }
}

const NOW = new Date("2026-10-29T10:00:00Z");

function req(patch: Partial<StageRunRequest> = {}): StageRunRequest {
  return {
    project: { id: "of", title: "OF", status: "active", repo: "r", defaultBranch: "main", autoQueueMode: false, parallelEnabled: false, nextTaskNumber: 1, created: "x", updated: "x" },
    task: { project: "of", id: "TASK-001" } as StageRunRequest["task"],
    stage: getStage("planner"),
    agent: "pi",
    model: "omniroute/plan-a",
    prompt: "/skill:aif-plan fast",
    cwd: "/clone",
    env: { HANDOFF_MODE: "1" },
    timeoutMs: 10_000,
    onHeartbeat: () => undefined,
    ...patch,
  };
}

function piWith(script: (c: FakeChild) => void): { runner: PiRpcRunner; child: () => FakeChild; args: string[][] } {
  let child: FakeChild | null = null;
  const args: string[][] = [];
  const runner = new PiRpcRunner({
    piBin: "pi",
    now: () => NOW,
    spawn: (_cmd, a) => {
      args.push([...a]);
      const c = new FakeChild();
      child = c;
      setImmediate(() => {
        script(c);
      });
      return c;
    },
  });
  return { runner, child: () => child!, args };
}

describe("PiRpcRunner", () => {
  it("collects the last assistant text on agent_end", async () => {
    let beats = 0;
    const { runner, child, args } = piWith((c) => {
      c.out({ type: "response", id: "of-1", success: true });
      c.stdout.emit("data", Buffer.from('{"type":"message_update"}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"},{"type":"tool"}]}}\n'));
      c.out({ type: "message_end", message: { role: "assistant", content: "Final" } });
      c.out({ type: "message_end", message: { role: "user", content: "ignored" } });
      c.stdout.emit("data", Buffer.from("not json\n"));
      c.out({ type: "agent_end" });
    });
    const r = await runner.run(req({ onHeartbeat: () => (beats += 1) }));
    expect(r).toEqual({ kind: "ok", text: "Final", sha: null, branch: null, model: "omniroute/plan-a" });
    expect(args[0]).toEqual(["--mode", "rpc", "--no-session", "--model", "omniroute/plan-a"]);
    expect(JSON.parse(child().written[0] ?? "{}")).toEqual({ id: "of-1", type: "prompt", message: "/skill:aif-plan fast" });
    expect(child().killed).toBe(true);
    expect(beats).toBeGreaterThan(3);
  });

  it("assistant error → classified runtime error with reset", async () => {
    const { runner } = piWith((c) => {
      c.out({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit, try again in 2h" } });
      c.out({ type: "agent_end" });
    });
    const r = await runner.run(req());
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error).toMatchObject({ kind: "runtime", category: "rate_limit", resetAt: "2026-10-29T12:00:00.000Z" });
  });

  it("auto_retry_end failure, response failure, exit, spawn error, timeout", async () => {
    const a = piWith((c) => {
      c.out({ type: "auto_retry_end", success: false, finalError: "overloaded" });
      c.out({ type: "agent_end" });
    });
    expect((await a.runner.run(req())).kind).toBe("error");
    const b = piWith((c) => {
      c.out({ type: "response", success: false, error: "unknown model" });
    });
    const rb = await b.runner.run(req());
    expect(rb.kind === "error" && rb.error.kind === "runtime" ? rb.error.reason : "").toBe("unknown model");
    const b2 = piWith((c) => {
      c.out({ type: "response", success: false });
    });
    expect((await b2.runner.run(req())).kind).toBe("error");
    const c3 = piWith((c) => {
      c.stderr.emit("data", Buffer.from("boom"));
      c.emit("exit", 1, null);
    });
    const rc = await c3.runner.run(req());
    expect(rc.kind === "error" && rc.error.kind === "runtime" ? rc.error.reason : "").toBe("boom");
    const c4 = piWith((c) => {
      c.emit("exit", 2, null);
    });
    const rc4 = await c4.runner.run(req());
    expect(rc4.kind === "error" && rc4.error.kind === "runtime" ? rc4.error.reason : "").toMatch(/code 2/);
    const d = piWith((c) => {
      c.emit("error", new Error("ENOENT"));
    });
    const rd = await d.runner.run(req());
    expect(rd.kind === "error" && rd.error.kind === "runtime" ? rd.error.category : "").toBe("transport");
    const e = piWith(() => undefined);
    const re = await e.runner.run(req({ timeoutMs: 5 }));
    expect(re.kind === "error" && re.error.kind === "runtime" ? re.error.category : "").toBe("timeout");
  });
});

describe("process helpers", () => {
  it("LineSplitter splits on LF only, keeps partial lines", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('{"a":1}\r\n{"b"');
    s.push(':"x\u2028y"}\n\n');
    s.push("tail");
    s.flush();
    s.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":"x\u2028y"}', "tail"]);
  });

  it("makeExec collects output, input, timeout, spawn errors", async () => {
    const exec = makeExec(() => {
      const c = new FakeChild();
      setImmediate(() => {
        c.stdout.emit("data", "out");
        c.stderr.emit("data", Buffer.from("err"));
        c.emit("exit", 0, null);
      });
      return c;
    });
    let chunks = "";
    expect(await exec("x", [], { input: "in", onStdout: (s) => (chunks += s) })).toEqual({ code: 0, stdout: "out", stderr: "err", timedOut: false });
    expect(chunks).toBe("out");
    const hang = makeExec(() => {
      const c = new FakeChild();
      c.kill = () => {
        setImmediate(() => c.emit("exit", null, "SIGTERM"));
        return true;
      };
      return c;
    });
    expect((await hang("x", [], { timeoutMs: 5 })).timedOut).toBe(true);
    const throwing = makeExec(() => {
      throw new Error("nope");
    });
    expect(await throwing("x", [])).toMatchObject({ code: null, stderr: "nope" });
    const erroring = makeExec(() => {
      const c = new FakeChild();
      setImmediate(() => {
        c.emit("error", new Error("ENOENT"));
        c.emit("exit", 1, null);
      });
      return c;
    });
    expect(await erroring("x", [])).toMatchObject({ code: null, stderr: "ENOENT" });
  });

  it("runtimeError", () => {
    expect(runtimeError("insufficient_quota", NOW)).toMatchObject({ kind: "runtime" });
    expect(runtimeError("x", NOW, "timeout")).toMatchObject({ category: "timeout", resetAt: null });
  });
});

function fakeExec(results: Partial<ExecResult>[], calls: string[][]): Exec {
  return (_cmd, args, opts) => {
    calls.push([...args]);
    const r = results.shift() ?? {};
    if (r.stdout) opts?.onStdout?.(r.stdout);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });
  };
}

describe("SshWorker", () => {
  const cfg = { target: "user@100.64.0.2", identityFile: "/keys/id", extraOptions: ["-p", "22"] };

  it("builds restricted ssh args and probes status", async () => {
    const calls: string[][] = [];
    const w = new SshWorker(cfg, fakeExec([{ stdout: '{"ok":true,"busy":true,"version":"0.1.0"}\n' }, { code: 255, stderr: "no route" }, { timedOut: true, code: null }, { stdout: "garbage" }, { stdout: "{}" }], calls));
    expect(await w.probe()).toEqual({ online: true, busy: true, detail: "0.1.0" });
    expect(calls[0]).toEqual(expect.arrayContaining(["BatchMode=yes", "-i", "/keys/id", "user@100.64.0.2", "status"]));
    expect(await w.probe()).toMatchObject({ online: false, detail: "ssh exit 255" });
    expect(await w.probe()).toMatchObject({ online: false, detail: "timeout" });
    expect(await w.probe()).toMatchObject({ online: true, detail: "unparsable status" });
    expect(await w.probe()).toMatchObject({ online: true, busy: false, detail: "ok" });
    const plain = new SshWorker({ target: "h", identityFile: null, extraOptions: [] }, fakeExec([], []));
    expect(plain.sshArgs(["status"])).not.toContain("-i");
  });

  it("maps worker final lines", async () => {
    const lines = [
      { stdout: '{"type":"heartbeat"}\n{"result":"ok","model":"a/b","sha":"abc1234","branch":"of/x","message":"done"}\n' },
      { stdout: '{"result":"limit","resetAt":"2026-10-29T12:00:00Z"}\n', code: 1 },
      { stdout: '{"result":"no_subscription"}\n', code: 1 },
      { stdout: '{"result":"error","message":"insufficient_quota"}\n', code: 1 },
      { stdout: '{"result":"busy"}\n', code: 1 },
      { stdout: "", code: 255, stderr: "Connection refused" },
      { stdout: "", code: null, stderr: "" },
      { stdout: "", code: 3, stderr: "" },
      { stdout: "", code: null, timedOut: true },
      { stdout: '{"result":"ok"}\n' },
      { stdout: '{"result":"limit"}\n{"result":"error"}\n' },
    ];
    const w = new SshWorker(cfg, fakeExec(lines, []), () => NOW);
    let beats = 0;
    const r0 = await w.run(req({ agent: "opencode", model: "a/b", onHeartbeat: () => (beats += 1) }));
    expect(r0).toEqual({ kind: "ok", text: "done", sha: "abc1234", branch: "of/x", model: "a/b" });
    expect(beats).toBe(1);
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { category: "rate_limit", resetAt: "2026-10-29T12:00:00Z" } });
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { category: "no_subscription" } });
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { kind: "runtime" } });
    expect(await w.run(req())).toEqual({ kind: "unavailable", reason: "worker busy" });
    expect(await w.run(req())).toEqual({ kind: "unavailable", reason: "Connection refused" });
    expect(await w.run(req())).toEqual({ kind: "unavailable", reason: "ssh failed" });
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { kind: "other", reason: "worker exit 3" } });
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { category: "timeout" } });
    expect(await w.run(req())).toMatchObject({ kind: "ok", sha: null, model: "omniroute/plan-a" });
    expect(await w.run(req())).toMatchObject({ kind: "error", error: { kind: "runtime" } });
  });

  it("parseWorkerFinal ignores junk", () => {
    expect(parseWorkerFinal("x\n{bad\n{\"result\":\"nope\"}\n")).toBeNull();
    expect(parseWorkerFinal('{"result":"limit"}')).toEqual({ result: "limit" });
  });
});
