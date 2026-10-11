/*
 * Demo clock (spec §15). The API owns time: Clock.now() = real time + demo_state.clockOffsetMs.
 * The mock world reads it from GET {API_URL}/api/demo/clock -> { now: RFC 3339 } and keeps the
 * offset, refreshing at most once per `refreshMs`. If the API is unreachable it falls back to real
 * time (offset 0) and says so in `source`.
 */

export interface Clock {
  now(): Promise<Date>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DemoClock implements Clock {
  private offsetMs = 0;
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private everReached = false;
  private warned = false;
  source: "api" | "api-stale" | "real-time-fallback" = "real-time-fallback";

  constructor(
    private readonly apiUrl: string,
    private readonly opts: {
      fetch?: FetchLike;
      refreshMs?: number;
      timeoutMs?: number;
      realNow?: () => number;
      onFallback?: (err: unknown) => void;
    } = {},
  ) {}

  private realNow(): number {
    return (this.opts.realNow ?? Date.now)();
  }

  private async refresh(): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    try {
      const res = await f(`${this.apiUrl}/api/demo/clock`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 800),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`demo clock HTTP ${res.status}`);
      const body = (await res.json()) as { now?: unknown };
      const t = typeof body.now === "string" ? Date.parse(body.now) : Number.NaN;
      if (!Number.isFinite(t)) throw new Error("demo clock: missing or invalid `now`");
      this.offsetMs = t - this.realNow();
      this.source = "api";
      this.everReached = true;
    } catch (err) {
      // Never reached the API: real time (offset 0). Reached before: keep the last known offset
      // so a transient API hiccup does not make demo time jump backwards.
      if (this.source !== "real-time-fallback" || !this.warned) this.opts.onFallback?.(err);
      this.warned = true;
      this.source = this.everReached ? "api-stale" : "real-time-fallback";
    } finally {
      this.fetchedAt = this.realNow();
    }
  }

  async now(): Promise<Date> {
    if (this.realNow() - this.fetchedAt >= (this.opts.refreshMs ?? 1000)) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    return new Date(this.realNow() + this.offsetMs);
  }
}

/** Test clock: time only moves when told to. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  async now(): Promise<Date> {
    return new Date(this.t);
  }
  set(iso: string | number): void {
    this.t = typeof iso === "number" ? iso : Date.parse(iso);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
