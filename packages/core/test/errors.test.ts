import { describe, expect, it } from "vitest";
import { classifyByHttpStatus, classifyByMessageFallback, extractResetAt, isExternalFailureCategory, isModelLimitCategory } from "../src/errors.js";
import { NOW } from "./helpers.js";

describe("error classification (AIF runtime/errors.ts)", () => {
  it.each([
    [401, "auth"],
    [402, "no_subscription"],
    [429, "rate_limit"],
    [504, "timeout"],
    [503, "transport"],
    [413, "context_length"],
    [404, null],
  ] as const)("http %d → %s", (status, cat) => {
    expect(classifyByHttpStatus(status)).toBe(cat);
  });
  it.each([
    ["You've hit your usage limit", "rate_limit"],
    ["Payment Required", "no_subscription"],
    ["Your subscription has expired", "no_subscription"],
    ["Invalid API key", "auth"],
    ["request timed out", "timeout"],
    ["permission denied", "permission"],
    ["stream closed", "stream"],
    ["ECONNREFUSED", "transport"],
    ['No models match pattern "x/*"', "model_not_found"],
    ["maximum context length", "context_length"],
    ["content_policy", "content_filter"],
    ["weird", "unknown"],
  ] as const)("%s → %s", (msg, cat) => {
    expect(classifyByMessageFallback(msg)).toBe(cat);
  });
  it("external / limit categories", () => {
    expect(isExternalFailureCategory("rate_limit")).toBe(true);
    expect(isExternalFailureCategory("model_not_found")).toBe(false);
    expect(isModelLimitCategory("no_subscription")).toBe(true);
    expect(isModelLimitCategory("auth")).toBe(false);
  });
  it("extracts reset time", () => {
    expect(extractResetAt("limit resets at 2026-10-29T15:00:00Z", NOW)).toBe("2026-10-29T15:00:00.000Z");
    expect(extractResetAt("try again in 3h 20m", NOW)).toBe("2026-10-29T13:20:00.000Z");
    expect(extractResetAt("retry after 30 seconds", NOW)).toBe("2026-10-29T10:00:30.000Z");
    expect(extractResetAt("resets in 45 minutes", NOW)).toBe("2026-10-29T10:45:00.000Z");
    expect(extractResetAt("nothing here", NOW)).toBeNull();
  });
});
