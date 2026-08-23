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