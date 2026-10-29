#!/usr/bin/env node
/** of-server entry point. */
import { startApp } from "./app.js";
import { loadConfig } from "./config.js";
import { nodeSpawn } from "./runners/process.js";

const config = loadConfig(process.env);
const cors = (process.env["OF_CORS_ORIGINS"] ?? "app://obsidian.md").split(",").map((s) => s.trim()).filter(Boolean);
const app = await startApp(config, nodeSpawn, { corsOrigins: cors });
const addr = app.server.address();
console.log(`[of-server] listening on ${typeof addr === "object" && addr ? `${addr.address}:${String(addr.port)}` : String(addr)}; vault=${config.vaultDir}; coordinator=${String(config.coordinatorEnabled)}`);

const shutdown = (signal: string): void => {
  console.log(`[of-server] ${signal}: stopping…`);
  void app.close().then(() => process.exit(0));
};
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
