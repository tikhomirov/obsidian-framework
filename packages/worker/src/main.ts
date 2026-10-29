#!/usr/bin/env node
/** of-worker entry: forced ssh command on the PC. */
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExecResult, WorkerIO } from "./worker.js";
import { parseCommand, parseWorkerConfig, runStatus, runTask } from "./worker.js";

const home = homedir();
const configPath = process.env["OF_WORKER_CONFIG"] ?? `${home}/.config/obsidian-framework/worker.json`;
const lockPath = `${home}/.cache/obsidian-framework/worker.lock`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lockHolder(): Promise<number | null> {
  try {
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

const io: WorkerIO = {
  exec: (cmd, args, opts) =>
    new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, opts.timeoutMs) : null;
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); opts.onOutput?.(c.toString()); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + e.message, timedOut }); });
      child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    }),
  fetchJson: async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: { authorization: `Bearer ${init.token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  },
  readFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
  writeFile: async (p, t) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, t, "utf8"); },
  exists: async (p) => { try { await stat(p); return true; } catch { return false; } },
  mkdirp: async (p) => { await mkdir(p, { recursive: true }); },
  lock: async () => {
    await mkdir(dirname(lockPath), { recursive: true });
    if ((await lockHolder()) !== null) return null;
    await rm(lockPath, { force: true });
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
    } catch {
      return null;
    }
    return async () => { await rm(lockPath, { force: true }); };
  },
  isLocked: async () => (await lockHolder()) !== null,
  print: (line) => { process.stdout.write(`${line}\n`); },
  now: () => new Date(),
};

const command = parseCommand(process.env["SSH_ORIGINAL_COMMAND"], process.argv.slice(2));
if (command.kind === "invalid") {
  process.stderr.write(`${command.message}\n`);
  process.exit(2);
}
if (command.kind === "status") {
  await runStatus(io);
  process.exit(0);
}
let raw: unknown;
try {
  const st = await stat(configPath);
  if ((st.mode & 0o077) !== 0) {
    process.stderr.write(`${configPath} must be chmod 600\n`);
    process.exit(2);
  }
  raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
} catch (err) {
  process.stdout.write(`${JSON.stringify({ result: "error", model: null, sha: null, branch: null, resetAt: null, message: `cannot read worker config: ${err instanceof Error ? err.message : String(err)}` })}\n`);
  process.exit(1);
}
const cfg = parseWorkerConfig(raw, home);
const result = await runTask(cfg, io, command.project, command.id);
process.exit(result.result === "ok" ? 0 : 1);
