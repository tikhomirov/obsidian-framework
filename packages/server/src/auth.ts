import { createHash, timingSafeEqual } from "node:crypto";
import type { AuditActor, TaskAssignee } from "@of/core";
import type { TokenEntry, TokenScope } from "./config.js";

export interface Principal {
  name: string;
  kind: "participant" | "agent";
  id: string;
  scopes: TokenScope[];
  actor: AuditActor;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class Authenticator {
  private readonly entries: { entry: TokenEntry; hash: Buffer }[];

  constructor(
    tokens: TokenEntry[],
    private readonly participants: TaskAssignee[],
  ) {
    this.entries = tokens.map((entry) => ({ entry, hash: digest(entry.token) }));
  }

  get configured(): boolean {
    return this.entries.length > 0;
  }

  /** Constant-time comparison over all tokens. */
  authenticate(header: string | undefined): Principal | null {
    if (!header) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m?.[1]) return null;
    const h = digest(m[1]);
    let found: TokenEntry | null = null;
    for (const { entry, hash } of this.entries) {
      if (timingSafeEqual(hash, h)) found = entry;
    }
    if (!found) return null;
    const p = found.kind === "participant" ? this.participants.find((x) => x.participantId === found.id) : undefined;
    return {
      name: found.name,
      kind: found.kind,
      id: found.id,
      scopes: found.scopes,
      actor: { kind: found.kind, id: found.id, displayNameSnapshot: p?.displayName ?? found.name },
    };
  }
}

/** Fixed-window limiter per principal (MCP, AIF-like read/write limits). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.perMinute;
  }
}
