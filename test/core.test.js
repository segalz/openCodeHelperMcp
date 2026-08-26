import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DEFAULT_VARIANT,
  OLLAMA_FALLBACK_URL,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_PRIMARY_URL,
  OLLAMA_THINK,
  OLLAMA_TOOL_DEFS,
  OPENCODE_MAX_STDOUT_BYTES,
  PROVIDERS,
  allocateProviderTimeoutMs,
  analysisInputSchema,
  createOllamaToolExecutor,
  createOllamaRunner,
  createOpenCodeRunner,
  defaultKillProcessTree,
  isBlockedOllamaName,
  isBlockedOllamaPath,
  isConnectionOrAddressFamilyError,
  parseOpenCodeNdjson,
  registerAnalysisTools,
  resolvePathWithinAllowedRoots,
  resolveSafeWorkspacePath,
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

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test("native Mac Ollama is the fixed first provider", () => {
  assert.deepEqual(PROVIDERS.map((provider) => provider.key), ["ollama", "nvidia", "mimo", "cloudflare"]);
  assert.equal(PROVIDERS[0].kind, "ollama");
  assert.equal(PROVIDERS[0].model, "qwen3.8:27b-mlx");
  assert.equal(OLLAMA_PRIMARY_URL, "http://Zvis-MacBook-Pro.local:11434/api/chat");
  assert.equal(OLLAMA_FALLBACK_URL, "http://10.100.102.8:11434/api/chat");
  assert.equal(OLLAMA_THINK, false);
  assert.equal(OLLAMA_KEEP_ALIVE, "30m");
});

test("NDJSON parser accepts only final text and rejects error output", () => {
  assert.deepEqual(parseOpenCodeNdjson('{"type":"text","text":"draft"}\n{"type":"text","text":"final"}'), { text: "final" });
  assert.deepEqual(parseOpenCodeNdjson('{"type":"error","error":"private"}'), { error: "OpenCode reported an analysis error." });
  assert.deepEqual(parseOpenCodeNdjson("plain text"), { error: "OpenCode returned no valid analysis." });
});

test("fallback stops after Ollama succeeds", async () => {
  let remoteCalls = 0;
  const result = await runWithFallback({
    directory,
    prompt: "inspect",
    ollamaRunner: async () => ({ text: "ollama answer" }),
    runner: async () => { remoteCalls += 1; return { text: "remote" }; },
  });
  assert.equal(result.provider, "ollama");
  assert.equal(remoteCalls, 0);
});

test("fallback advances from Ollama to NVIDIA, MiMo, and Cloudflare", async () => {
  for (const successIndex of [0, 1, 2]) {
    const calls = [];
    const result = await runWithFallback({
      directory,
      prompt: "inspect",
      ollamaRunner: async () => ({ error: "unavailable" }),
      runner: async (call) => {
        calls.push(call.model);
        return calls.length - 1 === successIndex ? { text: "answer" } : { error: "unavailable" };
      },
    });
    assert.equal(result.provider, PROVIDERS[successIndex + 1].key);
    assert.deepEqual(calls, PROVIDERS.slice(1, successIndex + 2).map((provider) => provider.model));
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
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[1].model });
  child.stdout.emit("data", '{"type":"text","text":"final analysis"}\n');
  child.emit("close", 0);
  assert.deepEqual(await pending, { text: "final analysis" });
  const [executable, args, options] = invocations[0];
  assert.equal(executable, "C:\\tools\\opencode.exe");
  assert.deepEqual(args.slice(0, 10), ["run", "--dir", directory, "--model", PROVIDERS[1].model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format"]);
  assert.equal(options.shell, false);
});

test("Grok-selected provider timeout overrides the OpenCode default timeout", async () => {
  const child = fakeChild();
  const timers = [];
  const runner = createOpenCodeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe", OPENCODE_HELPER_TIMEOUT_MS: "40000" },
    platform: "win32",
  });
  const pending = runner({ directory, prompt: "deep review", model: PROVIDERS[1].model, timeoutMs: 60_000 });
  child.stdout.emit("data", '{"type":"text","text":"complete"}\n');
  child.emit("close", 0);
  assert.deepEqual(await pending, { text: "complete" });
  assert.equal(timers[0].delay, 60_000);
});

