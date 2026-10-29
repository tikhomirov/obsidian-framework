import { describe, expect, it } from "vitest";
import { FlagValidationError, defaultsForMode, resolveTaskFlags, validatePriority } from "../src/flags.js";
import { applyPatch, createTask } from "../src/factory.js";

const ctx = { parallelEnabled: false, useSubagentsDefault: false };

describe("flags and defaults (spec section 2)", () => {
  it("planner mode defaults (AIF plannerDefaults.ts)", () => {
    expect(defaultsForMode("fast")).toEqual({ skipReview: true, planDocs: false, planTests: false });
    expect(defaultsForMode("full")).toEqual({ skipReview: false, planDocs: true, planTests: true });
  });
  it("all defaults", () => {
    expect(resolveTaskFlags({}, ctx)).toEqual({
      autoMode: true,
      plannerMode: "fast",
      skipReview: true,
      planDocs: false,
      planTests: false,
      runPlanImprove: false,
      runPostVerify: false,
      useSubagents: false,
      maxReviewIterations: 3,
      isFix: false,
      autoQa: false,
      autoQaCheck: false,
      paused: false,
      priority: 0,
      runtimeProfile: "opencode",
    });
  });
  it("parallel project forces full", () => {
    expect(resolveTaskFlags({ plannerMode: "fast" }, { ...ctx, parallelEnabled: true })).toMatchObject({ plannerMode: "full", skipReview: false, planDocs: true });
  });
  it("explicit values win over mode defaults", () => {
    expect(resolveTaskFlags({ plannerMode: "full", skipReview: true, planDocs: false }, ctx)).toMatchObject({ skipReview: true, planDocs: false, planTests: true });
  });
  it("use_subagents forces improve/verify off", () => {
    expect(resolveTaskFlags({ useSubagents: true, runPlanImprove: true, runPostVerify: true }, ctx)).toMatchObject({ runPlanImprove: false, runPostVerify: false });
    expect(resolveTaskFlags({ runPlanImprove: true }, { ...ctx, useSubagentsDefault: true })).toMatchObject({ useSubagents: true, runPlanImprove: false });
    expect(resolveTaskFlags({ runPlanImprove: true, runPostVerify: true }, ctx)).toMatchObject({ runPlanImprove: true, runPostVerify: true });
  });
  it("validates ranges", () => {
    expect(() => resolveTaskFlags({ maxReviewIterations: 0 }, ctx)).toThrow(FlagValidationError);
    expect(() => resolveTaskFlags({ maxReviewIterations: 51 }, ctx)).toThrow(FlagValidationError);
    expect(() => resolveTaskFlags({ maxReviewIterations: 1.5 }, ctx)).toThrow(FlagValidationError);
    expect(resolveTaskFlags({ maxReviewIterations: 50 }, ctx).maxReviewIterations).toBe(50);
    expect(() => validatePriority(4, 3)).toThrow(FlagValidationError);
    expect(validatePriority(5, 5)).toBe(5);
    expect(() => resolveTaskFlags({ priority: -1 }, ctx)).toThrow(/priority/);
  });
});

describe("createTask", () => {
  it("new task is backlog, ai-owned, with defaults", () => {
    const t = createTask({ title: "  Новая  ", tags: ["x"], description: "d", scheduledAt: "2026-11-01T00:00:00Z", modelOverride: "a/b", plan: "p", position: 3, roadmap: "M1" }, { project: "of", id: "TASK-007" }, ctx, "2026-10-29T10:00:00Z");
    expect(t).toMatchObject({ id: "TASK-007", project: "of", title: "Новая", aliases: ["Новая"], status: "backlog", executionOwner: "ai", ownershipRevision: 0, tags: ["x"], position: 3, roadmap: "M1", modelOverride: "a/b", plan: "p" });
    expect(() => createTask({ title: " " }, { project: "of", id: "TASK-1" }, ctx, "x")).toThrow(RangeError);
    expect(applyPatch(t, { status: "planning" }, "later")).toMatchObject({ status: "planning", updated: "later" });
  });
});
