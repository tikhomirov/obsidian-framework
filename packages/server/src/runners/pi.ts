/**
 * Pi RPC runner for server stages (Р-019/Р-021): one `pi --mode rpc --no-session`
 * process per stage, model picked from models.json, skill as `/skill:<name>`.
 */
import type { Spawn } from "./process.js";
import { LineSplitter } from "./process.js";
import { runtimeError } from "./errors.js";
import type { StageRunRequest, StageRunResult, StageRunner } from "./types.js";

interface PiMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

function textOf(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: unknown) => {
      if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const t = (part as { text?: unknown }).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .join("");
}

export interface PiRunnerOptions {
  spawn: Spawn;
  piBin: string;
  extraArgs?: string[];
  now?: () => Date;
}

export class PiRpcRunner implements StageRunner {
  private readonly opts: PiRunnerOptions;

  constructor(opts: PiRunnerOptions) {
    this.opts = opts;
  }

  run(req: StageRunRequest): Promise<StageRunResult> {
    const now = this.opts.now ?? (() => new Date());
    const model = req.model;
    return new Promise((resolve) => {
      let settled = false;
      let lastText = "";
      let lastError: string | null = null;
      let stderr = "";
      const child = this.opts.spawn(
        this.opts.piBin,
        ["--mode", "rpc", "--no-session", "--model", model, ...(this.opts.extraArgs ?? [])],
        { cwd: req.cwd, env: req.env },
      );
      const done = (result: StageRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.stdin?.end();
        } catch {
          /* ignore */
        }
        child.kill("SIGTERM");
        resolve(result);
      };
      const timer = setTimeout(() => {
        done({ kind: "error", model, error: runtimeError(`Pi stage timed out after ${String(req.timeoutMs)} ms`, now(), "timeout") });
      }, req.timeoutMs);

      const splitter = new LineSplitter((line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        req.onHeartbeat();
        const type = msg["type"];
        if (type === "response" && msg["success"] === false) {
          const err = msg["error"];
          done({ kind: "error", model, error: runtimeError(typeof err === "string" ? err : "Pi RPC command failed", now()) });
          return;
        }
        if (type === "message_end") {
          const m = (msg["message"] ?? {}) as PiMessage;
          if (m.role === "assistant") {
            if (m.stopReason === "error") lastError = m.errorMessage ?? "Pi assistant error";
            else {
              const t = textOf(m);
              if (t.trim()) lastText = t;
            }
          }
          return;
        }
        if (type === "auto_retry_end" && msg["success"] === false) {
          const fe = msg["finalError"];
          lastError = typeof fe === "string" ? fe : "Pi auto-retry failed";
          return;
        }
        if (type === "agent_end") {
          if (lastError !== null) done({ kind: "error", model, error: runtimeError(lastError, now()) });
          else done({ kind: "ok", text: lastText, sha: null, branch: null, model });
        }
      });
      child.stdout?.on("data", (c) => {
        splitter.push(c.toString());
      });
      child.stderr?.on("data", (c) => {
        stderr = (stderr + c.toString()).slice(-4000);
      });
      child.on("error", (err) => {
        done({ kind: "error", model, error: runtimeError(`Pi failed to start: ${err.message}`, now(), "transport") });
      });
      child.on("exit", (code) => {
        splitter.flush();
        const message = lastError ?? (stderr.trim() || `Pi exited with code ${String(code)}`);
        done({ kind: "error", model, error: runtimeError(message, now()) });
      });
      child.stdin?.write(`${JSON.stringify({ id: "of-1", type: "prompt", message: req.prompt })}\n`);
    });
  }
}
