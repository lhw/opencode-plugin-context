import { createTextAttributes, type RGBA } from "@opentui/core";
import { createSignal } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import {
  computeContext,
  estimateTokens,
  segmentBar,
  tokensOf,
  type ContextState,
  type Estimates,
  type SegmentId,
  type WindowLimits,
} from "./context.ts";

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
const SLOT_ORDER = 60;
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

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-plugin-context",
  tui: async (api, rawOptions) => {
    const config = normalizeOptions(rawOptions);
    // Reactive repaint: solid signal read inside the slot so the host re-renders
    // it when we bump it (api.renderer.requestRender alone does not repaint here).
    const [getRenderTick, setRenderTick] = createSignal(0);
    const repaint = () => {
      setRenderTick((n) => n + 1);
      api.renderer.requestRender();
    };

    const unsubs = [
      api.event.on("message.updated", repaint),
      api.event.on("message.part.updated", repaint),
      api.event.on("message.part.removed", repaint),
      api.event.on("message.removed", repaint),
      api.event.on("session.updated", repaint),
      api.event.on("session.compacted", repaint),
      api.event.on("session.status", repaint),
      api.event.on("session.idle", repaint),
    ];
    // Self-heal: some token updates land without an event we subscribed to
    // (e.g. loader finishes), so just repaint on an interval.
    const repaintTimer = setInterval(repaint, 2_000);

    api.lifecycle.onDispose(() => {
      for (const unsub of unsubs) unsub();
      clearInterval(repaintTimer);
    });

    api.slots.register({
      order: SLOT_ORDER,
      slots: {
        sidebar_content(_ctx, props) {
          getRenderTick(); // subscribe to repaint bumps (solid-reactive)
          return renderPanel(api, props.session_id, config);
        },
      },
    });
  },
};

/** char-count estimates of the visible prompt split, from message parts (incl. MCP tool calls). */
function collectEstimates(api: TuiPluginApi, sessionId: string): Estimates {
  let user = 0;
  let tools = 0;
  for (const message of api.state.session.messages(sessionId)) {
    const role = (message as { role?: string }).role;
    try {
      for (const part of api.state.part((message as { id: string }).id)) {
        const p = part as { type?: string; text?: string; state?: { input?: unknown; output?: unknown; error?: unknown } };
        if (p.type === "text" && role === "user") {
          user += estimateTokens(p.text ?? "");
        } else if (p.type === "tool") {
          const state = p.state;
          if (!state) continue;
          if (state.input !== undefined) tools += estimateTokens(JSON.stringify(state.input));
          if (typeof state.output === "string") tools += estimateTokens(state.output);
          else if (typeof state.error === "string") tools += estimateTokens(state.error);
        }
      }
    } catch {
      // never let an unreadable part break the whole panel
    }
  }
  return { user, tools };
}

function sessionUsage(api: TuiPluginApi, sessionId: string, config: PluginOptions): ContextState {
  const messages = api.state.session.messages(sessionId);
  // Latest resolved assistant turn: matches what opencode itself reports.
  let last: { tokens?: unknown; providerID?: string; modelID?: string; cost?: number } | undefined;
  for (const message of messages) {
    const m = message as { role?: string; tokens?: { output?: number } };
    if (m.role === "assistant" && (m.tokens?.output ?? 0) > 0) {
      last = {
        tokens: m.tokens,
        providerID: (message as { providerID?: string }).providerID,
        modelID: (message as { modelID?: string }).modelID,
        cost: (message as { cost?: number }).cost,
      };
    }
  }

  const session = api.state.session.get(sessionId) as { cost?: number } | undefined;
  const cost =
    session?.cost ??
    messages.reduce((sum, message) => {
      if ((message as { role?: string }).role === "assistant") sum += (message as { cost?: number }).cost ?? 0;
      return sum;
    }, 0);

  const counts = tokensOf(last as { tokens?: unknown });
  let limits: WindowLimits | undefined;
  if (last?.providerID && last.modelID) {
    const model = api.state.provider.find((p) => p.id === last.providerID)?.models[last.modelID];
    if (model?.limit?.context) {
      limits = { context: model.limit.context, output: model.limit.output ?? 0 };
    }
  }
  const estimates = config.estimate ? collectEstimates(api, sessionId) : undefined;
  return computeContext(counts, limits, cost, estimates, config.exclude);
}

function renderPanel(api: TuiPluginApi, sessionId: string, config: PluginOptions): JSX.Element {
  const theme = api.theme.current;
  const usage = sessionUsage(api, sessionId, config);
  const header = <text fg={theme.text} attributes={BOLD}>Context</text>;

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
      const legend = (ids: SegmentId[]) => {
        const entries = usage.segments.filter((segment) => ids.includes(segment.id));
        if (entries.length === 0) return null;
        return (
          <box flexDirection="row">
            {entries.map((segment) => (
              <box flexDirection="row">
                <text fg={segmentColor(segment.id, theme, true)}>▍</text>
                <text fg={theme.textMuted}>{SEGMENT_LABEL[segment.id]}{compactFmt.format(segment.tokens)}</text>
              </box>
            ))}
          </box>
        );
      };
      const usedLegend = legend(["cached", "user", "tools", "system", "think", "out"]);
      const budgetLegend = legend(["reserved", "free"]);
      if (usedLegend) lines.push(usedLegend);
      if (budgetLegend) lines.push(budgetLegend);
    } else {
      lines.push(
        <box flexDirection="row" gap={1}>
          {usage.segments.map((segment) => (
            <box flexDirection="row">
              <text fg={segmentColor(segment.id, theme, false)}>▍</text>
              <text fg={theme.textMuted}>{SEGMENT_LABEL[segment.id]}{compactFmt.format(segment.tokens)}</text>
            </box>
          ))}
        </box>,
      );
    }
  }

  if (hasUsage) {
    lines.push(
      <text fg={theme.textMuted}>
        {`${intFmt.format(usage.used)} / ${usage.known ? intFmt.format(usage.window) : "--"} tokens`}
      </text>,
    );
  } else {
    lines.push(<text fg={theme.textMuted}>no assistant turns yet</text>);
  }

  if (usage.cost > 0) {
    lines.push(<text fg={theme.textMuted}>{`${money.format(usage.cost)} spent`}</text>);
  }

  return <box width="100%" flexDirection="column">{lines}</box>;
}

function segmentColor(id: SegmentId, theme: TuiPluginApi["theme"]["current"], estimate: boolean): RGBA {
  const base: Record<SegmentId, RGBA> = {
    cached: theme.success, prompt: theme.accent, think: theme.warning, out: theme.info,
    reserved: theme.textMuted, free: theme.text,
    user: theme.accent, tools: theme.accent, system: theme.accent,
  };
  if (!estimate) return base[id];
  const est: Partial<Record<SegmentId, RGBA>> = {
    user: theme.info, tools: theme.accent, system: theme.warning,
    think: theme.secondary, out: theme.text, free: theme.borderSubtle,
  };
  return est[id] ?? base[id];
}

function tierColor(percent: number, theme: TuiPluginApi["theme"]["current"]): RGBA {
  if (percent >= 100) return theme.error;
  if (percent >= 75) return theme.warning;
  if (percent >= 50) return theme.accent;
  return theme.success;
}

export default plugin;
