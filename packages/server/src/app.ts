/** Wiring of all server parts (used by main.ts and integration tests). */
import type { Server } from "node:http";
import { Authenticator } from "./auth.js";
import { EventBus } from "./bus.js";
import type { ServerConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { GitMirror } from "./git.js";
import { startHttpServer } from "./http.js";
import { createMcpHandler } from "./mcp.js";
import { PiRpcRunner } from "./runners/pi.js";
import type { Exec, Spawn } from "./runners/process.js";
import { makeExec } from "./runners/process.js";
import { SshWorker } from "./runners/ssh.js";
import { TaskService } from "./service.js";
import { VaultStore } from "./vault/store.js";

export interface App {
  service: TaskService;
  store: VaultStore;
  coordinator: Coordinator;
  server: Server;
  close(): Promise<void>;
}

export async function startApp(config: ServerConfig, spawn: Spawn, opts: { exec?: Exec; corsOrigins?: string[] } = {}): Promise<App> {
  const exec = opts.exec ?? makeExec(spawn);
  const store = new VaultStore({
    vaultDir: config.vaultDir,
    projectsDir: config.projectsDir,
    frameworkDir: config.frameworkDir,
    tzOffsetMinutes: config.tzOffsetMinutes,
  });
  const bus = new EventBus();
  // Operational log: one line per task change (docker logs of-server).
  bus.subscribe((e) => {
    if (e.type !== "task.changed" && e.type !== "task.created") return;
    const action = typeof e.data["action"] === "string" ? e.data["action"] : e.type;
    const status = typeof e.data["status"] === "string" ? ` → ${e.data["status"]}` : "";
    process.stdout.write(`[of-server] ${e.at} ${e.project ?? "-"}/${e.taskId ?? "-"} ${action}${status}\n`);
  });
  const git = new GitMirror({ clonesDir: config.clonesDir, gitBin: config.gitBin, exec });
  const service = new TaskService({
    store,
    bus,
    participants: config.participants,
    tzOffsetMinutes: config.tzOffsetMinutes,
    useSubagentsDefault: config.useSubagentsDefault,
    commitVerifier: git,
  });
  const worker = config.worker ? new SshWorker(config.worker, exec) : null;
  const admin = config.participants.find((p) => p.role === "admin" && p.active);
  const coordinator = new Coordinator({
    service,
    store,
    pi: new PiRpcRunner({ spawn, piBin: config.piBin }),
    worker,
    git,
    watchdog: config.watchdog,
    stageRunTimeoutMs: config.stageRunTimeoutMs,
    lockTtlMs: config.lockTtlMs,
    workerProbeIntervalMs: config.workerProbeIntervalMs,
    autoArchiveDays: config.autoArchiveDays,
    prompts: config.prompts,
    adminParticipantId: admin?.participantId ?? "owner",
  });
  const auth = new Authenticator(config.tokens, config.participants);
  if (!auth.configured) throw new Error("No API tokens configured (OF_TOKENS / OF_TOKENS_FILE)");
  const server = await startHttpServer(
    {
      service,
      store,
      bus,
      auth,
      coordinator,
      lockTtlMs: config.lockTtlMs,
      corsOrigins: opts.corsOrigins ?? ["app://obsidian.md"],
      mcp: createMcpHandler({ service, store, rateLimitPerMinute: config.mcpRateLimitPerMinute }),
    },
    config.host,
    config.port,
  );
  // Р-034: board file in the root of every project (only when missing).
  for (const path of await store.ensureBoards()) process.stdout.write(`[of-server] created board ${path}\n`);
  if (config.coordinatorEnabled) coordinator.start(config.pollIntervalMs);
  return {
    service,
    store,
    coordinator,
    server,
    async close() {
      await coordinator.stop();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
