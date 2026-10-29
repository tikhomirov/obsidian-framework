import { describe, expect, it } from "vitest";
import { actorLabel, appendHistory, formatJournalRow, formatLocalIso, historyLine, journalFileName, journalFileTemplate, parseJournal } from "../src/journal.js";
import type { JournalEvent } from "../src/journal.js";

const ev: JournalEvent = {
  at: "2026-10-29T13:00:00+03:00",
  actor: { kind: "participant", id: "owner", displayNameSnapshot: "Owner" },
  action: "task.status_changed",
  taskId: "TASK-012",
  from: "plan_ready",
  to: "implementing",
  reason: "почему | так\nдве строки",
  ownershipRevision: 3,
  executionOwner: "ai",
  metadata: { a: 1 },
};

describe("journal", () => {
  it("formats local time and file names", () => {
    const d = new Date("2026-10-31T22:30:00Z");
    expect(formatLocalIso(d, 180)).toBe("2026-11-01T01:30:00+03:00");
    expect(formatLocalIso(d, -90)).toBe("2026-10-31T21:00:00-01:30");
    expect(journalFileName(d, 180)).toBe("2026-11.md");
  });
  it("labels actors", () => {
    expect(actorLabel(ev.actor)).toBe("human:owner");
    expect(actorLabel({ kind: "system", id: null, displayNameSnapshot: null })).toBe("system:unknown");
  });
  it("round-trips rows with escaping", () => {
    const text = `${journalFileTemplate("of", "2026-10")}${formatJournalRow(ev)}\n${formatJournalRow({ ...ev, from: null, to: null, reason: null, ownershipRevision: null, executionOwner: null, metadata: null, taskId: null })}\n| broken |\n`;
    const rows = parseJournal(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      at: ev.at,
      actor: "human:owner",
      action: "task.status_changed",
      taskId: "TASK-012",
      from: "plan_ready",
      to: "implementing",
      reason: "почему | так\nдве строки",
      ownershipRevision: "3",
      executionOwner: "ai",
      metadata: '{"a":1}',
    });
    expect(rows[1]?.taskId).toBe("");
  });
  it("history lines and trimming", () => {
    expect(historyLine(ev)).toBe("- 2026-10-29T13:00:00+03:00 · human:owner · task.status_changed plan_ready → implementing — почему | так\nдве строки");
    expect(historyLine({ ...ev, from: null, to: null, reason: null })).toBe("- 2026-10-29T13:00:00+03:00 · human:owner · task.status_changed");
    expect(historyLine({ ...ev, from: null, reason: null })).toContain("— → implementing");
    expect(appendHistory("", "a")).toBe("a");
    expect(appendHistory("a\nb\n\nc", "d", 3)).toBe("b\nc\nd");
  });
});
