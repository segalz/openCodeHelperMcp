import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import * as core from "../src/core.js";
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_BUDGET_MS,
  MAX_BUDGET_MS,
  OPENCODE_MAX_STDOUT_BYTES,
  PREFERRED_MODELS,
  allocateAttemptTimeoutMs,
  analysisInputSchema,
  buildAutoOrder,
  createModelCatalog,
  createOpenCodeRunner,
  defaultKillProcessTree,
  formatAnalysisResult,
  isUsableFreeModel,
  listModelsInputSchema,
  parseOpenCodeNdjson,
  parsePlainModels,
  parseVerboseModels,
  redactSecrets,
  registerAnalysisTools,
  resolvePathWithinAllowedRoots,
  resolveRequestedModels,
  runAnalysis,
  variantFor,
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

/** spawn mock that answers each call from a script: (executable, args) => { stdout, stderr, code } */
function scriptedSpawn(script, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = fakeChild();
    const reply = script(executable, args) ?? {};
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit("data", reply.stdout);
      if (reply.stderr) child.stderr.emit("data", reply.stderr);
      if (!reply.hang) child.emit("close", reply.code ?? 0);
    });
    return child;
  };
}

const modelBlock = (id, { input = 0, output = 0, toolcall = true, status = "active", variants = { low: {}, high: {} }, cost = true } = {}) => {
  const [providerID, ...rest] = id.split("/");
  const meta = {
    id: rest.join("/"), providerID, name: id, family: "f",
    api: { id: rest.join("/"), url: "https://example.invalid/{v1}", npm: "x" },
    status, headers: { Authorization: "Bearer should-never-leak" }, options: { apiKey: "sk-should-never-leak" },
    ...(cost ? { cost: { input, output, cache: { read: 0, write: 0 } } } : {}),
    limit: { context: 200000, output: 32000 },
    capabilities: { toolcall, input: { text: true } },
    variants,
  };
  return `${id}\n${JSON.stringify(meta, null, 2)}\n`;
};

const VERBOSE_FIXTURE = [
  modelBlock("opencode/big-pickle", { variants: {} }),
  modelBlock("opencode/deepseek-v4.1-flash-free"),
  modelBlock("opencode/glm-5.3-flash-free"),
  modelBlock("opencode/nemotron-3-ultra-free", { variants: {} }),
  modelBlock("groq/qwen/qwen3.8-27b", { input: 0.8, output: 4 }),
  modelBlock("groq/whisper-large-v3", { toolcall: false }),
  modelBlock("nvidia/z-ai/glm-5.3-flash"),
  modelBlock("cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash", { input: 0.06, output: 0.4 }),
  modelBlock("opencode/old-free", { status: "deprecated" }),
].join("");

const FREE = parseVerboseModels(VERBOSE_FIXTURE).filter(isUsableFreeModel);

// ---------------------------------------------------------------------------

test("no frozen provider list or fixed per-provider tools remain", () => {
  assert.equal(core.PROVIDERS, undefined);
  const tools = new Map();
  registerAnalysisTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, { runner: async () => ({ text: "x" }), catalog: {}, resolveAllowedPath: async (v) => v });
  assert.deepEqual([...tools.keys()].sort(), ["analyze_code", "list_free_models"]);
  assert.match(tools.get("analyze_code").config.description, /list_free_models/);
  assert.match(tools.get("analyze_code").config.description, /optional/i);
  assert.deepEqual(Object.keys(analysisInputSchema), ["directory", "prompt", "maxWords", "budgetMs", "model", "models"]);
  assert.deepEqual(Object.keys(listModelsInputSchema), ["probe", "refresh", "models", "provider"]);
  assert.equal(MAX_BUDGET_MS, 600_000);
  assert.equal(DEFAULT_ATTEMPT_TIMEOUT_MS, 120_000);
});

