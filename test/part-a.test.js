import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStream } from "../src/events.js";
import { createGuard, guardSchema } from "../src/guard.js";
import { PERMISSION_PROFILES, permissionEnvironment, validatePermissionProfile } from "../src/permissions.js";
import { buildCodeMap } from "../src/codemap.js";
import { windowsCommandLineLength } from "../src/process-utils.js";
import { createOpenCodeRunner, runAnalysis, registerAnalysisTools, formatAnalysisResult } from "../src/core.js";

const sessionID = "ses_test";
const tool = (id, status = "error", input = { filePath: "src/main.js" }, name = "edit") => ({ type: "tool_use", sessionID, timestamp: 1, part: { type: "tool", id: `part_${id}`, callID: id, messageID: "msg_tools", tool: name, state: { status, input, ...(status === "error" ? { error: "oldString not found api_key=secret123" } : { output: "done", metadata: {} }), time: { start: 0, end: 1 } } } });
const step = (id, input = 10) => ({ type: "step_finish", sessionID, part: { type: "step-finish", id, messageID: "msg_tools", reason: "tool-calls", cost: 0.01, tokens: { input, output: 5, reasoning: 2, cache: { read: 20, write: 3 } } } });
const text = (id, value, messageID = "msg_answer") => ({ type: "text", sessionID, part: { type: "text", id, messageID, text: value, time: { start: 0, end: 1 } } });
const json = events => events.map(e => JSON.stringify(e)).join("\n") + "\n";
function child() {
  const c = new EventEmitter(); c.pid = 42;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdout.setEncoding = c.stderr.setEncoding = () => {};
  c.stderr.resume = () => {};
  c.kill = () => c.emit("close", null);
  return c;
}
function scripted(events, { code = 0, calls = [] } = {}) {
  return (executable, args, options) => {
    calls.push({ executable, args, options }); const c = child();
    setImmediate(() => { for (const chunk of events) c.stdout.emit("data", chunk); c.emit("close", code); }); return c;
  };
}

test("stream joins split UTF-8 and final-message parts, deduplicates tools and usage", () => {
  const seen = [], parser = createEventStream({ onEvent: e => seen.push(e) });
  const bytes = Buffer.from(json([text("draft", "draft", "msg_draft"), tool("a"), tool("a"), step("s"), step("s"), text("t1", "שלום"), text("t2", "second"), text("t1", "שלום"), tool("a")]));
  for (let i = 0; i < bytes.length; i++) parser.write(bytes.subarray(i, i + 1));
  const out = parser.end();
  assert.equal(out.text, "שלום\n\nsecond"); assert.equal(out.sessionID, sessionID);
  assert.equal(out.toolCalls, 1); assert.equal(out.toolErrors.length, 1);
  assert.deepEqual(out.usage, { inputTokens: 33, uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 5, reasoningTokens: 2, cost: 0.01, steps: 1 });
  assert.equal(seen.filter(e => e.type === "tool").length, 1);
});

test("stream rejects fatal errors, malformed/oversized events and session changes", () => {
  for (const suffix of [json([{ type: "error", error: { data: { message: "quota" } } }]), '{"type":bad}\n', json([{ ...text("b", "wrong"), sessionID: "other" }])]) {
    const p = createEventStream(); p.write(json([text("a", "partial")])); p.write(suffix);
    assert.equal(p.end().text, undefined); assert.ok(p.snapshot().detail);
  }
  const p = createEventStream({ maxLineBytes: 20 }); p.write("x".repeat(21)); assert.match(p.end().detail, /line exceeded/);
  const tail = createEventStream(); tail.write(JSON.stringify(text("a", "tail"))); assert.equal(tail.end().text, "tail");
});

test("validated direct permission profiles and explicit agent config replace caller profiles", () => {
  for (const mode of ["analysis", "edits"]) {
    const env = permissionEnvironment({ OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_CONFIG_CONTENT: '{"agent":{"plan":{"permission":{"edit":"allow"}}}}' }, mode);
    const profile = JSON.parse(env.OPENCODE_PERMISSION), agent = mode === "analysis" ? "plan" : "build";
    assert.deepEqual(profile, PERMISSION_PROFILES[mode]);
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent[agent].permission, profile);
    for (const key of ["bash", "task", "webfetch", "websearch", "external_directory"]) assert.equal(profile[key], "deny");
    assert.equal(profile.read["**/.*"], "deny"); assert.equal(profile.read["**/*.key"], "deny");
    assert.equal(profile.edit === "deny", mode === "analysis");
  }
  for (const profile of [[], { permission: {} }, { edit: false }, { webfetch: { "*": "deny" } }]) assert.throws(() => validatePermissionProfile(profile));
  assert.throws(() => permissionEnvironment({ OPENCODE_CONFIG_CONTENT: "bad json" }));
});

