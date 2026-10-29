/**
 * Auto review gate (AIF `reviewGate.ts` / `reviewContract.ts`, simplified):
 * the reviewer writes canonical sections `## Blocking Findings` and `## Advisories`.
 */
import { createHash } from "node:crypto";
import type { ReviewOutcome } from "./pipeline.js";
import type { AutoReviewFinding, AutoReviewState } from "./types.js";

export function normalizeFindingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function createFindingId(source: AutoReviewFinding["source"], text: string): string {
  return createHash("sha1").update(`${source}:${normalizeFindingText(text).toLowerCase()}`).digest("hex").slice(0, 12);
}

function collectSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  return sections;
}

/** AIF `normalizeListSection`: `- item` lines; `- none` = empty; anything else = unparsable. */
export function normalizeListSection(lines: string[] | undefined): string[] | null {
  if (!lines) return null;
  const normalized = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (normalized.length === 0) return [];
  if (!normalized.every((l) => l.startsWith("- "))) return null;
  const items = normalized.map((l) => l.slice(2).trim());
  if (items.length === 1 && items[0]?.toLowerCase() === "none") return [];
  if (items.some((i) => i.length === 0 || i.toLowerCase() === "none")) return null;
  return items;
}

export interface ParsedReview {
  blocking: AutoReviewFinding[];
  advisories: string[];
  structured: boolean;
}

export function parseReviewComments(text: string): ParsedReview {
  const sections = collectSections(text);
  const blocking = normalizeListSection(sections.get("Blocking Findings"));
  const advisories = normalizeListSection(sections.get("Advisories")) ?? [];
  if (blocking === null) {
    const raw = normalizeFindingText(text);
    return {
      blocking: raw ? [{ id: createFindingId("review_gate", raw), text: raw.slice(0, 2000), source: "review_gate" }] : [],
      advisories,
      structured: false,
    };
  }
  return {
    blocking: blocking.map((t) => ({ id: createFindingId("code_review", t), text: normalizeFindingText(t), source: "code_review" })),
    advisories,
    structured: true,
  };
}

/**
 * Decision like AIF `handleAutoReviewGate`: no blocking → accepted; blocking and
 * iteration < max → rework; iteration ≥ max → manual review (handoff to human).
 */
export function evaluateReview(text: string, reviewIterationCount: number, maxReviewIterations: number): ReviewOutcome {
  const parsed = parseReviewComments(text);
  const currentIteration = reviewIterationCount + 1;
  if (parsed.blocking.length === 0) return { status: "accepted", currentIteration };
  const autoReviewState: AutoReviewState = { strategy: "full_re_review", iteration: currentIteration, findings: parsed.blocking };
  if (currentIteration >= maxReviewIterations) {
    return { status: "manual_review_required", currentIteration, autoReviewState, handoffReason: "max_iterations" };
  }
  return { status: "rework_requested", currentIteration, autoReviewState };
}
