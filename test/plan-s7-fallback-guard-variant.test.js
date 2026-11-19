import assert from "node:assert/strict";
import test from "node:test";
import { runAnalysis, variantFor } from "../src/core.js";
import { createGuard } from "../src/guard.js";

// Plan S7 (review items B4, B5): a loop trip on one model moves on to the next model (a budget trip still
// stops everything); cached prompt tokens do not count toward maxInputTokens; the reasoning variant is no
// longer forced to "low" for real work (probes may still use it to stay cheap).

const failingRead = (path) => ({ type: "tool", tool: "read", status: "error", error: "ENOENT", input: { path } });

/** A runner whose model loops: it reports the same failing tool call until the shared guard trips. */
function loopingThen(answers) {
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    const next = answers[calls.length - 1];
    if (next === "loop") {
      let verdict;
      for (let i = 0; i < 5 && !verdict; i++) verdict = call.guardState.observe(failingRead("missing.ts"));
      return { status: "failed", error: verdict.kind, guard: verdict };
    }
    if (next === "budget") {
      const verdict = call.guardState.observe({ type: "usage", usage: { inputTokens: 999_999_999, uncachedInputTokens: 999_999_999, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      return { status: "failed", error: verdict.kind, guard: verdict };
    }
    return { status: "ok", text: next, sessionID: "ses_x" };
  };
  return { runner, calls };
}

const models = [{ id: "opencode/a-free", variants: ["low", "high"] }, { id: "opencode/b-free", variants: ["low", "high"] }, { id: "opencode/c-free" }];
const base = { directory: process.cwd(), prompt: "Explain", maxWords: 60, budgetMs: 60_000, codeMap: false };

test("S7: a loop trip on the first model moves on to the next model", async () => {
  const { runner, calls } = loopingThen(["loop", "answer from b"]);
  const result = await runAnalysis({ ...base, runner, models });
  assert.equal(result.text, "answer from b", JSON.stringify(result));
  assert.equal(result.model, "opencode/b-free");
  assert.equal(calls.length, 2);
  assert.equal(result.attempts[0].status, "failed");
  assert.match(String(result.attempts[0].reason), /loop_detected/);
});

test("S7: the next model starts with a fresh loop window but keeps the cumulative counters", async () => {
  const { runner, calls } = loopingThen(["loop", "loop", "answer from c"]);
  const result = await runAnalysis({ ...base, runner, models });
  assert.equal(result.text, "answer from c", JSON.stringify(result));
  assert.equal(calls.length, 3);
  assert.ok(result.guard.totalToolCalls >= 6, "tool calls of every model still count toward the shared budget");
});

test("S7: a budget trip still stops without trying another model", async () => {
  const { runner, calls } = loopingThen(["budget", "answer from b"]);
  const result = await runAnalysis({ ...base, runner, models });
  assert.equal(calls.length, 1);
  assert.equal(result.error, "budget_exceeded");
});

test("S7: cached prompt tokens do not count toward maxInputTokens", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  const verdict = guard.observe({ type: "usage", usage: { inputTokens: 202_000, uncachedInputTokens: 2_000, cacheReadTokens: 200_000, cacheWriteTokens: 0 } });
  assert.equal(verdict, null, "200k cache reads + 2k fresh tokens must not trip a 50k budget");
  assert.equal(guard.snapshot().kind, undefined);
});

test("S7: fresh and cache-write tokens still count, so a real overrun trips", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  const verdict = guard.observe({ type: "usage", usage: { inputTokens: 260_000, uncachedInputTokens: 40_000, cacheReadTokens: 200_000, cacheWriteTokens: 20_000 } });
  assert.equal(verdict?.kind, "budget_exceeded");
});

test("S7: analysis runs use the model's default reasoning variant, not a forced low", async () => {
  const { runner, calls } = loopingThen(["answer"]);
  await runAnalysis({ ...base, runner, models });
  assert.equal(calls[0].variant, undefined);
});

test("S7: health probes may still use the cheap low variant", () => {
  assert.equal(variantFor({ id: "x", variants: ["low", "high"] }, { purpose: "probe" }), "low");
  assert.equal(variantFor({ id: "x", variants: ["low", "high"] }), undefined);
});


