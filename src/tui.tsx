import { createTextAttributes, type RGBA } from "@opentui/core";
import { createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import {
  computeContext,
  createTpsTracker,
  estimateTokens,
  segmentBar,
  tokensOf,
  type ContextState,
  type Estimates,
  type SegmentId,
  type TpsTracker,
  type WindowLimits,
} from "./context.ts";

type Context = Plugin.Context;
type Theme = Context["theme"];
type Messages = ReturnType<Context["data"]["session"]["message"]["list"]>;
type AssistantMessage = Extract<Messages[number], { type: "assistant" }>;

interface PluginOptions {
  /** split the prompt bucket into user/tools/system using char-count estimates */
  estimate: boolean;
  /** segment ids to drop from the bar + legend */
  exclude: SegmentId[];
}

const VALID_SEGMENT_IDS: readonly SegmentId[] = [
  "cached", "user", "tools", "system", "prompt", "think", "out", "reserved", "free",
];

function normalizeOptions(raw: unknown): PluginOptions {
  const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const exclude = Array.isArray(obj.exclude)
    ? Array.from(new Set(obj.exclude.filter((id): id is SegmentId => typeof id === "string" && (VALID_SEGMENT_IDS as readonly string[]).includes(id))))
    : [];
  return {
    estimate: typeof obj.estimate === "boolean" ? obj.estimate : false,
    exclude,
  };
}

// Sidebar content is ~37 cols (width 42 - padding 2+2 - scrollbox 1); keep ~5
// for the right-aligned percent so the bar fills the column.
const BAR_WIDTH = 32;
const BOLD = createTextAttributes({ bold: true });
const SEGMENT_LABEL: Record<SegmentId, string> = {
  cached: "c",
  user: "u",
  tools: "m",
  system: "s",
  prompt: "p",
  think: "t",
  out: "o",
  reserved: "r",
  free: "f",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const intFmt = new Intl.NumberFormat("en-US");
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const plugin: Plugin.Definition = {
  id: "opencode-plugin-context",
  setup(context) {
    const config = normalizeOptions(context.options);
    // Reactive repaint: the signal is read inside the slot render so the host
    // re-renders it when we bump it. Session/message data is reactive on its
    // own, but live TPS lives outside that store.
    const [getRenderTick, setRenderTick] = createSignal(0);
    const repaint = () => setRenderTick((n) => n + 1);

    // Live TPS: token deltas are estimated with the same chars/4 heuristic the
    // panel already uses, tracked per session. Sub-token deltas are carried over
    // so a stream of 1-char chunks still counts.
    const trackers = new Map<string, TpsTracker>();
    const carries = new Map<string, number>();
    const trackerFor = (sessionId: string): TpsTracker => {
      let tracker = trackers.get(sessionId);
      if (!tracker) {
        tracker = createTpsTracker();
        trackers.set(sessionId, tracker);
        // ponytail: unbounded map; sessions are few, cap + LRU-evict if it ever churns.
      }
      return tracker;
    };
    const onDelta = (sessionId: string, text: string, at: number) => {
      const carry = (carries.get(sessionId) ?? 0) + text.length;
      const tokens = Math.floor(carry / 4);
      carries.set(sessionId, carry - tokens * 4);
      if (tokens > 0) trackerFor(sessionId).record(tokens, at);
      throttledRepaint();
    };

    // Token deltas arrive in ~10ms batches; throttle repaints so the sidebar
    // doesn't re-render once per chunk.
    let lastRepaint = 0;
    let pendingRepaint: ReturnType<typeof setTimeout> | undefined;
    const throttledRepaint = () => {
      const wait = lastRepaint + 50 - Date.now();
      if (wait <= 0) {
        lastRepaint = Date.now();
        repaint();
      } else if (pendingRepaint === undefined) {
        pendingRepaint = setTimeout(() => {
          pendingRepaint = undefined;
          lastRepaint = Date.now();
          repaint();
        }, wait);
      }
    };

    // Repaint on usage/status changes so the panel stays live between deltas.
    const unsubs = [
      context.data.on("session.text.delta", (event) => onDelta(event.data.sessionID, event.data.delta, event.created)),
      context.data.on("session.reasoning.delta", (event) => onDelta(event.data.sessionID, event.data.delta, event.created)),
      context.data.on("session.usage.updated", repaint),
      context.data.on("session.status", repaint),
      context.data.on("session.idle", repaint),
    ];

    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        getRenderTick(); // subscribe to repaint bumps (solid-reactive)
        return renderPanel(context, input.sessionID, config, trackers.get(input.sessionID));
      },
    });

    return () => {
      for (const unsub of unsubs) unsub();
      disposeSlot();
      if (pendingRepaint !== undefined) clearTimeout(pendingRepaint);
    };
  },
};

