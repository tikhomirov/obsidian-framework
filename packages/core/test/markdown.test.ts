import { describe, expect, it } from "vitest";
import {
  TaskFormatError,
  parseBody,
  parseProjectMarkdown,
  parseTaskMarkdown,
  serializeBody,
  serializeProjectMarkdown,
  serializeTaskMarkdown,
  splitFrontmatter,
} from "../src/markdown.js";
import { makeTask } from "./helpers.js";

describe("TASK-NNN.md", () => {
  it("round-trips a task", () => {
    const t = makeTask("review", {
      plan: "- [ ] шаг 1\n## Inner heading stays",
      description: "Сделать вход",
      tags: ["auth"],
      assignees: [{ participantId: "owner", displayName: "Owner", role: "admin", active: true }],
      commits: [{ sha: "abc1234", branch: "main", at: "2026-10-29T10:00:00Z" }],
      autoReviewState: { strategy: "full_re_review", iteration: 1, findings: [{ id: "f1", source: "code_review", text: "x" }] },
      blockedFromStatus: "verify",
      runtimeProfile: "pi",
      modelOverride: "anthropic/claude-sonnet-4-5",
    });
    const text = serializeTaskMarkdown(t);
    expect(text.startsWith("---\ntype: task\nid: TASK-001\n")).toBe(true);
    expect(text).toContain("## План\n- [ ] шаг 1\n## Inner heading stays");
    expect(parseTaskMarkdown(text, "of")).toEqual(t);
  });

  it("keeps unknown keys and key order on rewrite", () => {
    const original = "---\ncustom: keep-me\nstatus: backlog\nid: TASK-002\ntitle: T\ncreated: 2026-10-29\nupdated: 2026-10-29\n---\n# T\n";
    const t = parseTaskMarkdown(original, "of");
    const rewritten = serializeTaskMarkdown({ ...t, status: "planning" }, original);
    const lines = rewritten.split("\n");
    expect(lines[1]).toBe("custom: keep-me");
    expect(lines[2]).toBe("status: planning");
    expect(lines[3]).toBe("id: TASK-002");
    expect(rewritten).toContain("type: task");
  });

  it("applies AIF defaults for missing fields (fast mode)", () => {
    const t = parseTaskMarkdown("---\nid: TASK-003\ntitle: Minimal\nstatus: backlog\ncreated: 2026-10-29\nupdated: 2026-10-29\n---\nfree text\n", "of");
    expect(t).toMatchObject({ autoMode: true, plannerMode: "fast", skipReview: true, planDocs: false, maxReviewIterations: 3, executionOwner: "ai", runtimeProfile: "opencode", aliases: ["Minimal"], description: "free text" });
    const full = parseTaskMarkdown("---\nid: TASK-004\ntitle: Full\nstatus: backlog\nplanner_mode: full\ncreated: 2026-10-29\nupdated: 2026-10-29\n---\n", "of");
    expect(full).toMatchObject({ skipReview: false, planDocs: true, planTests: true });
  });

  it("keeps YAML timestamps as strings, accepts numbers and scalar lists", () => {
    const t = parseTaskMarkdown("---\nid: TASK-005\ntitle: 123\nstatus: done\ntags: one\nscheduled_at: 2026-10-30T10:00:00Z\nroadmap: 7\ncreated: 2026-10-29\nupdated: 2026-10-29\n---\n", "of");
    expect(t.title).toBe("123");
    expect(t.tags).toEqual(["one"]);
    expect(t.scheduledAt).toBe("2026-10-30T10:00:00Z");
    expect(t.roadmap).toBe("7");
    expect(t.created).toBe("2026-10-29");
  });

  it.each([
    ["no frontmatter", "# x"],
    ["unterminated", "---\nid: x\n"],
    ["bad yaml", "---\nid: [\n---\n"],
    ["not a map", "---\n- a\n---\n"],
    ["bad status", "---\nid: TASK-1\ntitle: t\nstatus: nope\ncreated: a\nupdated: a\n---\n"],
    ["bad bool", "---\nid: TASK-1\ntitle: t\nstatus: done\npaused: maybe\ncreated: a\nupdated: a\n---\n"],
    ["bad number", "---\nid: TASK-1\ntitle: t\nstatus: done\npriority: high\ncreated: a\nupdated: a\n---\n"],
    ["bad list", "---\nid: TASK-1\ntitle: t\nstatus: done\ntags: [1]\ncreated: a\nupdated: a\n---\n"],
    ["bad owner", "---\nid: TASK-1\ntitle: t\nstatus: done\nexecution_owner: bot\ncreated: a\nupdated: a\n---\n"],
    ["bad mode", "---\nid: TASK-1\ntitle: t\nstatus: done\nplanner_mode: ultra\ncreated: a\nupdated: a\n---\n"],
    ["bad runtime", "---\nid: TASK-1\ntitle: t\nstatus: done\nruntime_profile: claude\ncreated: a\nupdated: a\n---\n"],
    ["bad blocked_from", "---\nid: TASK-1\ntitle: t\nstatus: done\nblocked_from: x\ncreated: a\nupdated: a\n---\n"],
    ["bad nullable", "---\nid: TASK-1\ntitle: t\nstatus: done\nbranch: [a]\ncreated: a\nupdated: a\n---\n"],
    ["missing title", "---\nid: TASK-1\nstatus: done\ncreated: a\nupdated: a\n---\n"],
  ])("rejects %s", (_name, text) => {
    expect(() => parseTaskMarkdown(text, "of")).toThrow(TaskFormatError);
  });

  it("filters malformed nested values", () => {
    const t = parseTaskMarkdown(
      "---\nid: TASK-1\ntitle: t\nstatus: done\nassignees: [{a: 1}, null]\ncommits: [{sha: 1}]\nauto_review_state: {strategy: x}\ncreated: a\nupdated: a\n---\n",
      "of",
    );
    expect(t.assignees).toEqual([]);
    expect(t.commits).toEqual([]);
    expect(t.autoReviewState).toBeNull();
  });

  it("parses body sections and CRLF/BOM", () => {
    const { body } = splitFrontmatter("\uFEFF---\r\nid: 1\r\n---\r\n## Описание\r\nтекст\r\n");
    expect(parseBody(body).description).toBe("текст");
    expect(serializeBody(makeTask("backlog", { description: "", title: "X" }))).toBe("# X\n\n## Описание\n\n## План\n\n## Лог выполнения\n\n## Замечания ревью\n\n## История\n");
  });

  it("serializes into a fresh document when previous has no mapping", () => {
    const prev = "---\n---\n";
    expect(serializeTaskMarkdown(makeTask("backlog"), prev)).toContain("type: task");
  });
});

