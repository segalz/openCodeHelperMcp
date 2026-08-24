import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DEFAULT_VARIANT, PROVIDERS, analysisInputSchema, createOpenCodeRunner, registerAnalysisTools, runWithFallback } from "../src/core.js";

const directory = "C:\\Develop\\sample";
test("NVIDIA fallback is fixed to GPT-OSS 20B", () => {
  assert.deepEqual(PROVIDERS[2], {
    key: "nvidia",
    model: "nvidia/openai/gpt-oss-20b",
    title: "Analyze code with NVIDIA GPT-OSS",
    description: "Read-only code analysis using the fixed NVIDIA OpenAI GPT-OSS 20B model at low reasoning effort. Use this after MiMo fails or is insufficient.",
  });
});
test("fallback stops after Cloudflare succeeds", async () => {
  const calls = [];
  const result = await runWithFallback({ directory, prompt: "inspect", runner: async (call) => { calls.push(call); return { text: "cloudflare answer" }; } });
  assert.equal(result.provider, "cloudflare"); assert.deepEqual(calls.map((call) => call.model), [PROVIDERS[0].model]);
});
test("fallback advances Cloudflare to MiMo and then NVIDIA GPT-OSS", async () => {
  for (const [outcomes, expected] of [[[{ error: "quota" }, { text: "mimo" }], "mimo"], [[{ error: "quota" }, { error: "unavailable" }, { text: "nvidia" }], "nvidia"]]) {
    let index = 0; const calls = [];
    const result = await runWithFallback({ directory, prompt: "inspect", runner: async (call) => { calls.push(call); return outcomes[index++]; } });
    assert.equal(result.provider, expected); assert.deepEqual(calls.map((call) => call.model), PROVIDERS.slice(0, calls.length).map((provider) => provider.model));
  }
});
test("fallback records errors and timeouts at every stage, then reports all-providers-failed", async () => {
  for (const failingIndex of [0, 1, 2]) {
    const result = await runWithFallback({ directory, prompt: "inspect", runner: async ({ model }) => ({ error: model === PROVIDERS[failingIndex].model ? "OpenCode analysis timed out." : "unavailable" }) });
    assert.equal(result.error, "all-providers-failed"); assert.equal(result.attempts[failingIndex].status, "timeout"); assert.equal(result.attempts.length, 3);
  }
});
test("runner has fixed arguments and its injected clock can time out without a real spawn", async () => {
  const stdout = new EventEmitter(); stdout.setEncoding = () => {}; const stderr = new EventEmitter(); stderr.setEncoding = () => {};
  const child = new EventEmitter(); child.stdout = stdout; child.stderr = stderr; let killed = false; child.kill = () => { killed = true; child.emit("close", null); };
  const invocations = []; const timers = [];
  const runner = createOpenCodeRunner({ spawnImpl: (...args) => { invocations.push(args); return child; }, setTimeoutImpl: (callback) => { timers.push(callback); return "timer"; }, clearTimeoutImpl: () => {}, env: {}, platform: "linux", timeoutMs: 1 });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  timers[0]();
  const result = await pending;
  assert.equal(result.error, "OpenCode analysis timed out."); assert.equal(killed, true); assert.equal(invocations.length, 1);
  const [, args, options] = invocations[0];
  assert.deepEqual(args.slice(0, 10), ["run", "--dir", directory, "--model", PROVIDERS[0].model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format"]); assert.equal(options.shell, false);
});
test("all MCP tools expose only directory and prompt and keep provider selection fixed", async () => {
  const tools = new Map();
  registerAnalysisTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, { runner: async ({ model }) => ({ text: model }), isWithinAllowedRoot: () => true });
  assert.deepEqual(Object.keys(analysisInputSchema), ["directory", "prompt"]); assert.equal(tools.size, 4);
  for (const provider of PROVIDERS) { const tool = tools.get(`analyze_code_${provider.key}`); assert.deepEqual(Object.keys(tool.config.inputSchema), ["directory", "prompt"]); const response = await tool.handler({ directory, prompt: "inspect" }); assert.equal(response.content[0].text, provider.model); }
  const response = await tools.get("analyze_code").handler({ directory, prompt: "inspect" }); assert.equal(response.content[0].text, PROVIDERS[0].model);
});
