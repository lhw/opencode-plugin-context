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
  | "tool"
  | "system"
  | "prompt"
  | "assistant"
  | "other"
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
  /** optional web-ui categories — when present, `computeContext` uses web-style scaling */
  system?: number;
  assistant?: number;
  tool?: number;
  other?: number;
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
 * Matches web UI `estimateTokens = ceil(chars/4)` in `session-context-breakdown.ts`.
 */
export function estimateTokens(input: string): number {
  return Math.max(0, Math.ceil(input.length / 4));
}

/** Compact legend formatter — single-number `k`, no decimals, min `1k` for <1000. */
export function formatCompactTokens(tokens: number): string {
  if (tokens <= 0) return "0";
  const k = Math.round(tokens / 1000);
  return `${Math.max(1, k)}k`;
}

/** Port of web UI `estimateSessionContextBreakdown` scaling (char estimates → prompt budget). */
function scaleToPrompt(
  raw: { system: number; user: number; assistant: number; tool: number },
  prompt: number,
): { system: number; user: number; assistant: number; tool: number; other: number } {
  const estimated = raw.system + raw.user + raw.assistant + raw.tool;
  if (estimated <= prompt) {
    return { ...raw, other: prompt - estimated };
  }
  const scale = prompt / estimated;
  const scaled = {
    system: Math.floor(raw.system * scale),
    user: Math.floor(raw.user * scale),
    assistant: Math.floor(raw.assistant * scale),
    tool: Math.floor(raw.tool * scale),
  };
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool;
  return { ...scaled, other: Math.max(0, prompt - total) };
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

  const normalizeExclude = (id: SegmentId) => {
    // alias: "tools" and "tool" are the same bucket
    if (id === "tools" || id === "tool") return exclude.includes("tools") || exclude.includes("tool");
    return exclude.includes(id);
  };
  const excluded = (id: SegmentId) => normalizeExclude(id);

  let raw: Segment[];
  if (estimates) {
    // web-ui categories: if caller provides system/assistant/tool use scaled breakdown (reuse web logic)
    const hasWebCats = estimates.system !== undefined || estimates.assistant !== undefined || estimates.tool !== undefined;
    if (hasWebCats) {
      const rawTokens = {
        system: Math.max(0, estimates.system ?? 0),
        user: Math.max(0, estimates.user ?? 0),
        assistant: Math.max(0, estimates.assistant ?? 0),
        tool: Math.max(0, estimates.tool ?? estimates.tools ?? 0),
      };
      const scaled = scaleToPrompt(rawTokens, prompt);
      raw = [
        { id: "cached", tokens: cacheRead },
        { id: "system", tokens: scaled.system },
        { id: "user", tokens: scaled.user },
        { id: "assistant", tokens: scaled.assistant },
        { id: "tool", tokens: scaled.tool },
        { id: "other", tokens: scaled.other },
        { id: "think", tokens: reasoning },
        { id: "out", tokens: output },
        { id: "reserved", tokens: reserved },
        { id: "free", tokens: free },
      ];
    } else {
      // legacy: user + tools, remainder is system
      raw = [
        { id: "cached", tokens: cacheRead },
        { id: "user", tokens: estimates.user },
        { id: "tools", tokens: estimates.tools },
        { id: "system", tokens: Math.max(0, prompt - estimates.user - estimates.tools) },
        { id: "think", tokens: reasoning },
        { id: "out", tokens: output },
        { id: "reserved", tokens: reserved },
        { id: "free", tokens: free },
      ];
    }
  } else {
    raw = [
      { id: "cached", tokens: cacheRead },
      { id: "prompt", tokens: prompt },
      { id: "think", tokens: reasoning },
      { id: "out", tokens: output },
      { id: "reserved", tokens: reserved },
      { id: "free", tokens: free },
    ];
  }

  // legacy "tools" ↔ "tool" alias: filter uses normalized check
  const filtered = raw.filter((segment) => segment.tokens > 0 && !excluded(segment.id));

  return {
    used,
    window,
    percent: window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0,
    segments: filtered,
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