export interface MsgTokens {
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

export type SegmentId = "cached" | "prompt" | "think" | "out" | "reserved" | "free";

export interface Segment {
  id: SegmentId;
  /** tokens this segment occupies in the window */
  tokens: number;
}

export interface ContextState {
  /** occupied tokens = cached + prompt + think + out (matches opencode's total) */
  used: number;
  /** 0 when the model's context window is unknown */
  window: number;
  /** used / window, 0..100 */
  percent: number;
  /** nonzero segments, ordered: cached, prompt, think, out, reserved, free */
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
 * Split the (already-aggregated) token buckets of the latest assistant message
 * into the context-window bar: cached + prompt (incl. cache writes) + thinking +
 * output, then the model's reserved output headroom, then free space.
 * Multipliers of the same underlying tokens are never double-counted: `used`
 * matches opencode's own total (input + output + reasoning + cache.read + cache.write).
 */
export function computeContext(counts: MsgTokens, limits: WindowLimits | undefined, cost = 0): ContextState {
  const { input, output, reasoning, cacheRead, cacheWrite } = counts;
  const used = input + cacheRead + cacheWrite + reasoning + output;
  const window = limits && limits.context > 0 ? limits.context : 0;
  const reserved = limits && limits.output > 0 ? Math.max(0, limits.output - output) : 0;
  const free = window > 0 ? Math.max(0, window - used - reserved) : 0;

  const raw: Segment[] = [
    { id: "cached", tokens: cacheRead },
    { id: "prompt", tokens: input + cacheWrite },
    { id: "think", tokens: reasoning },
    { id: "out", tokens: output },
    { id: "reserved", tokens: reserved },
    { id: "free", tokens: free },
  ];

  return {
    used,
    window,
    percent: window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0,
    segments: raw.filter((segment) => segment.tokens > 0),
    cost,
    known: window > 0,
  };
}

/**
 * Convert segment token counts into a fixed-width char layout. `width` cells are
 * filled by segment in order (rounded, floored-adjust to hit the width exactly);
 * `free` always consumes whatever is left, so a 0-token gap renders as empty cells.
 */
export function segmentBar(segments: Segment[], window: number, width: number): { id: SegmentId; cells: number }[] {
  if (window <= 0 || width <= 0) return [];
  let remaining = width;
  const out: { id: SegmentId; cells: number }[] = [];
  let i = 0;
  for (; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.id === "free") break;
    const cells = Math.min(remaining, Math.round((segment.tokens / window) * width));
    if (cells > 0) out.push({ id: segment.id, cells });
    remaining -= cells;
  }
  if (remaining > 0) out.push({ id: "free", cells: remaining });
  return out;
}