describe("Проект.md", () => {
  const text = "---\ntype: project\nid: of\ntitle: Obsidian Framework\nrepo: git@git.example.com:user/vault.git\ndefault_branch: main\nauto_queue_mode: true\nnext_task_number: 13\ncreated: 2026-10-29\nextra: 1\n---\n# Obsidian Framework\n";
  it("parses with defaults", () => {
    const { project } = parseProjectMarkdown(text);
    expect(project).toEqual({
      id: "of",
      title: "Obsidian Framework",
      status: "active",
      repo: "git@git.example.com:user/vault.git",
      defaultBranch: "main",
      autoQueueMode: true,
      parallelEnabled: false,
      nextTaskNumber: 13,
      created: "2026-10-29",
      updated: "2026-10-29",
    });
    expect(parseProjectMarkdown("---\ntype: project\nid: x\nstatus: paused\nnext_task_number: -1\n---\n").project).toMatchObject({ status: "paused", nextTaskNumber: 1, title: "x", repo: "" });
  });
  it("rejects non-project files", () => {
    expect(() => parseProjectMarkdown("---\ntype: task\n---\n")).toThrow(TaskFormatError);
    expect(() => parseProjectMarkdown("---\ntype: project\n---\n")).toThrow(TaskFormatError);
  });
  it("serializes in place", () => {
    const { project } = parseProjectMarkdown(text);
    const out = serializeProjectMarkdown({ ...project, nextTaskNumber: 14 }, text);
    expect(out).toContain("next_task_number: 14");
    expect(out).toContain("extra: 1");
    expect(out.endsWith("# Obsidian Framework\n")).toBe(true);
  });
});
