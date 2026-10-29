/** Child process helpers (injectable for tests). */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  input?: string | undefined;
  /** Called for every stdout chunk (heartbeats / streaming). */
  onStdout?: ((chunk: string) => void) | undefined;
}

export type Exec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface ChildLike {
  stdin: { write(data: string): unknown; end(): unknown } | null;
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type Spawn = (cmd: string, args: readonly string[], opts: { cwd?: string | undefined; env?: Record<string, string> | undefined }) => ChildLike;

/* v8 ignore start -- thin wrappers over node:child_process, covered by integration smoke */
export const nodeSpawn: Spawn = (cmd, args, opts) =>
  spawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
/* v8 ignore stop */

export function makeExec(spawnFn: Spawn): Exec {
  return (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let child: ChildLike;
      try {
        child = spawnFn(cmd, args, { cwd: opts.cwd, env: opts.env });
      } catch (err) {
        resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
        return;
      }
      const timer =
        opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, opts.timeoutMs);
      const finish = (code: number | null, extra = ""): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr: stderr + extra, timedOut });
      };
      child.stdout?.on("data", (c) => {
        const s = c.toString();
        stdout += s;
        opts.onStdout?.(s);
      });
      child.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", (err) => {
        finish(null, err.message);
      });
      child.on("exit", (code) => {
        finish(code);
      });
      if (opts.input !== undefined) child.stdin?.write(opts.input);
      child.stdin?.end();
    });
}

/** Split a stream into LF-terminated lines (Pi JSONL: only LF, not readline). */
export class LineSplitter {
  private buf = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let i = this.buf.indexOf("\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
      i = this.buf.indexOf("\n");
    }
  }

  flush(): void {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.onLine(rest);
  }
}
