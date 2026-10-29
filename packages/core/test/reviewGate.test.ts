import { describe, expect, it } from "vitest";
import { createFindingId, evaluateReview, normalizeListSection, parseReviewComments } from "../src/reviewGate.js";

const clean = "## Blocking Findings\n- none\n\n## Advisories\n- rename x\n";
const blocking = "## Blocking Findings\n- SQL injection in login\n- Missing test\n## Advisories\n";

describe("review gate", () => {
  it("normalizes list sections like AIF", () => {
    expect(normalizeListSection(undefined)).toBeNull();
    expect(normalizeListSection(["", " "])).toEqual([]);
    expect(normalizeListSection(["- none"])).toEqual([]);
    expect(normalizeListSection(["- a", "- b"])).toEqual(["a", "b"]);
    expect(normalizeListSection(["text"])).toBeNull();
    expect(normalizeListSection(["- a", "- none"])).toBeNull();
  });
  it("parses structured comments", () => {
    expect(parseReviewComments(clean)).toEqual({ blocking: [], advisories: ["rename x"], structured: true });
    const p = parseReviewComments(blocking);
    expect(p.blocking.map((f) => f.text)).toEqual(["SQL injection in login", "Missing test"]);
    expect(p.blocking[0]?.id).toBe(createFindingId("code_review", "SQL injection in login"));
  });
  it("unstructured text becomes one blocking finding (AIF fallback)", () => {
    expect(parseReviewComments("looks wrong").blocking).toHaveLength(1);
    expect(parseReviewComments("").blocking).toHaveLength(0);
  });
  it("evaluates outcomes", () => {
    expect(evaluateReview(clean, 0, 3)).toEqual({ status: "accepted", currentIteration: 1 });
    expect(evaluateReview(blocking, 0, 3)).toMatchObject({ status: "rework_requested", currentIteration: 1 });
    expect(evaluateReview(blocking, 2, 3)).toMatchObject({ status: "manual_review_required", currentIteration: 3, handoffReason: "max_iterations" });
  });
});