/**
 * Latest resolved assistant turn, matching the host's own sidebar context
 * block: the last assistant message carrying tokens that sits after the last
 * completed compaction and before the session's revert boundary.
 */
function latestAssistant(messages: Messages, revertMessageID?: string): AssistantMessage | undefined {
  let end = messages.length;
  if (revertMessageID) {
    const boundary = messages.findIndex((message) => message.id === revertMessageID);
    if (boundary === -1) return undefined;
    end = boundary;
  }
  let compaction = -1;
  for (let i = 0; i < end; i++) {
    const message = messages[i];
    if (message.type === "compaction" && message.status === "completed") compaction = i;
  }
  for (let i = end - 1; i > compaction; i--) {
    const message = messages[i];
    if (message.type === "assistant" && message.tokens !== undefined) return message;
  }
  return undefined;
}

/** char-count estimates of the visible prompt split, from message content (incl. MCP tool calls). */
function collectEstimates(messages: Messages): Estimates {
  let user = 0;
  let tools = 0;
  for (const message of messages) {
    if (message.type === "user") {
      user += estimateTokens(message.text ?? "");
      continue;
    }
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool") continue;
      const state = part.state;
      if (state.status === "streaming") {
        tools += estimateTokens(state.input);
        continue;
      }
      tools += estimateTokens(JSON.stringify(state.input));
      if (state.status === "completed") {
        for (const content of state.content) {
          if (content.type === "text") tools += estimateTokens(content.text);
        }
      } else if (state.status === "error") {
        tools += estimateTokens(state.error.message);
        for (const content of state.content ?? []) {
          if (content.type === "text") tools += estimateTokens(content.text);
        }
      }
    }
  }
  return { user, tools };
}

function sessionUsage(context: Context, sessionId: string, config: PluginOptions): ContextState {
  const session = context.data.session.get(sessionId);
  const messages = context.data.session.message.list(sessionId);
  const last = latestAssistant(messages, session?.revert?.messageID);
  const counts = tokensOf(last);

  let limits: WindowLimits | undefined;
  const lastModel = last?.model;
  if (lastModel) {
    const model = context.data.location.model
      .list(session?.location)
      ?.find((candidate) => candidate.providerID === lastModel.providerID && candidate.id === lastModel.id);
    if (model?.limit?.context) {
      limits = { context: model.limit.context, output: model.limit.output ?? 0 };
    }
  }

  const estimates = config.estimate ? collectEstimates(messages) : undefined;
  return computeContext(counts, limits, context.data.session.cost(sessionId), estimates, config.exclude);
}

