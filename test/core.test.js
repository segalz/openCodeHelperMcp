import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DEFAULT_FALLBACK_TIMEOUT_MS, DEFAULT_VARIANT, PROVIDERS, analysisInputSchema, createOpenCodeRunner, parseOpenCodeNdjson, registerAnalysisTools, runWithFallback } from "../src/core.js";

const directory = "C:\\Develop\\sample";

function fakeChild({ pid = 1234 } = {}) {
  const stdout = new EventEmitter(); stdout.setEncoding = () => {};
  const stderr = new EventEmitter(); stderr.setEncoding = () => {};
  const child = new EventEmitter(); child.pid = pid; child.stdout = stdout; child.stderr = stderr; child.kill = () => child.emit("exit", null);
  return child;
}

test("NVIDIA fallback is first and fixed to GPT-OSS 20B", () => {
  assert.deepEqual(PROVIDERS[0], { key: "nvidia", model: "nvidia/openai/gpt-oss-20b", title: "Analyze code with NVIDIA GPT-OSS", description: "Read-only code analysis using the fixed NVIDIA OpenAI GPT-OSS 20B model at low reasoning effort. Use this first." });
});

test("NDJSON parser returns only the final text and rejects errors or invalid output", () => {
  assert.deepEqual(parseOpenCodeNdjson('{"type":"text","text":"draft"}\n{"type":"text","text":"final"}'), { text: "final" });
  assert.deepEqual(parseOpenCodeNdjson('{"type":"error","error":"private detail"}'), { error: "OpenCode reported an analysis error." });
  assert.deepEqual(parseOpenCodeNdjson('{"type":"message","part":{"type":"error","text":"private detail"}}'), { error: "OpenCode reported an analysis error." });
  assert.deepEqual(parseOpenCodeNdjson("plain text"), { error: "OpenCode returned no valid analysis." });
});

test("fallback stops after NVIDIA succeeds", async () => {
  const calls = [];
  const result = await runWithFallback({ directory, prompt: "inspect", runner: async (call) => { calls.push(call); return { text: "nvidia answer" }; } });
  assert.equal(result.provider, "nvidia"); assert.deepEqual(calls.map((call) => call.model), [PROVIDERS[0].model]);
});

test("fallback advances NVIDIA to MiMo and then Cloudflare", async () => {
  for (const [outcomes, expected] of [[[{ error: "quota" }, { text: "mimo" }], "mimo"], [[{ error: "quota" }, { error: "unavailable" }, { text: "cloudflare" }], "cloudflare"]]) {
    let index = 0; const calls = [];
    const result = await runWithFallback({ directory, prompt: "inspect", runner: async (call) => { calls.push(call); return outcomes[index++]; } });
    assert.equal(result.provider, expected); assert.deepEqual(calls.map((call) => call.model), PROVIDERS.slice(0, calls.length).map((provider) => provider.model));
  }
});

test("fallback records timeouts and enforces its total deadline", async () => {
  for (const failingIndex of [0, 1, 2]) {
    const result = await runWithFallback({ directory, prompt: "inspect", runner: async ({ model }) => ({ error: model === PROVIDERS[failingIndex].model ? "OpenCode analysis timed out." : "unavailable" }) });
    assert.equal(result.error, "all-providers-failed"); assert.equal(result.attempts[failingIndex].status, "timeout");
  }
  let now = 0; const calls = [];
  const deadlineResult = await runWithFallback({ directory, prompt: "inspect", timeoutMs: 10, nowImpl: () => now, runner: async (call) => { calls.push(call); now = 10; return { error: "unavailable" }; } });
  assert.equal(deadlineResult.error, "all-providers-failed"); assert.deepEqual(deadlineResult.attempts.at(-1), { provider: "mimo", status: "deadline" }); assert.equal(calls[0].timeoutMs, 10);
  assert.equal(DEFAULT_FALLBACK_TIMEOUT_MS, 120_000);
});

test("runner directly launches the fixed executable with low and plan arguments", async () => {
  const child = fakeChild(); const invocations = []; const timers = [];
  const runner = createOpenCodeRunner({ spawnImpl: (...args) => { invocations.push(args); return child; }, setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; }, clearTimeoutImpl: () => {}, env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, platform: "win32", timeoutMs: 10, graceMs: 1 });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  child.stdout.emit("data", '{"type":"text","text":"final analysis"}\n'); child.emit("close", 0);
  assert.deepEqual(await pending, { text: "final analysis" });
  const [executable, args, options] = invocations[0];
  assert.equal(executable, "C:\\tools\\opencode.exe"); assert.deepEqual(args.slice(0, 10), ["run", "--dir", directory, "--model", PROVIDERS[0].model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format"]); assert.equal(options.shell, false);
  assert.match(args.at(-1), /Respond only in concise English Markdown/); assert.match(args.at(-1), /within 120 words/);
});

test("runner terminates only its Windows child tree and resolves after timeout grace without close", async () => {
  const child = fakeChild({ pid: 5678 }); const timers = []; const terminated = [];
  const runner = createOpenCodeRunner({ spawnImpl: () => child, setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; }, clearTimeoutImpl: () => {}, killProcessTreeImpl: (target) => terminated.push(target.pid), env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, platform: "win32", timeoutMs: 10, graceMs: 1 });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  timers[0](); assert.deepEqual(terminated, [5678]);
  timers[1](); assert.deepEqual(await pending, { error: "OpenCode analysis timed out." });
});

test("runner resolves from exit after grace when inherited streams prevent close", async () => {
  const child = fakeChild(); const timers = [];
  const runner = createOpenCodeRunner({ spawnImpl: () => child, setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; }, clearTimeoutImpl: () => {}, env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, timeoutMs: 10, graceMs: 1 });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  child.stdout.emit("data", '{"part":{"type":"text","text":"exit result"}}\n'); child.emit("exit", 0);
  timers[1](); assert.deepEqual(await pending, { text: "exit result" });
});

test("all MCP tools expose only directory and prompt and keep provider selection fixed", async () => {
  const tools = new Map();
  registerAnalysisTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, { runner: async ({ model }) => ({ text: model }), isWithinAllowedRoot: () => true });
  assert.deepEqual(Object.keys(analysisInputSchema), ["directory", "prompt"]); assert.equal(tools.size, 4);
  for (const provider of PROVIDERS) { const tool = tools.get(`analyze_code_${provider.key}`); assert.deepEqual(Object.keys(tool.config.inputSchema), ["directory", "prompt"]); const response = await tool.handler({ directory, prompt: "inspect" }); assert.equal(response.content[0].text, provider.model); }
});
