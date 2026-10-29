import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskAssignee } from "@of/core";
import { EventBus } from "../src/bus.js";
import type { BusEvent } from "../src/bus.js";
import type { ActorContext, CommitVerifier } from "../src/service.js";
import { TaskService } from "../src/service.js";
import { VaultStore } from "../src/vault/store.js";

export const MODELS_RAW = {
  version: 1,
  default_cooldown_minutes: 300,
  roles: {
    worker: { opencode: ["anthropic/claude-sonnet-4-5", "openai/gpt-5-codex"], pi: ["omniroute/qwen3-coder"] },
    planning: ["omniroute/plan-a", "omniroute/plan-b"],
    improve: ["omniroute/plan-a"],
    review: ["omniroute/review-a"],
    verify: ["omniroute/verify-a"],
  },
};

export const PARTICIPANTS: TaskAssignee[] = [
  { participantId: "owner", displayName: "Owner", role: "admin", active: true },
  { participantId: "bob", displayName: "Боб", role: "member", active: true },
  { participantId: "old", displayName: "Old", role: "member", active: false },
];

export const OWNER: ActorContext = { actor: { kind: "participant", id: "owner", displayNameSnapshot: "Owner" }, source: "api" };
export const BOB: ActorContext = { actor: { kind: "participant", id: "bob", displayNameSnapshot: "Боб" }, source: "api" };
export const AGENT: ActorContext = { actor: { kind: "agent", id: "pc", displayNameSnapshot: "pc" }, source: "mcp" };

export class Clock {
  constructor(public ms: number = Date.parse("2026-10-29T10:00:00.000Z")) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Fixture {
  dir: string;
  store: VaultStore;
  bus: EventBus;
  events: BusEvent[];
  service: TaskService;
  clock: Clock;
}

export const PROJECT_MD = (extra = ""): string =>
  `---\ntype: project\nid: of\ntitle: Obsidian Framework\nrepo: /tmp/none.git\ndefault_branch: main\nnext_task_number: 1\ncreated: 2026-10-29\n${extra}---\n# Obsidian Framework\n`;

export async function makeFixture(opts: { models?: boolean; projectExtra?: string; verifier?: CommitVerifier | null } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "of-test-"));
  const projectDir = join(dir, "Проекты", "Obsidian Framework");
  await mkdir(join(projectDir, "Задачи"), { recursive: true });
  await writeFile(join(projectDir, "Проект.md"), PROJECT_MD(opts.projectExtra ?? ""));
  if (opts.models !== false) await writeFile(join(projectDir, "models.json"), JSON.stringify(MODELS_RAW));
  const clock = new Clock();
  const store = new VaultStore({ vaultDir: dir, projectsDir: "Проекты", frameworkDir: "Проекты/Obsidian Framework", tzOffsetMinutes: 180 });
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const service = new TaskService({
    store,
    bus,
    participants: PARTICIPANTS,
    tzOffsetMinutes: 180,
    useSubagentsDefault: false,
    now: clock.now,
    commitVerifier: opts.verifier ?? null,
  });
  return { dir, store, bus, events, service, clock };
}
