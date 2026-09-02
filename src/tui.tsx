import { createTextAttributes, type RGBA } from "@opentui/core";
import { createSignal } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import {
  computeContext,
  estimateTokens,
  formatCompactTokens,
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
  "cached", "user", "tools", "tool", "system", "prompt", "assistant", "other", "think", "out", "reserved", "free",
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
  tool: "m",
  system: "s",
  prompt: "p",
  assistant: "a",
  other: "x",
  think: "t",
  out: "o",
  reserved: "r",
  free: "f",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const intFmt = new Intl.NumberFormat("en-US");
// ponytail: single-number k, no decimals (was compact 1-decimal → c34.3k); use formatCompactTokens
const compact = (n: number) => formatCompactTokens(n);

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

/** web-ui parity: chars/4 estimates per `session-context-breakdown.ts` (system/user/assistant/tool) */
function collectEstimates(api: TuiPluginApi, sessionId: string): Estimates {
  let system = 0;
  let user = 0;
  let assistant = 0;
  let tool = 0;

  // system prompt: last user message's `system` field (web UI `findLast(...m.system)`)
  let systemPrompt: string | undefined;
  const messages = [...api.state.session.messages(sessionId)] as Array<{ id: string; role?: string; system?: string }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const s = messages[i]?.system?.trim();
    if (s) { systemPrompt = s; break; }
  }
  if (systemPrompt) system += estimateTokens(systemPrompt);

  for (const message of messages) {
    const role = (message as { role?: string }).role;
    try {
      for (const part of api.state.part((message as { id: string }).id)) {
        const p = part as {
          type?: string; text?: string;
          state?: { input?: unknown; output?: unknown; error?: unknown; raw?: string; status?: string };
          source?: { text?: { value: string }; value?: string };
        };
        // user parts: text / file / agent  (web: charsFromUserPart)
        if (role === "user") {
          if (p.type === "text") user += estimateTokens(p.text ?? "");
          else if (p.type === "file") user += estimateTokens(p.source?.text?.value ?? "");
          else if (p.type === "agent") user += estimateTokens(p.source?.value ?? "");
        } else if (role === "assistant") {
          // assistant text/reasoning → assistant; tool → tool  (web: charsFromAssistantPart)
          if (p.type === "text" || p.type === "reasoning") {
            assistant += estimateTokens(p.text ?? "");
          } else if (p.type === "tool") {
            const state = p.state as { input?: unknown; output?: unknown; error?: unknown; raw?: string; status?: string } | undefined;
            if (!state) continue;
            const inputKeys = state.input && typeof state.input === "object" ? Object.keys(state.input as object).length : 0;
            const inputChars = inputKeys * 16;
            let out = "";
            if (state.status === "pending") out = (state.raw as string) ?? "";
            else if (state.status === "completed") out = typeof state.output === "string" ? state.output : "";
            else if (state.status === "error") out = typeof state.error === "string" ? state.error : "";
            else {
              if (typeof state.output === "string") out = state.output;
              else if (typeof state.error === "string") out = state.error;
              else if (typeof state.raw === "string") out = state.raw;
            }
            // web counts input overhead + output length together
            const combined = "x".repeat(inputChars) + out;
            tool += estimateTokens(combined);
          }
        }
      }
    } catch {
      // never let an unreadable part break the whole panel
    }
  }
  return { system, user, assistant, tool, tools: tool };
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
      // web-ui categories: system/user/assistant/tool/other — reuse web's 5-way split for the prompt.
      // Up to 9 entries don't fit on one line, split into used buckets + window budget rows.
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
                  <text fg={theme.textMuted}>{SEGMENT_LABEL[item.id]}{compact(item.tokens)}</text>
                </box>
              );
            })}
          </box>
        );
      };
      const usedStart = 0;
      const usedIds: SegmentId[] = ["cached", "system", "user", "assistant", "tool", "other", "think", "out"];
      // alias: older data may still emit "tools" — fall back for cell counts
      const budgetStart = usedIds.reduce((sum, id) => sum + (cellsById.get(id) ?? (id === "tool" ? cellsById.get("tools" as SegmentId) ?? 0 : 0)), 0);
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
                <text fg={theme.textMuted}>{SEGMENT_LABEL[cell.id]}{compact(tokenById.get(cell.id) ?? 0)}</text>
              </box>
            );
          })}
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
  // ponytail: reuse web UI BREAKDOWN_COLOR mapping (system/user/assistant/tool/other)
  const base: Record<SegmentId, RGBA> = {
    cached: theme.success, prompt: theme.accent, think: theme.warning, out: theme.info,
    reserved: theme.textMuted, free: theme.text,
    user: theme.accent, tools: theme.accent, tool: theme.accent, system: theme.accent,
    assistant: theme.accent, other: theme.accent,
  };
  if (!estimate) return base[id];
  // web: system=info, user=success, assistant=secondary, tool=warning, other=comment
  const est: Partial<Record<SegmentId, RGBA>> = {
    system: theme.info,
    user: theme.success,
    assistant: theme.secondary,
    tool: theme.warning,
    tools: theme.warning,
    other: theme.textMuted,
    cached: theme.success,
    think: theme.secondary,
    out: theme.text,
    reserved: theme.textMuted,
    free: theme.borderSubtle,
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