test("all MCP tools keep provider settings internal", async () => {
  const tools = new Map();
  registerAnalysisTools(
    { registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    {
      runner: async ({ model }) => ({ text: model }),
      ollamaRunner: async ({ model }) => ({ text: model }),
      resolveAllowedPath: async (value) => value,
    },
  );
  assert.deepEqual(Object.keys(analysisInputSchema), ["directory", "prompt", "maxWords", "budgetMs"]);
  assert.equal(tools.size, 5);
  assert.match(tools.get("analyze_code").config.description, /native Mac Ollama/);
  for (const provider of PROVIDERS) {
    const tool = tools.get(`analyze_code_${provider.key}`);
    assert.deepEqual(Object.keys(tool.config.inputSchema), ["directory", "prompt", "maxWords", "budgetMs"]);
    const response = await tool.handler({ directory, prompt: "inspect" });
    assert.equal(response.content[0].text, provider.model);
  }
});

test("only connection and address-family failures qualify for IPv4 fallback", () => {
  assert.equal(isConnectionOrAddressFamilyError({ code: "ENOTFOUND" }), true);
  assert.equal(isConnectionOrAddressFamilyError({ message: "fetch failed", cause: { code: "EAI_AGAIN" } }), true);
  assert.equal(isConnectionOrAddressFamilyError({ message: "HTTP 500" }), false);
});

test("Ollama success posts a fixed native chat payload", async () => {
  const posts = [];
  const runner = createOllamaRunner({
    fetchImpl: async (url, init) => {
      posts.push({ url, init });
      return jsonResponse({ message: { role: "assistant", content: "final ollama" } });
    },
  });
  assert.deepEqual(await runner({ directory, prompt: "map architecture", model: PROVIDERS[0].model, timeoutMs: 5_000 }), { text: "final ollama" });
  const body = JSON.parse(posts[0].init.body);
  assert.equal(posts[0].url, OLLAMA_PRIMARY_URL);
  assert.equal(posts[0].init.method, "POST");
  assert.equal(body.model, "qwen3.8:27b-mlx");
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "30m");
  assert.deepEqual(body.tools, OLLAMA_TOOL_DEFS);
  assert.equal(Object.hasOwn(body, "prompt"), false);
});

test("Ollama falls back to IPv4 only on a connection failure", async () => {
  const posts = [];
  const runner = createOllamaRunner({
    fetchImpl: async (url) => {
      posts.push(url);
      if (url === OLLAMA_PRIMARY_URL) throw Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
      return jsonResponse({ message: { role: "assistant", content: "via ipv4" } });
    },
  });
  assert.deepEqual(await runner({ directory, prompt: "inspect", model: PROVIDERS[0].model, timeoutMs: 5_000 }), { text: "via ipv4" });
  assert.deepEqual(posts, [OLLAMA_PRIMARY_URL, OLLAMA_FALLBACK_URL]);

  const httpPosts = [];
  const httpRunner = createOllamaRunner({
    fetchImpl: async (url) => { httpPosts.push(url); return jsonResponse({ error: "busy" }, 503); },
  });
  assert.match((await httpRunner({ directory, prompt: "inspect", model: PROVIDERS[0].model, timeoutMs: 5_000 })).error, /HTTP 503/);
  assert.deepEqual(httpPosts, [OLLAMA_PRIMARY_URL]);
});