function renderPanel(context: Context, sessionId: string, config: PluginOptions, tps?: TpsTracker): JSX.Element {
  const theme = context.theme;
  const usage = sessionUsage(context, sessionId, config);
  const header = <text fg={theme.text.base} attributes={BOLD}>Context</text>;

  const lines: JSX.Element[] = [header];
  const hasUsage = usage.used > 0;

  if (usage.known && hasUsage) {
    const bar = segmentBar(usage.segments, usage.window, BAR_WIDTH, config.exclude);
    lines.push(
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          {bar.map((cell) => (
            <text fg={segmentColor(cell.id, theme, config.estimate)}>
              {"━".repeat(cell.cells)}
            </text>
          ))}
        </box>
        <text fg={tierColor(usage.percent, theme)}>
          {` ${usage.percent}%`}
        </text>
      </box>,
    );
    if (config.estimate) {
      // Up to 8 marker+label entries don't fit the ~37-col sidebar on one line,
      // so the estimate view splits into used buckets + window budget rows.
      // Each row's marker sits at the cumulative bar offset of its segment so
      // they line up with the cells above.
      const cellsById = new Map(bar.map((cell) => [cell.id, cell.cells]));
      const tokenById = new Map(usage.segments.map((segment) => [segment.id, segment.tokens]));
      const row = (ids: SegmentId[], startAt: number) => {
        const items = ids
          .map((id) => ({ id, cells: cellsById.get(id) ?? 0, tokens: tokenById.get(id) ?? 0 }))
          .filter((item) => item.cells > 0 || item.tokens > 0);
        if (items.length === 0) return null;
        let cumulative = startAt;
        return (
          <box flexDirection="row">
            {items.map((item) => {
              const marginLeft = cumulative;
              cumulative += item.cells;
              return (
                <box flexDirection="row" marginLeft={marginLeft}>
                  <text fg={segmentColor(item.id, theme, true)}>▍</text>
                  <text fg={theme.text.muted}>{SEGMENT_LABEL[item.id]}{compactFmt.format(item.tokens)}</text>
                </box>
              );
            })}
          </box>
        );
      };
      const usedStart = 0;
      const usedIds: SegmentId[] = ["cached", "user", "tools", "system", "think", "out"];
      const budgetStart = usedIds.reduce((sum, id) => sum + (cellsById.get(id) ?? 0), 0);
      const usedLegend = row(usedIds, usedStart);
      const budgetLegend = row(["reserved", "free"], budgetStart);
      if (usedLegend) lines.push(usedLegend);
      if (budgetLegend) lines.push(budgetLegend);
    } else {
      const tokenById = new Map(usage.segments.map((segment) => [segment.id, segment.tokens]));
      let cumulative = 0;
      lines.push(
        <box flexDirection="row">
          {bar.map((cell) => {
            const marginLeft = cumulative;
            cumulative += cell.cells;
            return (
              <box flexDirection="row" marginLeft={marginLeft}>
                <text fg={segmentColor(cell.id, theme, false)}>▍</text>
                <text fg={theme.text.muted}>{SEGMENT_LABEL[cell.id]}{compactFmt.format(tokenById.get(cell.id) ?? 0)}</text>
              </box>
            );
          })}
        </box>,
      );
    }
  }

  if (hasUsage) {
    lines.push(
      <text fg={theme.text.muted}>
        {`${intFmt.format(usage.used)} / ${usage.known ? intFmt.format(usage.window) : "--"} tokens`}
      </text>,
    );
  } else {
    lines.push(<text fg={theme.text.muted}>no assistant turns yet</text>);
  }

  if (usage.cost > 0) {
    lines.push(<text fg={theme.text.muted}>{`${money.format(usage.cost)} spent`}</text>);
  }

  if (tps && tps.total() > 0) {
    const instant = tps.instant();
    const live = instant > 0.05;
    const avg = tps.average();
    lines.push(
      <box flexDirection="row">
        {live ? <text fg={speedColor(instant, theme)}>{`${instant.toFixed(1)} TPS`}</text> : null}
        <text fg={theme.text.muted}>
          {live
            ? ` · avg ${avg.toFixed(1)} · ${formatDuration(tps.elapsed())}`
            : `avg ${avg.toFixed(1)} TPS · ${formatDuration(tps.elapsed())}`}
        </text>
      </box>,
    );
  }

  return <box width="100%" flexDirection="column">{lines}</box>;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

function speedColor(tps: number, theme: Theme): RGBA {
  if (tps < 10) return theme.text.feedback.error.base;
  if (tps < 50) return theme.text.feedback.warning.base;
  return theme.text.feedback.success.base;
}

function segmentColor(id: SegmentId, theme: Theme, estimate: boolean): RGBA {
  const base: Record<SegmentId, RGBA> = {
    cached: theme.text.feedback.success.base,
    prompt: theme.hue.accent[500],
    think: theme.text.feedback.warning.base,
    out: theme.text.feedback.info.base,
    reserved: theme.text.muted,
    free: theme.text.base,
    user: theme.hue.accent[500],
    tools: theme.hue.accent[500],
    system: theme.text.feedback.warning.base,
  };
  if (!estimate) return base[id];
  const est: Partial<Record<SegmentId, RGBA>> = {
    user: theme.text.feedback.info.base,
    tools: theme.hue.accent[500],
    system: theme.text.feedback.warning.base,
    think: theme.hue.purple[500],
    out: theme.text.base,
    free: theme.border.base,
  };
  return est[id] ?? base[id];
}

function tierColor(percent: number, theme: Theme): RGBA {
  if (percent >= 100) return theme.text.feedback.error.base;
  if (percent >= 75) return theme.text.feedback.warning.base;
  if (percent >= 50) return theme.hue.accent[500];
  return theme.text.feedback.success.base;
}

export default plugin;
