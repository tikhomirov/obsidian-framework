/** In-process event bus for SSE (`/events`) and the coordinator wake-up. */
import { EventEmitter } from "node:events";

export interface BusEvent {
  type: "task.changed" | "task.created" | "task.archived" | "project.changed" | "models.changed" | "worker.status";
  project: string | null;
  taskId: string | null;
  data: Record<string, unknown>;
  at: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: BusEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}

/** Serialises async work per key (single writer per project, spec 4). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