test("Ollama executes a bounded read-only tool loop", async () => {
  let round = 0;
  const runner = createOllamaRunner({
    fetchImpl: async (_url, init) => {
      round += 1;
      const body = JSON.parse(init.body);
      if (round === 1) {
        return jsonResponse({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/a.js" } } }] } });
      }
      assert.match(body.messages.find((message) => message.role === "tool").content, /const x = 1/);
      return jsonResponse({ message: { role: "assistant", content: "saw const" } });
    },
    readFileImpl: async () => "const x = 1;\n",
    realpathImpl: async (value) => value,
    statImpl: async () => ({ isFile: () => true }),
  });
  assert.deepEqual(await runner({ directory, prompt: "read a", model: PROVIDERS[0].model, timeoutMs: 5_000 }), { text: "saw const" });
});

test("Ollama rejects traversal and symlink escapes", async () => {
  const traversal = await resolveSafeWorkspacePath(directory, "../outside", { realpathImpl: async (value) => value });
  assert.match(traversal.error, /escapes/);
  const linkEscape = await resolveSafeWorkspacePath(directory, "evil", {
    realpathImpl: async (value) => (String(value).endsWith("evil") ? "C:\\Outside\\file.txt" : value),
  });
  assert.match(linkEscape.error, /link/);
});

test("Ollama rejects malformed output, unknown tools, round caps, and late replies", async () => {
  const malformed = createOllamaRunner({ fetchImpl: async () => jsonResponse({ message: null }) });
  assert.match((await malformed({ directory, prompt: "x", model: PROVIDERS[0].model, timeoutMs: 1_000 })).error, /no valid analysis/);

  const badTool = createOllamaRunner({
    fetchImpl: async () => jsonResponse({ message: { role: "assistant", tool_calls: [{ function: { name: "shell", arguments: { cmd: "rm" } } }] } }),
  });
  assert.match((await badTool({ directory, prompt: "x", model: PROVIDERS[0].model, timeoutMs: 1_000 })).error, /unknown tool/);

  const capped = createOllamaRunner({
    maxRounds: 1,
    fetchImpl: async () => jsonResponse({ message: { role: "assistant", tool_calls: [{ function: { name: "list_files", arguments: { path: "." } } }] } }),
    readdirImpl: async () => [],
    realpathImpl: async (value) => value,
  });
  assert.match((await capped({ directory, prompt: "x", model: PROVIDERS[0].model, timeoutMs: 5_000 })).error, /round cap/);

  let now = 0;
  const late = createOllamaRunner({
    nowImpl: () => now,
    fetchImpl: async () => { now = 100; return jsonResponse({ message: { role: "assistant", content: "late" } }); },
  });
  assert.match((await late({ directory, prompt: "x", model: PROVIDERS[0].model, timeoutMs: 10 })).error, /timed out/);
});

test("Ollama never calls destructive endpoints", async () => {
  const seen = [];
  const runner = createOllamaRunner({
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method });
      assert.equal(init.method, "POST");
      assert.match(url, /\/api\/chat$/);
      assert.doesNotMatch(url, /\/api\/(generate|pull|push|delete|create)/);
      return jsonResponse({ message: { role: "assistant", content: "ok" } });
    },
  });
  await runner({ directory, prompt: "x", model: PROVIDERS[0].model, timeoutMs: 1_000 });
  assert.equal(seen.length, 1);
});

test("canonical allowed-root resolution rejects junction escapes and returns the real path", async () => {
  const escaped = await resolvePathWithinAllowedRoots("C:\\Develop\\link", ["C:\\Develop"], {
    realpathImpl: async (value) => String(value).endsWith("link") ? "C:\\Outside\\target" : value,
  });
  assert.equal(escaped, null);

  const canonical = await resolvePathWithinAllowedRoots("C:\\Develop\\project", ["C:\\Develop"], {
    realpathImpl: async (value) => String(value).endsWith("project") ? "C:\\Develop\\real-project" : value,
  });
  assert.equal(canonical, "C:\\Develop\\real-project");
});