test("verbose model listing is parsed, keeps no secrets, and filters free models by cost", () => {
  const all = parseVerboseModels(VERBOSE_FIXTURE);
  assert.equal(all.length, 9);
  assert.doesNotMatch(JSON.stringify(all), /should-never-leak/);
  const big = all.find((m) => m.id === "opencode/big-pickle");
  assert.equal(big.free, true);
  assert.equal(big.freeBasis, "cost");
  assert.equal(all.find((m) => m.id === "groq/qwen/qwen3.8-27b").free, false);
  assert.deepEqual(FREE.map((m) => m.id), [
    "opencode/big-pickle", "opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free",
    "opencode/nemotron-3-ultra-free", "nvidia/z-ai/glm-5.3-flash",
  ]);
  assert.equal(variantFor(FREE[1]), "low");
  assert.equal(variantFor(FREE[0]), undefined);
});

test("models without cost metadata fall back to the naming rule", () => {
  const verbose = parseVerboseModels(modelBlock("opencode/x-free", { cost: false }) + modelBlock("opencode/paid-one", { cost: false }));
  assert.deepEqual(verbose.map((m) => [m.id, m.free, m.freeBasis]), [["opencode/x-free", true, "name"], ["opencode/paid-one", false, "name"]]);
  const plain = parsePlainModels("opencode/big-pickle\nopencode/deepseek-v4.1-flash-free\ngroq/qwen/qwen3.8-27b\nnoise line\nopenrouter/foo:free\n");
  assert.deepEqual(plain.filter(isUsableFreeModel).map((m) => m.id), ["opencode/big-pickle", "opencode/deepseek-v4.1-flash-free", "openrouter/foo:free"]);
});

test("catalog runs `opencode models --verbose`, caches for the TTL, and refreshes on demand", async () => {
  let now = 1_000;
  const calls = [];
  const catalog = createModelCatalog({
    runner: async () => ({ text: "OK", elapsedMs: 5 }),
    spawnImpl: scriptedSpawn(() => ({ stdout: VERBOSE_FIXTURE }), calls),
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, nowImpl: () => now, ttlMs: 600_000,
  });
  const first = await catalog.list();
  assert.equal(first.models.length, 5);
  assert.equal(first.source, "opencode models --verbose");
  assert.deepEqual(calls[0].args, ["models", "--verbose"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.NO_COLOR, "1");
  now += 60_000;
  await catalog.list();
  assert.equal(calls.length, 1);
  await catalog.list({ refresh: true });
  assert.equal(calls.length, 2);
  now += 700_000;
  await catalog.list();
  assert.equal(calls.length, 3);
});

test("catalog falls back to plain listing and reports real listing errors", async () => {
  const catalog = createModelCatalog({
    runner: async () => ({}),
    spawnImpl: scriptedSpawn((_e, args) => (args.includes("--verbose") ? { code: 1, stderr: "unknown flag" } : { stdout: "opencode/a-free\nopencode/b\n" })),
    env: {},
  });
  const listed = await catalog.list();
  assert.equal(listed.source, "opencode models (name rule)");
  assert.deepEqual(listed.models.map((m) => m.id), ["opencode/a-free"]);

  const broken = createModelCatalog({ runner: async () => ({}), spawnImpl: scriptedSpawn(() => ({ code: 2, stderr: "boom token=abc123secret" })), env: {} });
  const failed = await broken.list();
  assert.match(failed.error, /exited with code 2/);
  assert.match(failed.error, /boom/);
  assert.doesNotMatch(failed.error, /abc123secret/);
});

test("probe runs in parallel with a cap, records ok/failed/timeout, and caches results", async () => {
  let now = 0;
  let active = 0; let maxActive = 0;
  const seen = [];
  const catalog = createModelCatalog({
    nowImpl: () => now, probeConcurrency: 2, probeTimeoutMs: 30_000,
    spawnImpl: scriptedSpawn(() => ({ stdout: VERBOSE_FIXTURE })), env: {},
    runner: async (call) => {
      seen.push(call);
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setImmediate(r));
      active--;
      if (call.model.includes("nemotron")) return { status: "failed", error: "OpenCode exited with code 1.\nError: Model overloaded api_key=zzz", elapsedMs: 900 };
      if (call.model.includes("pickle")) return { status: "timeout", error: "OpenCode timed out after 30001 ms.", elapsedMs: 30_001 };
      return { text: "OK", elapsedMs: 1234 };
    },
  });
  const { models } = await catalog.list();
  const result = await catalog.probe(models);
  assert.ok(maxActive <= 2);
  assert.ok(seen.every((call) => call.timeoutMs === 30_000 && call.raw === true));
  const byId = Object.fromEntries(result.map((r) => [r.id, r]));
  assert.equal(byId["opencode/deepseek-v4.1-flash-free"].status, "ok");
  assert.equal(byId["opencode/deepseek-v4.1-flash-free"].latency_ms, 1234);
  assert.equal(byId["opencode/nemotron-3-ultra-free"].status, "failed");
  assert.match(byId["opencode/nemotron-3-ultra-free"].error, /overloaded/);
  assert.doesNotMatch(byId["opencode/nemotron-3-ultra-free"].error, /zzz/);
  assert.equal(byId["opencode/big-pickle"].status, "timeout");
  const callsBefore = seen.length;
  await catalog.probe(models);
  assert.equal(seen.length, callsBefore, "cached probes are not repeated");
  await catalog.probe(models, { refresh: true });
  assert.equal(seen.length, callsBefore * 2);
});