test("S7 review (1): usage after a loop trip in the same chunk is counted and stops fallback as budget_exceeded", async () => {
  const { EventEmitter } = await import("node:events");
  const { createOpenCodeRunner } = await import("../src/core.js");
  const spawns = [];
  const spawnImpl = (_exe, args) => {
    const idx = spawns.length;
    spawns.push(args);
    const c = new EventEmitter();
    c.pid = 100 + idx;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdout.setEncoding = c.stderr.setEncoding = () => {};
    c.kill = () => c.emit("close", null);
    const sid = `ses_s7_${idx}`;
    const events = [
      ...[1, 2, 3].map((i) => ({ type: "tool_use", sessionID: sid, part: { type: "tool", id: `p${i}`, callID: `c${i}`, messageID: "m1", tool: "read", state: { status: "error", input: { path: "missing.ts" }, error: "ENOENT" } } })),
      { type: "step_finish", sessionID: sid, part: { type: "step-finish", id: "stp_1", messageID: "m1", reason: "tool-calls", cost: 0, tokens: { input: 12_000, output: 10, reasoning: 0, cache: { read: 50_000, write: 3_000 } } } },
      { type: "text", sessionID: sid, part: { type: "text", id: "t1", messageID: "m2", text: "must not succeed" } },
    ];
    setImmediate(() => { c.stdout.emit("data", events.map((e) => JSON.stringify(e)).join("\n") + "\n"); c.emit("close", 0); });
    return c;
  };
  const runner = createOpenCodeRunner({ env: {}, spawnImpl, killProcessTreeImpl: (c) => c.emit("close", null) });
  const result = await runAnalysis({ ...base, runner, models, guard: { maxInputTokens: 10_000 } });
  assert.equal(spawns.length, 1);
  assert.equal(result.error, "budget_exceeded");
  assert.equal(result.guard.kind, "budget_exceeded");
  assert.equal(result.guard.budgetInputTokens, 15_000);
  assert.equal(result.guard.totalInputTokens, 65_000);
  assert.equal(result.usage.inputTokens, 65_000);
  assert.equal(result.text, undefined);
});

test("S7 review (2): killConfirmed === false stops the chain without starting the next model", async () => {
  const { formatAnalysisResult } = await import("../src/core.js");
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    let verdict;
    for (let i = 0; i < 3; i++) verdict = call.guardState.observe(failingRead("missing.ts"));
    return { status: "failed", error: verdict.kind, guard: verdict, killConfirmed: false, stillAlive: [9876] };
  };
  const result = await runAnalysis({ ...base, runner, models });
  assert.equal(calls.length, 1);
  assert.equal(result.killConfirmed, false);
  assert.deepEqual(result.stillAlive, [9876]);
  assert.match(result.message, /still be running/i);
  const formatted = formatAnalysisResult(result);
  assert.match(formatted, /still be running/i);
  assert.doesNotMatch(formatted, /no fallback models remained/i);
});

test("S7 review (3): resetLoop preserves dedupe keys so replayed usage is not counted twice", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  const usageEvent = {
    type: "usage", sessionID: "ses_1", id: "step_1",
    usage: { inputTokens: 10_000, uncachedInputTokens: 4_000, cacheReadTokens: 5_000, cacheWriteTokens: 1_000 },
  };
  assert.equal(guard.observe(usageEvent), null);
  for (let i = 0; i < 3; i++) guard.observe({ ...failingRead("missing.ts"), sessionID: "ses_1", id: `call_${i}` });
  assert.equal(guard.snapshot().kind, "loop_detected");
  guard.resetLoop();
  assert.equal(guard.snapshot().kind, undefined);
  assert.equal(guard.observe(usageEvent), null);
  assert.equal(guard.snapshot().totalInputTokens, 10_000);
  assert.equal(guard.snapshot().budgetInputTokens, 5_000);
  assert.equal(guard.observe({ ...usageEvent, sessionID: "ses_2" }), null);
  assert.equal(guard.snapshot().totalInputTokens, 20_000);
  assert.equal(guard.snapshot().budgetInputTokens, 10_000);
});

