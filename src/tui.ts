import { createElement, insert, setProp } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
  computeContext,
  estimateTokens,
  segmentBar,
  tokensOf,
  type ContextState,
  type Estimates,
  type SegmentId,
} from "./context.ts";

type Child = JSX.Element | string | number | null | undefined | false;

interface BarCell {
  id: SegmentId;
  cells: number;
}

export interface PluginOptions {
  /** split the prompt bucket into user/tools/system using char-count estimates */
  estimate: boolean;
  /** segment ids to drop from the bar + legend */
  exclude: SegmentId[];
}

const VALID_SEGMENT_IDS: readonly SegmentId[] = [
  "cached", "user", "tools", "system", "prompt", "think", "out", "reserved", "free",
];

function normalizeOptions(raw: unknown): PluginOptions {
  const obj = isRecord(raw) ? raw : {};
  const exclude = Array.isArray(obj.exclude)
    ? Array.from(new Set(obj.exclude.filter((id): id is SegmentId => typeof id === "string" && (VALID_SEGMENT_IDS as readonly string[]).includes(id))))
    : [];
  return {
    estimate: typeof obj.estimate === "boolean" ? obj.estimate : true,
    exclude,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  let limits: { context: number; output: number } | undefined;
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
  const header: Child[] = [text({ fg: theme.text, attributes: BOLD }, ["Context"])];

  const lines: Child[] = [header];
  const hasUsage = usage.used > 0;

  if (usage.known && hasUsage) {
    const bar: BarCell[] = segmentBar(usage.segments, usage.window, BAR_WIDTH).filter(
      (cell) => !config.exclude.includes(cell.id),
    );
    lines.push(
      box({ flexDirection: "row", justifyContent: "space-between" }, [
        box({ flexDirection: "row" }, bar.map((cell) => text({ fg: segmentColor(cell.id, theme) }, ["━".repeat(cell.cells)]))),
        text({ fg: tierColor(usage.percent, theme) }, [` ${usage.percent}%`]),
      ]),
    );
    lines.push(
      box({ flexDirection: "row", gap: 1 }, usage.segments.map((segment) =>
        box({ flexDirection: "row" }, [
          text({ fg: segmentColor(segment.id, theme) }, ["▍"]),
          text({ fg: theme.textMuted }, [`${SEGMENT_LABEL[segment.id]}${formatCompact(segment.tokens)}`]),
        ]),
      )),
    );
  }

  if (hasUsage) {
    lines.push(
      text({ fg: theme.textMuted }, [
        `${formatInt(usage.used)} / ${usage.known ? formatInt(usage.window) : "--"} tokens`,
      ]),
    );
  } else {
    lines.push(text({ fg: theme.textMuted }, ["no assistant turns yet"]));
  }

  if (usage.cost > 0) {
    lines.push(text({ fg: theme.textMuted }, [`${money.format(usage.cost)} spent`]));
  }

  return box({ width: "100%", flexDirection: "column" }, lines);
}

function segmentColor(id: SegmentId, theme: TuiPluginApi["theme"]["current"]): unknown {
  switch (id) {
    case "cached": return theme.success;
    case "user": return theme.info;
    case "tools": return theme.accent;
    case "system": return theme.warning;
    case "prompt": return theme.accent;
    case "think": return theme.secondary;
    case "out": return theme.text;
    case "reserved": return theme.textMuted;
    case "free": return theme.borderSubtle;
  }
}

function tierColor(percent: number, theme: TuiPluginApi["theme"]["current"]): unknown {
  if (percent >= 100) return theme.error;
  if (percent >= 75) return theme.warning;
  if (percent >= 50) return theme.accent;
  return theme.success;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function element(tag: string, props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) insert(node, child);
  }
  return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("text", props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("box", props, children);
}

export default plugin;