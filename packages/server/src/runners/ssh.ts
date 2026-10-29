/**
 * PC stages via ssh → forced command `of-worker` (Р-019/Р-020). The ssh key on the PC
 * is restricted to `command="of-worker",restrict`; we only pass `run <ref>` / `status`.
 */
import type { WorkerSshConfig } from "../config.js";
import type { Exec } from "./process.js";
import { runtimeError } from "./errors.js";
import type { StageRunRequest, StageRunResult, StageRunner, WorkerProbe } from "./types.js";

export interface WorkerFinal {
  result: "ok" | "limit" | "no_subscription" | "error" | "busy";
  model?: string;
  sha?: string | null;
  branch?: string | null;
  resetAt?: string | null;
  message?: string;
}

export function parseWorkerFinal(stdout: string): WorkerFinal | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const r = o["result"];
      if (r === "ok" || r === "limit" || r === "no_subscription" || r === "error" || r === "busy") {
        return o as unknown as WorkerFinal;
      }
    } catch {
      /* not json */
    }
  }
  return null;
}

/** ssh exit 255 = connection failure → the PC is offline. */
const SSH_CONNECT_FAILURE = 255;

export class SshWorker implements StageRunner, WorkerProbe {
  constructor(
    private readonly cfg: WorkerSshConfig,
    private readonly exec: Exec,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sshArgs(remote: string[]): string[] {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"];
    if (this.cfg.identityFile) args.push("-i", this.cfg.identityFile, "-o", "IdentitiesOnly=yes");
    args.push(...this.cfg.extraOptions, this.cfg.target, ...remote);
    return args;
  }

  async probe(): Promise<{ online: boolean; busy: boolean; detail: string }> {
    const r = await this.exec("ssh", this.sshArgs(["status"]), { timeoutMs: 30_000 });
    if (r.code !== 0) return { online: false, busy: false, detail: r.timedOut ? "timeout" : `ssh exit ${String(r.code)}` };
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
      return { online: true, busy: o["busy"] === true, detail: typeof o["version"] === "string" ? o["version"] : "ok" };
    } catch {
      return { online: true, busy: false, detail: "unparsable status" };
    }
  }

  async run(req: StageRunRequest): Promise<StageRunResult> {
    const ref = `${req.task.project}/${req.task.id}`;
    const r = await this.exec("ssh", this.sshArgs(["run", ref]), {
      timeoutMs: req.timeoutMs,
      onStdout: () => {
        req.onHeartbeat();
      },
    });
    const final = parseWorkerFinal(r.stdout);
    if (!final) {
      if (r.timedOut) return { kind: "error", model: req.model, error: runtimeError("Worker stage timed out", this.now(), "timeout") };
      if (r.code === SSH_CONNECT_FAILURE || r.code === null) return { kind: "unavailable", reason: r.stderr.trim().slice(0, 300) || "ssh failed" };
      return { kind: "error", model: req.model, error: { kind: "other", reason: r.stderr.trim().slice(0, 2000) || `worker exit ${String(r.code)}` } };
    }
    const model = final.model ?? req.model;
    const message = final.message ?? "";
    switch (final.result) {
      case "ok":
        return { kind: "ok", text: message, sha: final.sha ?? null, branch: final.branch ?? null, model };
      case "busy":
        return { kind: "unavailable", reason: "worker busy" };
      case "limit":
        return { kind: "error", model, error: { kind: "runtime", category: "rate_limit", reason: message || "limit", resetAt: final.resetAt ?? null } };
      case "no_subscription":
        return { kind: "error", model, error: { kind: "runtime", category: "no_subscription", reason: message || "no subscription", resetAt: null } };
      case "error":
        return { kind: "error", model, error: runtimeError(message || "worker error", this.now()) };
    }
  }
}