test("invalid local configuration refuses launch and fallback", async () => {
  const runner = createOpenCodeRunner({ env: { OPENCODE_CONFIG_CONTENT: "not JSON" }, spawnImpl: () => assert.fail("must not spawn") });
  const result = await runAnalysis({ directory: "C:\\sample", prompt: "q", models: [{ id: "m/a" }, { id: "m/b" }], runner });
  assert.equal(result.attempts.length, 1); assert.ok(result.error);
});

test("guard cleanup remains bounded when termination throws or close never arrives", async () => {
  const timers = [], c = child(); let destroyed = 0;
  c.stdout.destroy = c.stderr.destroy = () => destroyed++;
  const runner = createOpenCodeRunner({ env: {}, spawnImpl: () => c,
    killProcessTreeImpl: () => { throw new Error("kill refused"); },
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl: () => {} });
  const pending = runner({ directory: "C:\\sample", prompt: "q", model: "m/a" });
  c.stdout.emit("data", json([tool("1"), tool("2"), tool("3")]));
  assert.equal(timers.at(-1).ms, 1000); timers.at(-1).fn();
  const out = await pending; assert.equal(out.guard.kind, "loop_detected"); assert.equal(destroyed, 2);
});

test("guard catches interleaved same-target failures despite changing edit/patch content", () => {
  const guard = createGuard(); const p = createEventStream({ onEvent: e => guard.observe(e) });
  p.write(json([tool("1"), tool("r", "completed", { filePath: "other.js" }, "read"), tool("2", "error", { filePath: "SRC\\main.js", oldString: "different" }), tool("3")]));
  const report = guard.snapshot(); assert.equal(report.kind, "loop_detected"); assert.equal(report.totalToolCalls, 4); assert.equal(report.count, 3); assert.equal(report.target, "src/main.js");
  assert.ok(report.lastErrors.every(e => !e.includes("secret123")));
  const patchGuard = createGuard(); const q = createEventStream({ onEvent: e => patchGuard.observe(e) });
  q.write(json([1, 2, 3].map(i => tool(String(i), "error", { patchText: `*** Begin Patch\n*** Update File: src/x.js\n@@\n-${i}\n+new\n*** End Patch` }, "apply_patch"))));
  assert.equal(patchGuard.snapshot().target, "src/x.js");
});

test("successful calls occupy the sliding window; token/tool budgets and bash exits are observed", () => {
  const g = createGuard({ window: 3 });
  for (let i = 0; i < 20; i++) g.observe({ type: "tool", id: String(i), tool: "read", input: { path: "a.js" }, status: i % 2 ? "completed" : "error" });
  assert.equal(g.snapshot().kind, undefined);
  const bounded = createGuard({ maxToolCalls: 10 });
  for (let i = 0; i < 11; i++) bounded.observe({ type: "tool", id: String(i), tool: "read", input: {}, status: "completed" });
  assert.equal(bounded.snapshot().kind, "budget_exceeded");
  const tokens = createGuard({ maxInputTokens: 10000 });
  tokens.observe({ type: "usage", id: "s", usage: { inputTokens: 10001 } });
  assert.equal(tokens.snapshot().totalInputTokens, 10001);
  const bash = createGuard();
  for (let i = 0; i < 3; i++) bash.observe({ type: "tool", id: String(i), tool: "bash", input: { command: "npm test" }, status: "completed", metadata: { exit: 1 }, output: "failed" });
  assert.equal(bash.snapshot().kind, "loop_detected");
  assert.equal(guardSchema.safeParse({ window: 3, maxRepeatedFailures: 4 }).success, false);
});

test("streaming guard kills immediately before close; reports trip without fallback", async () => {
  const calls = [], killed = [];
  const runner = createOpenCodeRunner({ env: {}, spawnImpl: scripted([json([tool("1"), tool("2"), tool("3"), text("later", "must not succeed")])], { calls }), killProcessTreeImpl: c => { killed.push(c.pid); c.emit("close", null); } });
  const out = await runAnalysis({ directory: "C:\\sample", prompt: "q", models: [{ id: "m/a" }, { id: "m/b" }], runner });
  assert.equal(calls.length, 1); assert.deepEqual(killed, [42]); assert.equal(out.guard.kind, "loop_detected"); assert.equal(out.text, undefined);
  assert.doesNotMatch(formatAnalysisResult(out), /Call list_free_models/);
});

test("guard and usage remain cumulative across distinct model attempts", async () => {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    const index = calls.length; calls.push({ args, options }); const c = child();
    setImmediate(() => { c.stdout.emit("data", json([{ ...step("step", 6000), sessionID: `session_${index}` }])); c.emit("close", 1); }); return c;
  };
  const runner = createOpenCodeRunner({ env: {}, spawnImpl, killProcessTreeImpl: c => c.emit("close", null) });
  const out = await runAnalysis({ directory: "C:\\sample", prompt: "q", guard: { maxInputTokens: 10000 }, models: [{ id: "m/a" }, { id: "m/b" }, { id: "m/c" }], runner });
  assert.equal(calls.length, 2); assert.equal(out.guard.kind, "budget_exceeded"); assert.equal(out.guard.totalInputTokens, 12046); assert.equal(out.usage.inputTokens, 12046);
});

