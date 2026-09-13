interface MsgTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface WindowLimits {
  /** model context window (tokens) */
  context: number;
  /** model max output tokens (tokens) */
  output: number;
}

export type SegmentId =
  | "cached"
  | "user"
  | "tools"
  | "system"
  | "prompt"
  | "think"
  | "out"
  | "reserved"
  | "free";

interface Segment {
  id: SegmentId;
  /** tokens this segment occupies in the window */
  tokens: number;
}

/** char-count based estimates of the visible prompt split (user input vs tool calls+results) */
export interface Estimates {
  user: number;
  tools: number;
}

export interface ContextState {
  /** occupied tokens = cached + prompt + think + out (matches opencode's total) */
  used: number;
  /** 0 when the model's context window is unknown */
  window: number;
  /** used / window, 0..100 */
  percent: number;
  /** nonzero segments, ordered, excluding any ids in `exclude` */
  segments: Segment[];
  /** total session cost (USD) */
  cost: number;
  /** whether the window was known (bar renderable) */
  known: boolean;
}

export function tokensOf(m: { tokens?: unknown } | undefined): MsgTokens {
  const t = record(m?.tokens);
  const cache = record(t.cache);
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * Same chars-per-token heuristic opencode itself uses for compaction decisions
 * (`packages/core/src/util/token.ts`). Estimates, not exact tokenization.
 */
export function estimateTokens(input: string): number {
  return Math.max(0, Math.round(input.length / 4));
}

/**
 * Split the (already-aggregated) token buckets of the latest assistant message
 * into the context-window bar: cached + prompt (incl. cache writes) + thinking +
 * output, then the model's reserved output headroom, then free space.
 * Multipliers of the same underlying tokens are never double-counted: `used`
 * matches opencode's own total (input + output + reasoning + cache.read + cache.write).
 *
 * When `estimates` is given, the `prompt` bucket is split into user input / tool
 * calls+results (both estimated from visible parts) and the remaining `system`
 * bucket (system prompt + tool definitions + everything else opencode doesn't
 * expose). `exclude` drops segments from the result entirely.
 */
export function computeContext(
  counts: MsgTokens,
  limits: WindowLimits | undefined,
  cost = 0,
  estimates?: Estimates,
  exclude: readonly SegmentId[] = [],
): ContextState {
  const { input, output, reasoning, cacheRead, cacheWrite } = counts;
  const used = input + cacheRead + cacheWrite + reasoning + output;
  const window = limits && limits.context > 0 ? limits.context : 0;
  const reserved = limits && limits.output > 0 ? Math.max(0, limits.output - output) : 0;
  const free = window > 0 ? Math.max(0, window - used - reserved) : 0;
  const prompt = input + cacheWrite;

  const raw: Segment[] = estimates
    ? [
        { id: "cached", tokens: cacheRead },
        { id: "user", tokens: estimates.user },
        { id: "tools", tokens: estimates.tools },
        { id: "system", tokens: Math.max(0, prompt - estimates.user - estimates.tools) },
        { id: "think", tokens: reasoning },
        { id: "out", tokens: output },
        { id: "reserved", tokens: reserved },
        { id: "free", tokens: free },
      ]
    : [
        { id: "cached", tokens: cacheRead },
        { id: "prompt", tokens: prompt },
        { id: "think", tokens: reasoning },
        { id: "out", tokens: output },
        { id: "reserved", tokens: reserved },
        { id: "free", tokens: free },
      ];

  return {
    used,
    window,
    percent: window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0,
    segments: raw.filter((segment) => segment.tokens > 0 && !exclude.includes(segment.id)),
    cost,
    known: window > 0,
  };
}

export interface TpsTracker {
  /** record `count` tokens stamped at `timestamp` (host clock; defaults to now) */
  record(count: number, timestamp?: number): void;
  /** smoothed instantaneous tokens/sec, 0 once the window has gone quiet */
  instant(): number;
  /** average tokens/sec over the active generation span (first → last token) */
  average(): number;
  /** total tokens recorded */
  total(): number;
  /** active generation span in ms (first → last token) */
  elapsed(): number;
  reset(): void;
}

export interface TpsTrackerOptions {
  /** rolling window for the instantaneous rate (ms) */
  windowMs?: number;
  /** EWMA half-life for smoothing the instantaneous rate (ms) */
  halfLifeMs?: number;
}

const MIN_WINDOW_SECONDS = 0.3;
const MAX_INITIAL_TPS = 100;

/**
 * Rolling tokens-per-second tracker (same idea as opencode-tps-meter, trimmed
 * down): records token counts stamped with the host clock and reports a
 * smoothed instantaneous rate over `windowMs`. The average uses the active span
 * (first → last token) rather than wall time, so idle time doesn't drag it to 0.
 */
export function createTpsTracker(options: TpsTrackerOptions = {}): TpsTracker {
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : 1000;
  const halfLifeMs = options.halfLifeMs && options.halfLifeMs > 0 ? options.halfLifeMs : 250;
  let samples: { t: number; count: number }[] = [];
  let total = 0;
  let start = -1;
  let last = -1;
  let smoothed = 0;
  let smoothedAt = 0;
  let hasSmoothed = false;

  function raw(now: number): number {
    if (samples.length === 0) return 0;
    const cutoff = now - windowMs;
    let tokens = 0;
    let oldest = now;
    for (const sample of samples) {
      if (sample.t >= cutoff) {
        tokens += sample.count;
        if (sample.t < oldest) oldest = sample.t;
      }
    }
    if (tokens === 0) return 0;
    // Denominator runs from the oldest in-window token to `now`, so a burst
    // followed by idle decays naturally instead of reading as a spike.
    return tokens / Math.max((now - oldest) / 1000, MIN_WINDOW_SECONDS);
  }

  return {
    record(count, timestamp) {
      if (!(count > 0)) return;
      const t = timestamp ?? Date.now();
      if (start < 0) start = t;
      if (t > last) last = t;
      total += count;
      samples.push({ t, count });
      const cutoff = t - windowMs;
      let drop = 0;
      while (drop < samples.length && samples[drop].t < cutoff) drop++;
      if (drop > 0) samples = samples.slice(drop);
      const value = raw(t);
      if (!hasSmoothed) {
        smoothed = Math.min(value, MAX_INITIAL_TPS);
        hasSmoothed = true;
      } else {
        const dt = Math.max(1, t - smoothedAt);
        const alpha = Math.exp((-Math.LN2 * dt) / halfLifeMs);
        smoothed = alpha * smoothed + (1 - alpha) * value;
      }
      smoothedAt = t;
    },
    instant() {
      if (!hasSmoothed || Date.now() - last > windowMs) return 0;
      return smoothed;
    },
    average() {
      return start < 0 ? 0 : total / Math.max((last - start) / 1000, MIN_WINDOW_SECONDS);
    },
    total() {
      return total;
    },
    elapsed() {
      return start < 0 ? 0 : last - start;
    },
    reset() {
      samples = [];
      total = 0;
      start = -1;
      last = -1;
      smoothed = 0;
      smoothedAt = 0;
      hasSmoothed = false;
    },
  };
}

/**
 * Convert segment token counts into a fixed-width char layout. `width` cells are
 * filled by segment in order (rounded, floored-adjust to hit the width exactly);
 * `free` always consumes whatever is left, so a 0-token gap renders as empty cells.
 */
export function segmentBar(
  segments: Segment[],
  window: number,
  width: number,
  exclude: readonly SegmentId[] = [],
): { id: SegmentId; cells: number }[] {
  if (window <= 0 || width <= 0) return [];
  let remaining = width;
  const out: { id: SegmentId; cells: number }[] = [];
  for (const segment of segments) {
    if (segment.id === "free") break;
    const cells = Math.min(remaining, Math.round((segment.tokens / window) * width));
    if (cells > 0) out.push({ id: segment.id, cells });
    remaining -= cells;
  }
  // `free` is re-appended from leftover width, so an excluded "free" must be
  // suppressed here — the input `segments` are already filtered upstream.
  if (remaining > 0 && !exclude.includes("free")) out.push({ id: "free", cells: remaining });
  return out;
}