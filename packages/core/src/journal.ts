/**
 * Append-only journal `Проекты/<Проект>/_журнал/ГГГГ-ММ.md` (spec section 6).
 * Fields as aif-handoff `audit_events`.
 */
import type { AuditActor, ExecutionOwner, TaskStatus } from "./types.js";

export interface JournalEvent {
  at: string;
  actor: AuditActor;
  action: string;
  taskId: string | null;
  from: TaskStatus | null;
  to: TaskStatus | null;
  reason: string | null;
  ownershipRevision: number | null;
  executionOwner: ExecutionOwner | null;
  metadata: Record<string, unknown> | null;
}

export const JOURNAL_HEADER = [
  "| время | кто | действие | задача | из | в | причина | ownership_revision | владелец | данные |",
  "|---|---|---|---|---|---|---|---|---|---|",
].join("\n");

/** Local ISO time with offset, e.g. `2026-10-29T01:10:00+03:00`. */
export function formatLocalIso(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

export function journalFileName(date: Date, offsetMinutes: number): string {
  return `${formatLocalIso(date, offsetMinutes).slice(0, 7)}.md`;
}

export function actorLabel(actor: AuditActor): string {
  const kind = actor.kind === "participant" ? "human" : actor.kind;
  return `${kind}:${actor.id ?? "unknown"}`;
}

function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function formatJournalRow(event: JournalEvent): string {
  const cells = [
    event.at,
    actorLabel(event.actor),
    event.action,
    event.taskId ?? "",
    event.from ?? "",
    event.to ?? "",
    event.reason ?? "",
    event.ownershipRevision === null ? "" : String(event.ownershipRevision),
    event.executionOwner ?? "",
    event.metadata ? JSON.stringify(event.metadata) : "",
  ];
  return `| ${cells.map(cell).join(" | ")} |`;
}

export function journalFileTemplate(project: string, month: string): string {
  return `---\ntype: journal\nproject: ${project}\nmonth: ${month}\n---\n# Журнал ${project} — ${month}\n\nТолько дописываем. Пишет только бэкенд.\n\n${JOURNAL_HEADER}\n`;
}

function splitCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch === "\\" && i + 1 < inner.length) {
      current += inner.charAt(i + 1);
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells.map((c) => c.replace(/<br>/g, "\n"));
}

export interface JournalRow {
  at: string;
  actor: string;
  action: string;
  taskId: string;
  from: string;
  to: string;
  reason: string;
  ownershipRevision: string;
  executionOwner: string;
  metadata: string;
}

export function parseJournal(text: string): JournalRow[] {
  const rows: JournalRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| время") || line.startsWith("|---")) continue;
    const c = splitCells(line);
    if (c.length < 10) continue;
    rows.push({
      at: c[0] ?? "",
      actor: c[1] ?? "",
      action: c[2] ?? "",
      taskId: c[3] ?? "",
      from: c[4] ?? "",
      to: c[5] ?? "",
      reason: c[6] ?? "",
      ownershipRevision: c[7] ?? "",
      executionOwner: c[8] ?? "",
      metadata: c[9] ?? "",
    });
  }
  return rows;
}

/** Short line for the task «История» section. */
export function historyLine(event: JournalEvent): string {
  const move = event.from !== null || event.to !== null ? ` ${event.from ?? "—"} → ${event.to ?? "—"}` : "";
  const reason = event.reason ? ` — ${event.reason}` : "";
  return `- ${event.at} · ${actorLabel(event.actor)} · ${event.action}${move}${reason}`;
}

/** Keep the last `max` history lines (spec: short history in the task). */
export function appendHistory(history: string, line: string, max = 30): string {
  const lines = history.split("\n").filter((l) => l.trim().length > 0);
  lines.push(line);
  return lines.slice(-max).join("\n");
}