test("S7 review (5): cancellation during cleanup after a loop trip wins in runAnalysis and formatAnalysisResult", async () => {
  const { formatAnalysisResult } = await import("../src/core.js");
  const controller = new AbortController();
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    let verdict;
    for (let i = 0; i < 3; i++) verdict = call.guardState.observe(failingRead("missing.ts"));
    controller.abort();
    return { status: "failed", error: verdict.kind, guard: verdict };
  };
  const result = await runAnalysis({ ...base, runner, models, signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(result.cancelled, true);
  assert.match(result.error, /cancelled/i);
  const formatted = formatAnalysisResult(result);
  assert.match(formatted, /cancelled/i);
  assert.doesNotMatch(formatted, /no fallback models remained|Stopped by guard/i);
});

test("S7 review (6): edit guard schema describes stopping without fallback", async () => {
  const { editsInputSchema } = await import("../src/edits.js");
  assert.match(editsInputSchema.guard.description, /stops the edit/i);
  assert.doesNotMatch(editsInputSchema.guard.description, /moves to the next model/i);
});

// --- Second review (Astra): boundary, oversized line after a loop trip, cleanup status ---

test("S7 review: a failure that exactly reaches the token budget does not start another model", async () => {
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    call.guardState.observe({ type: "usage", id: `s${calls.length}`, sessionID: `ses_${calls.length}`, usage: { inputTokens: 10_000, uncachedInputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    return { status: "failed", error: "no answer", sessionID: `ses_${calls.length}` };
  };
  const result = await runAnalysis({ ...base, runner, models, guard: { maxInputTokens: 10_000 } });
  assert.equal(calls.length, 1);
  assert.equal(result.error, "budget_exceeded");
});

test("S7 review: an answer that exactly reaches the token budget is still returned", async () => {
  const runner = async (call) => {
    call.guardState.observe({ type: "usage", id: "s1", sessionID: "ses_1", usage: { inputTokens: 10_000, uncachedInputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    return { status: "ok", text: "at the boundary", sessionID: "ses_1" };
  };
  const result = await runAnalysis({ ...base, runner, models, guard: { maxInputTokens: 10_000 } });
  assert.equal(result.text, "at the boundary");
});

test("S7 review: an oversized line after a loop trip does not stop counting later usage", async () => {
  const { createEventStream } = await import("../src/events.js");
  const seen = [];
  const stream = createEventStream({ maxLineBytes: 1_000, onEvent: (event) => { seen.push(event.type); return seen.length === 1 ? "usage_only" : true; } });
  const step = (id) => JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", id, tokens: { input: 500, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
  stream.write(JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", id: "t1", messageID: "m1", text: "hi", time: { end: 1 } } }) + "\n");
  stream.write("x".repeat(2_000) + "\n" + step("p1") + "\n");
  const end = stream.end();
  assert.equal(end.error, undefined, "the oversized line is skipped, not fatal, after the trip");
  assert.equal(end.usage.uncachedInputTokens, 500);
});

test("S7 review: the cleanup warning is shown next to a cancel and next to an answer", async () => {
  const { formatAnalysisResult } = await import("../src/core.js");
  const cancelled = formatAnalysisResult({ error: "OpenCode analysis cancelled.", message: "OpenCode analysis cancelled.", cancelled: true, killConfirmed: false, stillAlive: [123], attempts: [] });
  assert.match(cancelled, /cancelled/);
  assert.match(cancelled, /may still be running \(PIDs 123\)/);
  const answered = formatAnalysisResult({ text: "the answer", model: "opencode/a-free", elapsedMs: 1, killConfirmed: false, attempts: [] });
  assert.match(answered, /the answer/);
  assert.match(answered, /may still be running/);
});

test("S7 review: an oversized line split across chunks after a loop trip is dropped up to its newline", async () => {
  const { createEventStream } = await import("../src/events.js");
  let first = true;
  const stream = createEventStream({ maxLineBytes: 1_000, onEvent: () => { if (first) { first = false; return "usage_only"; } return true; } });
  const step = (id, input) => JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", id, tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
  stream.write(JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", id: "t1", messageID: "m1", text: "hi", time: { end: 1 } } }) + "\n");
  stream.write("x".repeat(1_500));
  // The tail of the oversized line looks like a usage record; it must not be counted.
  stream.write("x".repeat(500) + step("p0", 99_999) + "\n" + step("p1", 500) + "\n");
  const end = stream.end();
  assert.equal(end.error, undefined);
  assert.equal(end.usage.uncachedInputTokens, 500, "only the complete record after the oversized line counts");
});
