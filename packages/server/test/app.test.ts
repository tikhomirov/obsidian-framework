import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { nodeSpawn } from "../src/runners/process.js";
import { makeFixture } from "./helpers.js";

const TOKEN = "app-token-00000000000000000000000001";

describe("startApp (smoke on 127.0.0.1)", () => {
  it("boots, serves, stops", async () => {
    const f = await makeFixture();
    const config = loadConfig({
      OF_VAULT_DIR: f.dir,
      OF_PORT: "0",
      OF_COORDINATOR_ENABLED: "false",
      OF_TOKENS: JSON.stringify([{ name: "t", token: TOKEN, kind: "participant", id: "owner", scopes: ["api", "mcp"] }]),
      OF_WORKER_SSH_TARGET: "nobody@127.0.0.1",
    });
    const app = await startApp(config, nodeSpawn);
    expect(await readFile(join(f.dir, "Проекты", "Obsidian Framework", "Доска.md"), "utf8")).toContain("type: board");
    const port = (app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const created = await fetch(`http://127.0.0.1:${String(port)}/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "of", title: "log line" }),
    });
    expect(created.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
    await app.close();
    await expect(fetch(`http://127.0.0.1:${String(port)}/api/health`)).rejects.toThrow();
  });

  it("refuses to start without tokens", async () => {
    const f = await makeFixture();
    await expect(startApp(loadConfig({ OF_VAULT_DIR: f.dir, OF_PORT: "0" }), nodeSpawn)).rejects.toThrow(/No API tokens/);
  });

  it("starts the coordinator when enabled", async () => {
    const f = await makeFixture();
    const app = await startApp(
      loadConfig({ OF_VAULT_DIR: f.dir, OF_PORT: "0", OF_POLL_INTERVAL_MS: "60000", OF_TOKENS: JSON.stringify([{ name: "t", token: TOKEN, kind: "participant", id: "owner", scopes: ["api"] }]) }),
      nodeSpawn,
    );
    expect(app.coordinator.status().worker.configured).toBe(false);
    await app.close();
  });
});
