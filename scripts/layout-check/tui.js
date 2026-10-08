// Load this CLI-only fixture after building; it exercises the host's renderer.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { jsx } from "@opentui/solid/jsx-runtime";
import plugin from "../../dist/tui.js";

const fixtures = [
  { name: "lopsided", input: 0, output: 0, reasoning: 5242, cached: 221100,
    window: 1048576, reserved: 524288, estimate: false,
    legend: "▍c221K ▍t5K ▍r524K ▍f298K" },
  { name: "sub-cell", input: 2500, output: 57, reasoning: 559, cached: 170000,
    window: 1000000, reserved: 384000, estimate: false,
    legend: "▍c170K ▍p3K ▍t559 ▍o57 ▍r384K ▍f443K" },
  { name: "estimates", input: 110000, output: 3000, reasoning: 500, cached: 40000,
    window: 200000, reserved: 8000, estimate: true,
    legend: "▍c40K ▍u25K ▍m15K ▍s70K ▍t500 ▍o3K ▍r5K ▍f42K" },
];

export default {
  id: "context-legend-layout-check",
  setup(context) {
    const panels = [];
    const checks = [];
    const disposers = [];
    for (const fixture of fixtures) {
      for (const width of [37, 24]) {
        const title = `${fixture.name} / ${width} cols`;
        const messages = [
          { type: "user", id: "u", text: "x".repeat(100000) },
          { type: "assistant", id: "a", model: { providerID: "fixture", id: "fixture" },
            tokens: { input: fixture.input, output: fixture.output, reasoning: fixture.reasoning,
              cache: { read: fixture.cached, write: 0 } },
            content: [{ type: "tool", state: { status: "completed", input: {},
              content: [{ type: "text", text: "x".repeat(60000) }] } }] },
        ];
        let render;
        disposers.push(plugin.setup({ ...context, options: { estimate: fixture.estimate },
          data: { ...context.data, on: () => () => {},
            session: { ...context.data.session, get: () => ({}), message: { list: () => messages }, cost: () => 0.02 },
            location: { ...context.data.location, model: { list: () => [{ providerID: "fixture", id: "fixture",
              limit: { context: fixture.window, output: fixture.reserved } }] } } },
          ui: { ...context.ui, slot: (claim) => { render = claim.render; return () => {}; } },
        }));
        checks.push({ title, width, legend: fixture.legend });
        panels.push(() => jsx("box", { width, flexShrink: 0, children: [
          jsx("text", { children: title }), render({ sessionID: "fixture" }), jsx("text", { children: "---" }),
        ] }));
      }
    }
    disposers.push(context.ui.slot({ append: "app", render: () => jsx("box", {
      position: "absolute", left: 0, top: 0, width: 80, height: 60, zIndex: 9999,
      backgroundColor: context.theme.background.base, children: panels.map((render) => render()),
    }) }));
    let captured = false;
    const capture = (buffer) => {
      if (captured || buffer.width < 80 || buffer.height < 60) return;
      const frame = Buffer.from(buffer.getRealCharBytes(true)).toString();
      const sections = frame.split(/^---\s*$/m);
      if (sections.length !== checks.length + 1) return;
      captured = true;
      let error;
      try {
        checks.forEach(({ title, width, legend }, index) => {
          const lines = sections[index].split("\n").map((line) => line.trimEnd());
          assert(lines.includes(title), title);
          const rows = lines.filter((line) => line.includes("▍"));
          assert.equal(rows.join(" "), legend, `${title}: intact labels, in order`);
          assert(rows.length <= 2, `${title}: compact legend`);
          assert(rows.every((row) => row.length <= width), `${title}: no overflow`);
          const last = lines.indexOf(rows.at(-1));
          assert.match(lines[last + 1], /^\d[\d,]* \/ /, `${title}: totals immediately below legend`);
        });
      } catch (cause) { error = String(cause); }
      writeFileSync(process.env.CONTEXT_LAYOUT_REPORT ?? "/tmp/opencode/context-layout-check.json",
        JSON.stringify({ passed: !error, error, checks: checks.length, frame }, null, 2));
    };
    context.renderer.addPostProcessFn(capture);
    return () => { context.renderer.removePostProcessFn(capture); for (const dispose of disposers) dispose?.(); };
  },
};
