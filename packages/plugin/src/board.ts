/** Pure board model (Р-011): columns, cards, moves → human events (Р-017 reason). */
import type { TaskActionContext, TaskEvent, TaskStatus } from "@of/core";
import { findEventForMove } from "@of/core";
import type { TaskView } from "./api.js";

export interface Column {
  status: TaskStatus;
  title: string;
  tasks: TaskView[];
}

export const COLUMN_TITLES: Readonly<Record<TaskStatus, string>> = {
  backlog: "Бэклог",
  planning: "Планирование",
  improve: "Улучшение плана",
  plan_ready: "План готов",
  implementing: "Реализация",
  review: "Ревью",
  verify: "Проверка",
  blocked_external: "Заблокировано",
  done: "Готово",
  verified: "Принято",
};

const ORDER: readonly TaskStatus[] = ["backlog", "planning", "improve", "plan_ready", "implementing", "review", "verify", "blocked_external", "done", "verified"];

export function buildColumns(tasks: readonly TaskView[], opts: { hideEmpty?: readonly TaskStatus[]; showArchived?: boolean } = {}): Column[] {
  const visible = tasks.filter((t) => opts.showArchived === true || !t.archived);
  return ORDER.map((status) => ({
    status,
    title: COLUMN_TITLES[status],
    tasks: visible
      .filter((t) => t.status === status)
      .sort((a, b) => b.priority - a.priority || a.position - b.position || a.id.localeCompare(b.id)),
  })).filter((c) => c.tasks.length > 0 || !(opts.hideEmpty ?? []).includes(c.status));
}

export type MovePlan = { kind: "noop" } | { kind: "denied"; message: string } | { kind: "event"; event: TaskEvent; requiresReason: true };

export function planMove(task: TaskView, to: TaskStatus, ctx: TaskActionContext): MovePlan {
  if (task.status === to) return { kind: "noop" };
  if (task.archived) return { kind: "denied", message: "Задача в архиве — сначала восстанови её" };
  const event = findEventForMove(task, to, ctx);
  if (event === null) {
    return { kind: "denied", message: `Переход «${COLUMN_TITLES[task.status]}» → «${COLUMN_TITLES[to]}» вручную недоступен` };
  }
  return { kind: "event", event, requiresReason: true };
}

export const EVENT_TITLES: Readonly<Record<TaskEvent, string>> = {
  start_ai: "Запустить ИИ",
  accept_existing_plan: "Принять готовый план",
  start_human_work: "Начать работу (человек)",
  mark_plan_ready: "План готов",
  start_implementation: "Начать реализацию",
  submit_implementation: "Сдать реализацию",
  complete_review: "Ревью пройдено",
  request_review_changes: "Ревью: доработать",
  pass_verification: "Проверка пройдена",
  fail_verification: "Проверка не пройдена",
  request_replanning: "Перепланировать",
  fast_fix: "Быстрая правка плана",
  approve_done: "Принять",
  request_changes: "Вернуть на доработку",
  retry_from_blocked: "Повторить",
};

export interface CardBadge {
  text: string;
  kind: "owner" | "paused" | "blocked" | "waiting" | "running" | "priority" | "review";
  title: string;
}

export function cardBadges(task: TaskView, info: { running: Set<string>; waitingWorker: Set<string>; waitingModel: Set<string> }): CardBadge[] {
  const key = `${task.project}/${task.id}`;
  const out: CardBadge[] = [];
  out.push(
    task.executionOwner === "ai"
      ? { text: "ИИ", kind: "owner", title: "Ведёт ИИ" }
      : { text: task.assignees.map((a) => a.displayName).join(", ") || "человек", kind: "owner", title: "Ведёт человек" },
  );
  if (task.priority > 0) out.push({ text: `P${String(task.priority)}`, kind: "priority", title: "Приоритет" });
  if (task.paused) out.push({ text: "пауза", kind: "paused", title: "Задача на паузе" });
  if (info.running.has(key)) out.push({ text: "идёт", kind: "running", title: "Этап выполняется" });
  if (info.waitingWorker.has(key)) out.push({ text: "ждёт ПК", kind: "waiting", title: "ПК недоступен" });
  if (info.waitingModel.has(key)) out.push({ text: "ждёт модель", kind: "waiting", title: "Все модели цепочки недоступны" });
  if (task.status === "blocked_external" && task.blockedReason) out.push({ text: "блок", kind: "blocked", title: task.blockedReason });
  if (task.manualReviewRequired) out.push({ text: "ручное ревью", kind: "review", title: "Нужна ручная проверка" });
  return out;
}

export function indicator(status: {
  ok: boolean;
  workerOnline: boolean | null;
  error: string | null;
  /** ISO time of the last PC probe; null = never probed. */
  workerCheckedAt?: string | null | undefined;
  workerDetail?: string | undefined;
}): { text: string; cls: string; title: string } {
  const when = status.workerCheckedAt ? ` (проверено ${status.workerCheckedAt.slice(11, 16)} UTC)` : "";
  const detail = status.workerDetail ? `: ${status.workerDetail}` : "";
  if (!status.ok) return { text: "OF: ✕ сервер", cls: "of-ind-bad", title: "Сервер OF недоступен" };
  if (status.workerOnline === false && status.workerCheckedAt === null) return { text: "OF: ● сервер · ПК ?", cls: "of-ind-unknown", title: "ПК ещё не проверялся" };
  if (status.workerOnline === false) return { text: "OF: ● сервер · ПК офлайн", cls: "of-ind-warn", title: `ПК недоступен${detail}${when}` };
  if (status.workerOnline === null) return { text: "OF: ● сервер", cls: "of-ind-ok", title: "Воркер ПК не настроен" };
  return { text: "OF: ● онлайн", cls: "of-ind-ok", title: `Сервер и ПК онлайн${detail}${when}` };
}
