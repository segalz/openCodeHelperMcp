import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DEFAULT_VARIANT,
  OPENCODE_MAX_STDOUT_BYTES,
  PROVIDERS,
  allocateProviderTimeoutMs,
  analysisInputSchema,
  createOpenCodeRunner,
  defaultKillProcessTree,
  formatOrchestratedResult,
  parseOpenCodeNdjson,
  registerAnalysisTools,
  resolvePathWithinAllowedRoots,
  runWithFallback,
} from "../src/core.js";

const directory = "C:\\Develop\\sample";

function fakeChild({ pid = 1234 } = {}) {
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  stderr.setEncoding = () => {};
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => child.emit("exit", null);
  return child;
}

test("CodeHelper has no Ollama providers or tools", async () => {
  assert.deepEqual(PROVIDERS.map((provider) => provider.key), ["nvidia", "mimo", "cloudflare"]);
  assert.ok(PROVIDERS.every((provider) => !/ollama/i.test(`${provider.key} ${provider.model}`)));

  const tools = new Map();
  registerAnalysisTools(
    { registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    { runner: async ({ model }) => ({ text: model }), resolveAllowedPath: async (value) => value },
  );
  assert.equal(tools.size, PROVIDERS.length + 1);
  assert.equal(tools.has("analyze_code_ollama"), false);
  assert.equal(tools.has("analyze_code_ollama_local"), false);
  assert.doesNotMatch(tools.get("analyze_code").config.description, /ollama/i);
});

test("NDJSON parser accepts final text and rejects error output", () => {
  assert.deepEqual(parseOpenCodeNdjson('{"type":"text","text":"draft"}\n{"type":"text","text":"final"}'), { text: "final" });
  assert.deepEqual(parseOpenCodeNdjson('{"type":"error","error":"private"}'), { error: "OpenCode reported an analysis error." });
  assert.deepEqual(parseOpenCodeNdjson("plain text"), { error: "OpenCode returned no valid analysis." });
});

test("fallback stops after the first remote provider succeeds", async () => {
  let calls = 0;
  const result = await runWithFallback({
    directory,
    prompt: "inspect",
    runner: async () => { calls += 1; return { text: "answer" }; },
  });
  assert.equal(result.provider, "nvidia");
  assert.equal(calls, 1);
});

test("fallback advances through only the remote provider chain", async () => {
  for (const successIndex of [0, 1, 2]) {
    const calls = [];
    const result = await runWithFallback({
      directory,
      prompt: "inspect",
      runner: async (call) => {
        calls.push(call.model);
        return calls.length - 1 === successIndex ? { text: "answer" } : { error: "unavailable" };
      },
    });
    assert.equal(result.provider, PROVIDERS[successIndex].key);
    assert.deepEqual(calls, PROVIDERS.slice(0, successIndex + 1).map((provider) => provider.model));
  }
});

test("OpenCode runner directly launches the fixed executable in plan/low mode", async () => {
  const child = fakeChild();
  const invocations = [];
  const runner = createOpenCodeRunner({
    spawnImpl: (...args) => { invocations.push(args); return child; },
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" },
    platform: "win32",
    timeoutMs: 10,
    graceMs: 1,
  });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  child.stdout.emit("data", '{"type":"text","text":"final analysis"}\n');
  child.emit("close", 0);
  assert.deepEqual(await pending, { text: "final analysis" });
  const [executable, args, options] = invocations[0];
  assert.equal(executable, "C:\\tools\\opencode.exe");
  assert.deepEqual(args.slice(0, 10), ["run", "--dir", directory, "--model", PROVIDERS[0].model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format"]);
  assert.equal(options.shell, false);
});

test("request timeout overrides the OpenCode default timeout", async () => {
  const child = fakeChild();
  const timers = [];
  const runner = createOpenCodeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe", OPENCODE_HELPER_TIMEOUT_MS: "40000" },
    platform: "win32",
  });
  const pending = runner({ directory, prompt: "deep review", model: PROVIDERS[0].model, timeoutMs: 60_000 });
  child.stdout.emit("data", '{"type":"text","text":"complete"}\n');
  child.emit("close", 0);
  assert.deepEqual(await pending, { text: "complete" });
  assert.equal(timers[0].delay, 60_000);
});

test("MCP tools keep provider settings internal and use canonical paths", async () => {
  const tools = new Map();
  const directories = [];
  registerAnalysisTools(
    { registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    {
      runner: async ({ directory: value, model }) => { directories.push(value); return { text: model }; },
      resolveAllowedPath: async () => "C:\\Develop\\canonical",
    },
  );
  assert.deepEqual(Object.keys(analysisInputSchema), ["directory", "prompt", "maxWords", "budgetMs"]);
  for (const provider of PROVIDERS) {
    const tool = tools.get(`analyze_code_${provider.key}`);
    assert.deepEqual(Object.keys(tool.config.inputSchema), ["directory", "prompt", "maxWords", "budgetMs"]);
    const response = await tool.handler({ directory, prompt: "inspect" });
    assert.equal(response.content[0].text, provider.model);
  }
  assert.deepEqual(directories, Array(PROVIDERS.length).fill("C:\\Develop\\canonical"));
});

test("orchestrated results expose only safe metadata", () => {
  const success = formatOrchestratedResult({
    provider: "mimo",
    attempts: [{ provider: "nvidia", status: "timeout", privateError: "secret" }],
    text: "## Analysis\nComplete result.",
  });
  assert.match(success, /Provider: mimo/);
  assert.match(success, /Previous attempts: nvidia:timeout/);
  assert.doesNotMatch(success, /secret/);

  const failed = formatOrchestratedResult({ error: "all-providers-failed", attempts: [{ provider: "nvidia", status: "failed" }] });
  assert.match(failed, /All CodeHelper providers failed/);
  assert.doesNotMatch(failed, /Grok|Ollama/i);
});

test("canonical allowed-root resolution rejects junction escapes", async () => {
  const escaped = await resolvePathWithinAllowedRoots("C:\\Develop\\link", ["C:\\Develop"], {
    realpathImpl: async (value) => String(value).endsWith("link") ? "C:\\Outside\\target" : value,
  });
  assert.equal(escaped, null);

  const canonical = await resolvePathWithinAllowedRoots("C:\\Develop\\project", ["C:\\Develop"], {
    realpathImpl: async (value) => String(value).endsWith("project") ? "C:\\Develop\\real-project" : value,
  });
  assert.equal(canonical, "C:\\Develop\\real-project");
});

test("OpenCode errors never expose raw stderr", async () => {
  const child = fakeChild();
  const runner = createOpenCodeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" },
    timeoutMs: 10_000,
  });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  child.stderr.emit("data", "private diagnostic details\n");
  child.emit("close", 1);
  const result = await pending;
  assert.match(result.error, /exited with code 1/);
  assert.doesNotMatch(result.error, /private diagnostic details/);
});

