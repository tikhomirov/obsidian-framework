import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseParticipants, parseTokens } from "../src/config.js";

const TOKEN = "x".repeat(32);

describe("config", () => {
  it("defaults", () => {
    const c = loadConfig({ OF_VAULT_DIR: "/vault" });
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, tokens: [], coordinatorEnabled: true, worker: null, autoArchiveDays: 7, frameworkDir: "Проекты/Obsidian Framework" });
    expect(c.participants[0]).toMatchObject({ participantId: "owner", role: "admin" });
    expect(c.watchdog).toEqual({ staleTimeoutMs: 5_400_000, staleMaxRetry: 3, attemptRecoveryEnabled: true });
    expect(c.prompts).toEqual({ opencode: "/{skill}", pi: "/skill:{skill}" });
  });

  it("env overrides, tokens file, worker ssh", () => {
    const files: Record<string, string> = {
      "/t.json": JSON.stringify([{ name: "plugin", token: TOKEN, kind: "participant", id: "owner", scopes: ["api"] }]),
      "/p.json": JSON.stringify([{ id: "owner", displayName: "A", role: "admin" }, { id: "b", displayName: "B", role: "member", active: false }]),
    };
    const c = loadConfig(
      {
        OF_VAULT_DIR: "/v",
        OF_TOKENS_FILE: "/t.json",
        OF_PARTICIPANTS_FILE: "/p.json",
        OF_PORT: "9000",
        OF_COORDINATOR_ENABLED: "off",
        AIF_AGENT_ATTEMPT_RECOVERY_ENABLED: "yes",
        AGENT_STAGE_STALE_TIMEOUT_MS: "1000",
        OF_WORKER_SSH_TARGET: "user@pc",
        OF_WORKER_SSH_KEY: "/k",
        OF_WORKER_SSH_OPTIONS: " -p  2222 ",
        OF_PROMPT_PI: "/{skill}",
      },
      (p) => files[p] ?? "",
    );
    expect(c.port).toBe(9000);
    expect(c.coordinatorEnabled).toBe(false);
    expect(c.watchdog.staleTimeoutMs).toBe(60_000);
    expect(c.tokens[0]?.name).toBe("plugin");
    expect(c.participants[1]?.active).toBe(false);
    expect(c.worker).toEqual({ target: "user@pc", identityFile: "/k", extraOptions: ["-p", "2222"] });
    expect(c.prompts.pi).toBe("/{skill}");
    const inline = loadConfig({ OF_VAULT_DIR: "/v", OF_TOKENS: files["/t.json"], OF_WORKER_SSH_TARGET: "h" });
    expect(inline.tokens).toHaveLength(1);
    expect(inline.worker).toEqual({ target: "h", identityFile: null, extraOptions: [] });
  });

  it("validation errors", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ OF_VAULT_DIR: "/v", OF_PORT: "x" })).toThrow(/OF_PORT/);
    expect(() => loadConfig({ OF_VAULT_DIR: "/v", OF_COORDINATOR_ENABLED: "maybe" })).toThrow(/boolean/);
    expect(() => parseTokens({})).toThrow(/array/);
    expect(() => parseTokens([null])).toThrow(/object/);
    expect(() => parseTokens([{}])).toThrow(/name/);
    expect(() => parseTokens([{ name: "a", token: "short" }])).toThrow(/24/);
    expect(() => parseTokens([{ name: "a", token: TOKEN, kind: "x" }])).toThrow(/kind/);
    expect(() => parseTokens([{ name: "a", token: TOKEN, kind: "agent" }])).toThrow(/id/);
    expect(() => parseTokens([{ name: "a", token: TOKEN, kind: "agent", id: "pc", scopes: ["root"] }])).toThrow(/scopes/);
    expect(() => parseParticipants({})).toThrow(/array/);
    expect(() => parseParticipants([null])).toThrow(/id/);
    expect(() => parseParticipants([{ id: "a", displayName: "A", role: "boss" }])).toThrow(/role/);
  });
});
