import { describe, expect, it } from "vitest";
import {
  EMPTY_MODELS_STATE,
  ModelsConfigError,
  chainFor,
  isModelAvailable,
  markModelUnavailable,
  parseModelsConfig,
  parseModelsState,
  pruneModelsState,
  resetModel,
  selectModel,
  serializeModelsConfig,
  splitModel,
} from "../src/models.js";
import { NOW } from "./helpers.js";

const raw = {
  version: 1,
  default_cooldown_minutes: 300,
  roles: {
    worker: { opencode: ["anthropic/claude-sonnet-4-5", "openai/gpt-5-codex"], pi: ["omniroute/qwen3-coder"] },
    planning: ["anthropic/claude-opus-4-1", "openai/gpt-5"],
    improve: ["openai/gpt-5"],
    review: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
    verify: ["omniroute/qwen3-coder"],
  },
};
const config = parseModelsConfig(raw);

describe("models.json (Р-024)", () => {
  it("parses and serializes", () => {
    expect(config.worker.opencode).toHaveLength(2);
    expect(config.defaultCooldownMinutes).toBe(300);
    expect(JSON.parse(serializeModelsConfig(config))).toEqual(raw);
    expect(parseModelsConfig({ ...raw, default_cooldown_minutes: undefined }).defaultCooldownMinutes).toBe(300);
  });
  it("reports every issue", () => {
    try {
      parseModelsConfig({ version: 2, default_cooldown_minutes: 0, roles: { worker: { opencode: [] }, planning: "x", improve: ["bad"], review: ["a/b"], verify: [1] } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelsConfigError);
      const issues = (e as ModelsConfigError).issues;
      expect(issues).toEqual(
        expect.arrayContaining([
          "version must be 1",
          "default_cooldown_minutes must be an integer 1..10080",
          "roles.worker.opencode must not be empty",
          "roles.worker.pi must be an array of \"provider/model\" strings",
          "roles.planning must be an array of \"provider/model\" strings",
          "roles.improve[0] must be \"provider/model\"",
          "roles.verify[0] must be \"provider/model\"",
        ]),
      );
    }
    expect(() => parseModelsConfig(null)).toThrow(ModelsConfigError);
    expect(() => parseModelsConfig({ version: 1 })).toThrow(/roles must be an object/);
    expect(() => parseModelsConfig({ version: 1, roles: { worker: [], planning: ["a/b"], improve: ["a/b"], review: ["a/b"], verify: ["a/b"] } })).toThrow(/roles.worker must be an object/);
  });
  it("chains per role and agent", () => {
    expect(chainFor(config, "worker", "pi")).toEqual(["omniroute/qwen3-coder"]);
    expect(chainFor(config, "review", "opencode")).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4-5"]);
  });
  it("selects the first available model, override first", () => {
    expect(selectModel(config, "worker", "opencode", EMPTY_MODELS_STATE, NOW)).toMatchObject({ ok: true, model: "anthropic/claude-sonnet-4-5", index: 0 });
    expect(selectModel(config, "worker", "opencode", EMPTY_MODELS_STATE, NOW, "openai/gpt-5-codex")).toMatchObject({ ok: true, model: "openai/gpt-5-codex", chain: ["openai/gpt-5-codex", "anthropic/claude-sonnet-4-5"] });
    const limited = markModelUnavailable(EMPTY_MODELS_STATE, "anthropic/claude-sonnet-4-5", "rate_limit", null, NOW, 300);
    expect(selectModel(config, "worker", "opencode", limited, NOW)).toMatchObject({ ok: true, model: "openai/gpt-5-codex", index: 1 });
  });
  it("limit marks until reset (or cooldown); subscription end is manual", () => {
    const a = markModelUnavailable(EMPTY_MODELS_STATE, "x/a", "rate_limit", "2026-10-29T15:00:00Z", NOW, 300);
    expect(a.models["x/a"]).toEqual({ unavailableUntil: "2026-10-29T15:00:00.000Z", manual: false, category: "rate_limit", since: NOW.toISOString() });
    const b = markModelUnavailable(a, "x/b", "rate_limit", "2020-01-01T00:00:00Z", NOW, 60);
    expect(b.models["x/b"]?.unavailableUntil).toBe("2026-10-29T11:00:00.000Z");
    const c = markModelUnavailable(b, "x/c", "no_subscription", null, NOW, 60);
    expect(c.models["x/c"]).toMatchObject({ unavailableUntil: null, manual: true });
    expect(isModelAvailable(c, "x/c", new Date("2030-01-01"))).toBe(false);
    expect(isModelAvailable(c, "x/a", new Date("2026-10-29T15:00:00Z"))).toBe(true);
    expect(isModelAvailable(c, "x/a", NOW)).toBe(false);
    expect(isModelAvailable({ version: 1, models: { "x/z": { unavailableUntil: null, manual: false, category: "rate_limit", since: "" } } }, "x/z", NOW)).toBe(false);
    expect(resetModel(c, "x/c").models["x/c"]).toBeUndefined();
    expect(Object.keys(pruneModelsState(c, new Date("2026-10-29T12:00:00Z")).models).sort()).toEqual(["x/a", "x/c"]);
  });
  it("all unavailable → wait until the nearest reset", () => {
    let s = markModelUnavailable(EMPTY_MODELS_STATE, "openai/gpt-5", "rate_limit", "2026-10-29T14:00:00Z", NOW, 300);
    expect(selectModel(config, "improve", "opencode", s, NOW)).toEqual({ ok: false, nextCheckAt: "2026-10-29T14:00:00.000Z", chain: ["openai/gpt-5"] });
    s = markModelUnavailable(EMPTY_MODELS_STATE, "openai/gpt-5", "no_subscription", null, NOW, 300);
    expect(selectModel(config, "improve", "opencode", s, NOW)).toEqual({ ok: false, nextCheckAt: null, chain: ["openai/gpt-5"] });
  });
  it("parses state defensively", () => {
    expect(parseModelsState(null)).toEqual(EMPTY_MODELS_STATE);
    expect(parseModelsState({ models: [] })).toEqual(EMPTY_MODELS_STATE);
    expect(parseModelsState({ models: { a: null, b: { manual: true }, "x/y": { unavailableUntil: null, manual: true, since: "s", category: "no_subscription" } } })).toEqual({
      version: 1,
      models: { "x/y": { unavailableUntil: null, manual: true, since: "s", category: "no_subscription" } },
    });
  });
  it("splits provider/model", () => {
    expect(splitModel("openrouter/meta/llama-3")).toEqual({ provider: "openrouter", modelId: "meta/llama-3" });
  });
});