test("runner keeps recoverable tool diagnostics but fatal/process errors cannot succeed", async () => {
  for (const [events, code] of [[[tool("1"), text("a", "recovered")], 0], [[text("a", "partial"), { type: "error", error: "fatal" }], 0], [[text("a", "partial")], 1]]) {
    const runner = createOpenCodeRunner({ env: {}, spawnImpl: scripted([json(events)], { code }), killProcessTreeImpl: c => c.emit("close", null) });
    const out = await runner({ directory: "C:\\sample", prompt: "q", model: "m/a" });
    assert.equal(Boolean(out.text), events[0].type === "tool_use");
    if (out.text) assert.ok(!out.toolErrors[0].includes("secret123"));
  }
});

test("runner passes plan/permission profiles and optional bounded context, never auto", async () => {
  const calls = []; let maps = 0;
  const runner = createOpenCodeRunner({ env: {}, platform: "win32", spawnImpl: scripted([json([text("a", "answer")])], { calls }), codeMapBuilder: async (_root, options) => { maps++; assert.ok(options.commandLineLength("map") < 31000); return "## Code map\nsrc/main.js (1 lines): main:1"; } });
  await runner({ directory: "C:\\sample", prompt: "q", model: "m/a" });
  assert.equal(maps, 1); assert.match(calls[0].args.at(-1), /OS Windows/); assert.match(calls[0].args.at(-1), /glob\/list/); assert.match(calls[0].args.at(-1), /Code map/);
  assert.equal(calls[0].args.includes("--auto"), false); assert.equal(calls[0].args[calls[0].args.indexOf("--agent") + 1], "plan");
  assert.equal(JSON.parse(calls[0].options.env.OPENCODE_PERMISSION).edit, "deny");
  await runner({ directory: "C:\\sample", prompt: "q", model: "m/a", codeMap: false }); assert.equal(maps, 1);
  const oversized = createOpenCodeRunner({ env: {}, platform: "win32", spawnImpl: scripted([json([text("a", "answer")])], { calls }), codeMapBuilder: async () => "x".repeat(40000) });
  await oversized({ directory: "C:\\sample", prompt: "q", model: "m/a" }); assert.ok(windowsCommandLineLength("opencode", calls.at(-1).args) < 31000);
  const failure = await oversized({ directory: "C:\\sample", prompt: "x".repeat(40000), model: "m/a" }); assert.equal(failure.localFailure, true);
});

test("code map uses current files, excludes secrets/vendor/binary, clamps and tolerates non-Git paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-map-test-"));
  try {
    await mkdir(path.join(root, "src")); await mkdir(path.join(root, "node_modules"));
    const files = { "src/main.js": "export function current() {}\n", ".env": "SECRET=1", "credentials.json": "{}", "node_modules/lib.js": "export const vendor=1", "binary.js": Buffer.from([0, 1, 2]), "lock.lock": "skip" };
    for (const [file, value] of Object.entries(files)) await writeFile(path.join(root, file), value);
    const spawnImpl = scripted([Buffer.from(Object.keys(files).join("\0") + "\0")]);
    const map = await buildCodeMap(root, { spawnImpl, prompt: "src/main.js" });
    assert.match(map, /current checkout contents/); assert.match(map, /current:1/); assert.doesNotMatch(map, /SECRET|credentials|vendor|binary|lock.lock/);
    assert.equal(await buildCodeMap(root, { spawnImpl, commandLineLength: () => 31999 }), undefined);
    assert.equal(await buildCodeMap(root, { spawnImpl: scripted([], { code: 128 }) }), undefined);
    const controller = new AbortController(); controller.abort(); assert.equal(await buildCodeMap(root, { signal: controller.signal }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP schema forwards guard/codeMap and discovery consumes the shared deadline", async () => {
  let now = 0; const tools = new Map(), calls = [];
  registerAnalysisTools({ registerTool: (name, _config, handler) => tools.set(name, handler) }, {
    runner: async input => { calls.push(input); return { text: "answer" }; },
    catalog: { list: async () => { now += 5000; return { models: [{ id: "m/a" }] }; }, recentProbe: () => {} },
    resolveAllowedPath: async value => value, nowImpl: () => now,
  });
  await tools.get("analyze_code")({ directory: path.resolve("."), prompt: "q", budgetMs: 30000, codeMap: false, guard: { maxToolCalls: 12 } });
  assert.equal(calls[0].codeMap, false); assert.equal(calls[0].timeoutMs, 25000);
  assert.ok(calls[0].guardState);
  const bad = await tools.get("analyze_code")({ directory: path.resolve("."), prompt: "q", guard: { maxToolCalls: -1 } }); assert.equal(bad.isError, true);
});
