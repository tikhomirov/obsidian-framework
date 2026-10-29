/** `/events` over fetch streaming with reconnect (EventSource can't send headers). */
import { SseParser } from "./api.js";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;

export class EventStream {
  private ctrl: AbortController | null = null;
  private stopped = true;
  private attempt = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: FetchLike,
    private readonly onEvent: (type: string, data: unknown) => void,
    private readonly onState: (connected: boolean) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  start(): void {
    if (!this.stopped) return;
    void this.loop();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.ctrl?.abort();
  }

  async loop(maxRounds = Number.POSITIVE_INFINITY): Promise<void> {
    this.stopped = false;
    let rounds = 0;
    while (!this.isStopped() && rounds < maxRounds) {
      rounds++;
      this.ctrl = new AbortController();
      try {
        const res = await this.fetchFn(this.url, { headers: { authorization: `Bearer ${this.token}` }, signal: this.ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${String(res.status)}`);
        this.attempt = 0;
        this.onState(true);
        const parser = new SseParser((type, data) => {
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data) as unknown;
          } catch {
            /* keep raw */
          }
          this.onEvent(type, parsed);
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(dec.decode(value, { stream: true }));
        }
      } catch {
        /* reconnect below */
      }
      if (this.isStopped()) break;
      this.onState(false);
      this.attempt++;
      await this.sleep(Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6)));
    }
  }
}
