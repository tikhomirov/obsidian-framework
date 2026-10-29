import type { RuntimeErrorCategory, StageError } from "@of/core";
import { classifyByMessageFallback, extractResetAt } from "@of/core";

/** Runtime message → StageError (AIF fallback patterns + reset time). */
export function runtimeError(message: string, now: Date, forced?: RuntimeErrorCategory): StageError {
  const category = forced ?? classifyByMessageFallback(message);
  return { kind: "runtime", category, reason: message.slice(0, 2000), resetAt: extractResetAt(message, now) };
}