test("OpenCode runner bounds stdout and terminates only its child", async () => {
  const child = fakeChild({ pid: 4321 });
  const killed = [];
  const runner = createOpenCodeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    killProcessTreeImpl: (target) => { killed.push(target.pid); target.emit("close", null); },
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" },
    timeoutMs: 10_000,
  });
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[0].model });
  child.stdout.emit("data", "x".repeat(OPENCODE_MAX_STDOUT_BYTES + 1));
  assert.deepEqual(await pending, { error: "OpenCode output exceeded the size limit." });
  assert.deepEqual(killed, [4321]);
});

test("Windows tree termination targets only the known child pid", () => {
  const invocations = [];
  const terminator = new EventEmitter();
  defaultKillProcessTree({ pid: 4242, kill: () => assert.fail("fallback kill should not run") }, {
    platform: "win32",
    spawnImpl: (...args) => { invocations.push(args); return terminator; },
  });
  assert.equal(invocations[0][0], "taskkill");
  assert.deepEqual(invocations[0][1], ["/pid", "4242", "/t", "/f"]);
  assert.equal(invocations[0][2].shell, false);
});

test("total budget is allocated across remote providers without duplicate calls", async () => {
  assert.equal(allocateProviderTimeoutMs(PROVIDERS, 0, 90_000), 18_947);
  let now = 0;
  const calls = [];
  const result = await runWithFallback({
    directory,
    prompt: "deep review",
    budgetMs: 270_000,
    nowImpl: () => now,
    runner: async (call) => {
      calls.push(call);
      now += call.timeoutMs;
      return { error: "timed out" };
    },
  });
  assert.equal(result.error, "all-providers-failed");
  assert.deepEqual(calls.map((call) => call.model), PROVIDERS.map((provider) => provider.model));
  assert.equal(new Set(calls.map((call) => call.model)).size, PROVIDERS.length);
  assert.ok(calls.reduce((sum, call) => sum + call.timeoutMs, 0) <= 270_000);
});