test("explicit models are validated against the current free list", () => {
  assert.deepEqual(resolveRequestedModels({}, FREE), { auto: true, models: [] });
  const ok = resolveRequestedModels({ model: "opencode/glm-5.3-flash-free", models: ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash"] }, FREE);
  assert.deepEqual(ok.models.map((m) => m.id), ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash"]);
  const bad = resolveRequestedModels({ model: "groq/qwen/qwen3.8-27b" }, FREE);
  assert.match(bad.error, /not in the current free list: groq\/qwen\/qwen3\.8-27b/);
  assert.match(bad.error, /opencode\/deepseek-v4\.1-flash-free/);
});

test("auto order follows the preference list, then other free models, and skips failed probes", () => {
  const order = buildAutoOrder(FREE).map((m) => m.id);
  assert.deepEqual(order.slice(0, 2), ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"]);
  assert.equal(order.length, 4);
  assert.ok(!order.includes("opencode/mimo-v2.6-flash-free"), "unlisted preferred models are not used");
  const probes = { "opencode/deepseek-v4.1-flash-free": { status: "failed" }, "nvidia/z-ai/glm-5.3-flash": { status: "ok", latency_ms: 10 }, "opencode/big-pickle": { status: "timeout" } };
  const skipped = buildAutoOrder(FREE, { recentProbe: (id) => probes[id] }).map((m) => m.id);
  assert.deepEqual(skipped, ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash", "opencode/nemotron-3-ultra-free"]);
  assert.deepEqual(PREFERRED_MODELS.slice(0, 3), ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free", "opencode/mimo-v2.6-flash-free"]);
});

test("budget is shared across attempts without duplicate calls and never exceeded", async () => {
  assert.equal(allocateAttemptTimeoutMs({ remainingMs: 300_000, attemptsLeft: 4 }), 120_000);
  assert.equal(allocateAttemptTimeoutMs({ remainingMs: 90_000, attemptsLeft: 3 }), 30_000);
  assert.equal(allocateAttemptTimeoutMs({ remainingMs: 300_000, attemptsLeft: 1, totalAttempts: 1 }), 300_000);
  let now = 0;
  const calls = [];
  const models = [FREE[1], FREE[2], FREE[1], FREE[4]];
  const result = await runAnalysis({
    directory, prompt: "deep", budgetMs: 300_000, nowImpl: () => now, models,
    runner: async (call) => { calls.push(call); now += call.timeoutMs; return { status: "timeout", error: `OpenCode timed out after ${call.timeoutMs} ms.`, elapsedMs: call.timeoutMs }; },
  });
  assert.equal(result.error, "all-models-failed");
  assert.deepEqual(calls.map((c) => c.model), ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash"]);
  assert.ok(calls.reduce((sum, c) => sum + c.timeoutMs, 0) <= 300_000);
  assert.ok(calls.every((c) => c.timeoutMs <= DEFAULT_ATTEMPT_TIMEOUT_MS || calls.length === 1));
  assert.equal(calls[0].variant, "low");
  const text = formatAnalysisResult(result);
  assert.match(text, /1\. opencode\/deepseek-v4\.1-flash-free — timeout/);
  assert.match(text, /All CodeHelper attempts failed/);
});

test("analysis stops at the first success and the header lists the model and attempts", async () => {
  let now = 0;
  const result = await runAnalysis({
    directory, prompt: "q", nowImpl: () => now, models: [FREE[1], FREE[2]],
    runner: async (call) => {
      now += 500;
      return call.model === FREE[1].id ? { status: "failed", error: "OpenCode exited with code 1 after 500 ms.\nError: Rate limited", elapsedMs: 500 } : { text: "## Answer\nlook_at_screen", elapsedMs: 700 };
    },
  });
  assert.equal(result.model, "opencode/glm-5.3-flash-free");
  assert.equal(result.budgetMs, DEFAULT_BUDGET_MS);
  const text = formatAnalysisResult(result);
  assert.match(text, /- Model: opencode\/glm-5\.3-flash-free \(700 ms\)/);
  assert.match(text, /1\. opencode\/deepseek-v4\.1-flash-free — failed 500 ms .*exited with code 1/);
  assert.match(text, /Rate limited/);
  assert.match(text, /2\. opencode\/glm-5\.3-flash-free — ok 700 ms/);
  assert.match(text, /## Answer\nlook_at_screen/);
});

test("OpenCode runner launches the executable read-only with the model's variant", async () => {
  const calls = [];
  const runner = createOpenCodeRunner({ spawnImpl: scriptedSpawn(() => ({ stdout: '{"type":"text","text":"draft"}\n{"type":"text","text":"final analysis"}\n' }), calls), env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, platform: "win32", graceMs: 1 });
  const result = await runner({ directory, prompt: "inspect", model: "opencode/glm-5.3-flash-free", variant: "low" });
  assert.equal(result.text, "final analysis");
  const { executable, args, options } = calls[0];
  assert.equal(executable, "C:\\tools\\opencode.exe");
  assert.deepEqual(args.slice(0, 10), ["run", "--dir", directory, "--model", "opencode/glm-5.3-flash-free", "--variant", "low", "--agent", "plan", "--format", "json"].slice(0, 10));
  assert.match(args.at(-1), /Do not create, edit, delete/);
  assert.equal(options.shell, false);

  const noVariant = [];
  await createOpenCodeRunner({ spawnImpl: scriptedSpawn(() => ({ stdout: '{"type":"text","text":"x"}\n' }), noVariant), env: {} })({ directory, prompt: "p", model: "opencode/big-pickle" });
  assert.equal(noVariant[0].args.includes("--variant"), false);
});

test("request timeout drives the child timer and defaults to 120s", async () => {
  for (const [requested, expected] of [[60_000, 60_000], [undefined, 120_000]]) {
    const child = fakeChild();
    const timers = [];
    const runner = createOpenCodeRunner({ spawnImpl: () => child, setTimeoutImpl: (cb, delay) => { timers.push(delay); return timers.length; }, clearTimeoutImpl: () => {}, env: {} });
    const pending = runner({ directory, prompt: "x", model: "m/x", timeoutMs: requested });
    child.stdout.emit("data", '{"type":"text","text":"done"}\n');
    child.emit("close", 0);
    assert.equal((await pending).text, "done");
    assert.equal(timers[0], expected);
  }
});

test("failures return exit code, the NDJSON error, and a redacted stderr tail", async () => {
  const stderr = `${"noise ".repeat(400)}\nAPIError: 401 Unauthorized Authorization: Bearer abcdefghijklmnop123 api_key=sk-live-123456789 {"nvidia":{"type":"api","key":"nvapi-SECRETSECRETSECRET"}}`;
  const runner = createOpenCodeRunner({
    spawnImpl: scriptedSpawn(() => ({ code: 1, stdout: '{"type":"error","error":{"name":"ProviderModelNotFoundError","data":{"message":"Model not found: opencode/nope"}}}\n', stderr })),
    env: {},
  });
  const result = await runner({ directory, prompt: "x", model: "opencode/nope" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /exited with code 1/);
  assert.match(result.error, /Model not found: opencode\/nope/);
  assert.match(result.error, /401 Unauthorized/);
  assert.doesNotMatch(result.error, /abcdefghijklmnop123|sk-live|nvapi-SECRET|SECRETSECRET/);
  const tail = result.error.split("stderr (tail): ")[1];
  assert.ok(tail.length <= 1_600);

  const zeroExit = await createOpenCodeRunner({ spawnImpl: scriptedSpawn(() => ({ stdout: '{"type":"error","error":"quota exceeded"}\n' })), env: {} })({ directory, prompt: "x", model: "m/x" });
  assert.match(zeroExit.error, /quota exceeded/);

  const answeredThenFailed = await createOpenCodeRunner({ spawnImpl: scriptedSpawn(() => ({ code: 1, stdout: '{"type":"text","text":"answer"}\n' })), env: {} })({ directory, prompt: "x", model: "m/x" });
  assert.equal(answeredThenFailed.text, "answer");
  assert.match(answeredThenFailed.warning, /exited with code 1 after producing the answer/);
});

test("timeouts terminate the process tree and report elapsed ms", async () => {
  let now = 0;
  const child = fakeChild({ pid: 777 });
  const killed = [];
  let fire;
  const runner = createOpenCodeRunner({
    spawnImpl: () => child, nowImpl: () => now,
    setTimeoutImpl: (cb) => { fire ??= cb; return 1; }, clearTimeoutImpl: () => {},
    killProcessTreeImpl: (target) => { killed.push(target.pid); target.emit("close", null); }, env: {},
  });
  const pending = runner({ directory, prompt: "x", model: "m/x", timeoutMs: 5_000 });
  now = 5_003;
  fire();
  const result = await pending;
  assert.equal(result.status, "timeout");
  assert.match(result.error, /timed out after 5003 ms/);
  assert.deepEqual(killed, [777]);
});

test("OpenCode runner bounds stdout and terminates only its child", async () => {
  const child = fakeChild({ pid: 4321 });
  const killed = [];
  const runner = createOpenCodeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {}, killProcessTreeImpl: (target) => { killed.push(target.pid); target.emit("close", null); }, env: {} });
  const pending = runner({ directory, prompt: "inspect", model: "m/x" });
  child.stdout.emit("data", "x".repeat(OPENCODE_MAX_STDOUT_BYTES + 1));
  assert.match((await pending).error, /output exceeded the size limit/);
  assert.deepEqual(killed, [4321]);
});

test("spawn failures are reported clearly", async () => {
  const runner = createOpenCodeRunner({ spawnImpl: () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); }, env: {} });
  const result = await runner({ directory, prompt: "x", model: "m/x" });
  assert.match(result.error, /Could not start OpenCode \(ENOENT\)/);
});

test("NDJSON parser keeps final text and surfaces the real error message", () => {
  assert.deepEqual(parseOpenCodeNdjson('{"type":"text","text":"draft"}\n{"type":"text","text":"final"}'), { text: "final" });
  const err = parseOpenCodeNdjson('{"type":"error","error":{"name":"APIError","data":{"message":"Rate limit exceeded"}}}');
  assert.equal(err.detail, "Rate limit exceeded");
  assert.deepEqual(parseOpenCodeNdjson("plain text"), { error: "OpenCode returned no valid analysis." });
});

test("redaction removes bearer tokens, key-like strings, and auth.json contents", () => {
  const raw = 'Bearer abc.def.ghi1234 sk-proj-ABCDEF123456 gsk_1234567890abcdef apiKey: hunter2xyz api_key=topsecret {"opencode":{"type":"oauth","access":"a1","refresh":"r1","expires":1}} "token": "t0k3n" ghp_abcdefghijklmnopqrstuvwx';
  const red = redactSecrets(raw);
  for (const secret of ["abc.def.ghi1234", "sk-proj", "gsk_1234", "hunter2xyz", "topsecret", '"a1"', '"r1"', "t0k3n", "ghp_abc"]) assert.ok(!red.includes(secret), `${secret} leaked: ${red}`);
  assert.equal(redactSecrets("model nvidia/nvidia/llama-3_2-nemoretriever-300m-embed-v1 failed"), "model nvidia/nvidia/llama-3_2-nemoretriever-300m-embed-v1 failed");
});

test("MCP tools: list_free_models returns JSON with probes; analyze_code validates, auto-orders and uses canonical paths", async () => {
  const tools = new Map();
  const directories = [];
  const runnerCalls = [];
  const runner = async (call) => {
    runnerCalls.push(call);
    if (call.raw) return call.model.includes("nemotron") ? { status: "failed", error: "exit 1", elapsedMs: 3 } : { text: "OK", elapsedMs: 2 };
    directories.push(call.directory);
    return { text: `answer from ${call.model}`, elapsedMs: 10 };
  };
  const catalog = createModelCatalog({ runner, spawnImpl: scriptedSpawn(() => ({ stdout: VERBOSE_FIXTURE })), env: {} });
  registerAnalysisTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, { runner, catalog, resolveAllowedPath: async () => "C:\\Develop\\canonical", isAbsolute: path.win32.isAbsolute });

  const listed = JSON.parse((await tools.get("list_free_models").handler({ probe: true })).content[0].text);
  assert.equal(listed.count, 5);
  assert.match(listed.free_rule, /cost/);
  assert.equal(listed.models.find((m) => m.id === "opencode/nemotron-3-ultra-free").probe.status, "failed");
  assert.equal(listed.models.find((m) => m.id === "opencode/deepseek-v4.1-flash-free").probe.status, "ok");
  const nvidiaOnly = JSON.parse((await tools.get("list_free_models").handler({ provider: "nvidia" })).content[0].text);
  assert.deepEqual(nvidiaOnly.models.map((m) => m.id), ["nvidia/z-ai/glm-5.3-flash"]);

  const auto = await tools.get("analyze_code").handler({ directory, prompt: "inspect" });
  assert.equal(auto.isError, undefined);
  assert.match(auto.content[0].text, /- Model: opencode\/deepseek-v4\.1-flash-free/);
  assert.match(auto.content[0].text, /Selection: auto/);
  assert.doesNotMatch(auto.content[0].text, /Selection: auto \([^)]*nemotron/);

  const chosen = await tools.get("analyze_code").handler({ directory, prompt: "inspect", model: "nvidia/z-ai/glm-5.3-flash" });
  assert.match(chosen.content[0].text, /answer from nvidia\/z-ai\/glm-5\.3-flash/);
  assert.match(chosen.content[0].text, /Selection: caller/);

  const rejected = await tools.get("analyze_code").handler({ directory, prompt: "inspect", models: ["groq/qwen/qwen3.8-27b"] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Valid free model ids/);

  const relative = await tools.get("analyze_code").handler({ directory: "relative\\dir", prompt: "inspect" });
  assert.equal(relative.isError, true);
  assert.deepEqual([...new Set(directories)], ["C:\\Develop\\canonical"]);
});

test("canonical allowed-root resolution rejects junction escapes", async () => {
  const opts = (fn) => ({ realpathImpl: fn, pathImpl: path.win32 });
  const escaped = await resolvePathWithinAllowedRoots("C:\\Develop\\link", ["C:\\Develop"], opts(async (value) => String(value).endsWith("link") ? "C:\\Outside\\target" : value));
  assert.equal(escaped, null);
  const canonical = await resolvePathWithinAllowedRoots("C:\\Develop\\project", ["C:\\Develop"], opts(async (value) => String(value).endsWith("project") ? "C:\\Develop\\real-project" : value));
  assert.equal(canonical, "C:\\Develop\\real-project");
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
