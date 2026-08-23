// Self-check for the pure context-window math (src/context.ts). Node >= 22.6.
import assert from "node:assert/strict";
import { computeContext, estimateTokens, segmentBar, tokensOf } from "../src/context.ts";

const ok = (name, fn) => {
  fn();
  console.log(`ok - ${name}`);
};

ok("tokensOf missing fields", () => {
  const t = tokensOf(undefined);
  assert.deepEqual(t, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(tokensOf({ tokens: { input: 5, output: 3, cache: { read: 2 } } }), {
    input: 5, output: 3, reasoning: 0, cacheRead: 2, cacheWrite: 0,
  });
});

ok("computeContext typical", () => {
  const counts = { input: 60_000, output: 2_000, reasoning: 500, cacheRead: 20_000, cacheWrite: 30_000 };
  const s = computeContext(counts, { context: 200_000, output: 8_000 });
  assert.equal(s.used, 112_500);
  assert.equal(s.window, 200_000);
  assert.equal(s.percent, 56);
  assert.equal(s.known, true);
  assert.deepEqual(s.segments, [
    { id: "cached", tokens: 20_000 },
    { id: "prompt", tokens: 90_000 },
    { id: "think", tokens: 500 },
    { id: "out", tokens: 2_000 },
    { id: "reserved", tokens: 6_000 },
    { id: "free", tokens: 81_500 },
  ]);
});

ok("computeContext unknown window", () => {
  const s = computeContext({ input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, undefined);
  assert.equal(s.window, 0);
  assert.equal(s.known, false);
  assert.equal(s.percent, 0);
  assert.deepEqual(s.segments, [
    { id: "prompt", tokens: 100 },
    { id: "out", tokens: 50 },
  ]);
});

ok("computeContext empty", () => {
  const s = computeContext({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, { context: 200_000, output: 8_000 });
  assert.equal(s.used, 0);
  assert.deepEqual(s.segments, [
    { id: "reserved", tokens: 8_000 },
    { id: "free", tokens: 192_000 },
  ]);
});

ok("computeContext overflow clamps to 100%", () => {
  const s = computeContext({ input: 250_000, output: 3_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, { context: 200_000, output: 8_000 });
  assert.equal(s.percent, 100);
  assert.equal(s.segments.some((segment) => segment.id === "free"), false);
  assert.equal(s.segments.find((segment) => segment.id === "reserved")?.tokens, 5_000);
});

ok("segmentBar fills exactly", () => {
  const s = computeContext({ input: 60_000, output: 2_000, reasoning: 500, cacheRead: 20_000, cacheWrite: 30_000 }, { context: 200_000, output: 8_000 });
  const bar = segmentBar(s.segments, s.window, 20);
  assert.deepEqual(bar, [
    { id: "cached", cells: 2 },
    { id: "prompt", cells: 9 },
    { id: "reserved", cells: 1 },
    { id: "free", cells: 8 },
  ]);
  assert.equal(bar.reduce((n, cell) => n + cell.cells, 0), 20);
});

ok("segmentBar empty / unknown", () => {
  assert.deepEqual(segmentBar([], 100, 20), [{ id: "free", cells: 20 }]);
  assert.deepEqual(segmentBar([{ id: "prompt", tokens: 10 }], 0, 20), []);
});

ok("segmentBar exclude drops re-appended free", () => {
  assert.deepEqual(segmentBar([{ id: "prompt", tokens: 10 }], 100, 20, ["free"]), [
    { id: "prompt", cells: 2 },
  ]);
});

ok("estimateTokens chars/4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefghij"), 3);
});

ok("computeContext with estimates splits prompt", () => {
  const counts = { input: 100_000, output: 2_000, reasoning: 500, cacheRead: 20_000, cacheWrite: 10_000 };
  const s = computeContext(counts, { context: 200_000, output: 8_000 }, 0, { user: 25_000, tools: 15_000 });
  assert.equal(s.used, 132_500);
  assert.deepEqual(s.segments, [
    { id: "cached", tokens: 20_000 },
    { id: "user", tokens: 25_000 },
    { id: "tools", tokens: 15_000 },
    // prompt bucket (input 100k + cacheWrite 10k) minus user+tools
    { id: "system", tokens: 70_000 },
    { id: "think", tokens: 500 },
    { id: "out", tokens: 2_000 },
    { id: "reserved", tokens: 6_000 },
    { id: "free", tokens: 61_500 },
  ]);
});

ok("computeContext estimates clamp system at 0", () => {
  const counts = { input: 40_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const s = computeContext(counts, { context: 100_000, output: 4_000 }, 0, { user: 35_000, tools: 30_000 });
  assert.equal(s.segments.some((segment) => segment.id === "system"), false);
});

ok("computeContext exclude drops segments", () => {
  const counts = { input: 100_000, output: 2_000, reasoning: 500, cacheRead: 20_000, cacheWrite: 10_000 };
  const s = computeContext(counts, { context: 200_000, output: 8_000 }, 0, { user: 25_000, tools: 15_000 }, ["system", "reserved"]);
  assert.equal(s.segments.some((segment) => segment.id === "system"), false);
  assert.equal(s.segments.some((segment) => segment.id === "reserved"), false);
  assert.equal(s.segments.some((segment) => segment.id === "free"), true);
});

console.log("\nall checks passed");