test("MCP handlers pass only the canonical allowed path to providers", async () => {
  const tools = new Map();
  const directories = [];
  registerAnalysisTools(
    { registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    {
      runner: async ({ directory: value }) => { directories.push(value); return { text: "remote" }; },
      ollamaRunner: async ({ directory: value }) => { directories.push(value); return { text: "local" }; },
      resolveAllowedPath: async () => "C:\\Develop\\canonical",
    },
  );
  const response = await tools.get("analyze_code").handler({ directory, prompt: "inspect" });
  assert.equal(response.isError, undefined);
  assert.deepEqual(directories, ["C:\\Develop\\canonical"]);
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
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[1].model });
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
  const pending = runner({ directory, prompt: "inspect", model: PROVIDERS[1].model });
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

test("Ollama rejects oversized files before reading them", async () => {
  let reads = 0;
  const execute = createOllamaToolExecutor({
    workspaceRoot: directory,
    realpathImpl: async (value) => value,
    statImpl: async () => ({ isFile: () => true, size: 70_000 }),
    readFileImpl: async () => { reads += 1; return "too large"; },
  });
  assert.match((await execute("read_file", { path: "big.js" })).error, /size limit/);
  assert.equal(reads, 0);
});

test("Ollama search skips oversized files before reading them", async () => {
  let reads = 0;
  const execute = createOllamaToolExecutor({
    workspaceRoot: directory,
    realpathImpl: async (value) => value,
    readdirImpl: async () => [{ name: "big.js", isDirectory: () => false }],
    statImpl: async () => ({ isFile: () => true, size: 70_000 }),
    readFileImpl: async () => { reads += 1; return "needle"; },
  });
  assert.equal((await execute("search_text", { query: "needle" })).text, "(no matches)");
  assert.equal(reads, 0);
});

test("Ollama blocks hidden and credential paths in list search and direct read", async () => {
  assert.equal(isBlockedOllamaName(".env"), true);
  assert.equal(isBlockedOllamaName("id_rsa"), true);
  assert.equal(isBlockedOllamaName("cert.pem"), true);
  assert.equal(isBlockedOllamaName("src.js"), false);
  assert.equal(isBlockedOllamaPath("config/.private/token.txt"), true);

  let reads = 0;
  const execute = createOllamaToolExecutor({
    workspaceRoot: directory,
    realpathImpl: async (value) => value,
    readdirImpl: async () => [
      { name: ".env", isDirectory: () => false },
      { name: "NODE_MODULES", isDirectory: () => true },
      { name: "ok.js", isDirectory: () => false },
    ],
    statImpl: async () => ({ isFile: () => true, size: 6 }),
    readFileImpl: async () => { reads += 1; return "KEY=1\n"; },
  });
  assert.equal((await execute("list_files", { path: "." })).text, "file\tok.js");
  assert.match((await execute("read_file", { path: ".env" })).error, /blocked/);
  assert.match((await execute("search_text", { query: "KEY" })).text, /ok\.js:1:KEY=1/);
  assert.equal(reads, 1);
});

test("Ollama search does not recurse through a junction cycle", async () => {
  let listings = 0;
  const execute = createOllamaToolExecutor({
    workspaceRoot: directory,
    realpathImpl: async (value) => String(value).endsWith("loop") ? directory : value,
    readdirImpl: async () => {
      listings += 1;
      return [{ name: "loop", isDirectory: () => true }];
    },
  });
  assert.equal((await execute("search_text", { query: "needle" })).text, "(no matches)");
  assert.equal(listings, 1);
});

test("Grok-selected total budget is dynamically allocated without duplicate provider calls", async () => {
  const quick = allocateProviderTimeoutMs(PROVIDERS, 0, 90_000);
  const deep = allocateProviderTimeoutMs(PROVIDERS, 0, 270_000);
  assert.ok(deep > quick);

  let now = 0;
  const calls = [];
  const fail = async (call) => {
    calls.push({ model: call.model, timeoutMs: call.timeoutMs });
    now += call.timeoutMs;
    return { error: "timed out" };
  };
  const result = await runWithFallback({
    directory,
    prompt: "deep review",
    budgetMs: 270_000,
    nowImpl: () => now,
    ollamaRunner: fail,
    runner: fail,
  });
  assert.equal(result.error, "all-providers-failed");
  assert.deepEqual(calls.map((call) => call.model), PROVIDERS.map((provider) => provider.model));
  assert.equal(new Set(calls.map((call) => call.model)).size, PROVIDERS.length);
  assert.ok(calls.reduce((sum, call) => sum + call.timeoutMs, 0) <= 270_000);
});
