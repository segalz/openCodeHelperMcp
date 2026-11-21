import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import * as core from "../src/core.js";
import { buildAutoOrder, createModelCatalog, parseVerboseModels, isUsableFreeModel, registerAnalysisTools } from "../src/core.js";

// Plan S8 (B3, D3): runtime limits are remembered with a cooldown ladder (quota per provider, rate limits per
// model), the auto order skips models that are cooling down, and the auto order is never empty.

const NOW = Date.parse("2026-11-19T10:00:00.000Z");

const modelBlock = (id) => {
  const [providerID, ...rest] = id.split("/");
  const meta = { id: rest.join("/"), providerID, name: id, family: "f", api: { id: rest.join("/"), url: "https://example.invalid", npm: "x" },
    status: "active", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 },
    capabilities: { toolcall: true, input: { text: true } }, variants: {} };
  return `${id}\n${JSON.stringify(meta, null, 2)}\n`;
};
const IDS = ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free", "opencode/big-pickle", "nvidia/z-ai/glm-5.3-flash", "nvidia/poolside/laguna-xs-2.1"];
const FIXTURE = IDS.map(modelBlock).join("");
const FREE = parseVerboseModels(FIXTURE).filter(isUsableFreeModel);
const byId = (id) => FREE.find((m) => m.id === id);

function scriptedSpawn(stdout) {
  return () => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => true;
    setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", 0); });
    return child;
  };
}

function catalogAt(clock, runner = async () => ({ text: "OK" })) {
  return createModelCatalog({ runner, spawnImpl: scriptedSpawn(FIXTURE), env: {}, nowImpl: () => clock.now });
}

// --- B3: the auto order is never empty ---------------------------------------

test("S8: when every probe failed and no preferred model is listed, the auto order still has models", () => {
  const order = buildAutoOrder(FREE, { recentProbe: () => ({ status: "failed" }), preferred: ["opencode/not-listed"] }).map((m) => m.id);
  assert.ok(order.length > 0);
  assert.equal(order.length, Math.min(FREE.length, core.MAX_AUTO_ATTEMPTS));
});

// --- D3: retry-after parsing -----------------------------------------------------

test("S8: retry delays in provider messages are parsed", () => {
  assert.equal(core.parseRetryAfterMs("free usage limit reached. Try again in 12m"), 720_000);
  assert.equal(core.parseRetryAfterMs("429 Too Many Requests, retry after 30s"), 30_000);
  assert.equal(core.parseRetryAfterMs('{"Retry-After": "45"}'), 45_000);
  assert.equal(core.parseRetryAfterMs("try again in 1h 30m"), 5_400_000);
  assert.equal(core.parseRetryAfterMs("Error at line 429"), undefined);
  assert.equal(core.parseRetryAfterMs("try again in 5 min"), 300_000);
  assert.equal(core.parseRetryAfterMs("try again in 2 mins"), 120_000);
  assert.equal(core.parseRetryAfterMs("try again in 1 hr 10 secs"), 3_610_000);
  assert.equal(core.parseRetryAfterMs("try again in 1 day"), 86_400_000);
});

// --- D3 + B3: limits remembered by the catalog ---------------------------------

test("S8: the ladder constants", () => {
  assert.deepEqual(core.RATE_LIMIT_LADDER_MS, [60_000, 180_000, 600_000, 1_800_000]);
  assert.equal(core.QUOTA_COOLDOWN_MS, 3_600_000);
});

test("S8: a rate limit cools only that model, and repeated ones climb the ladder to the top rung", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  const model = byId("nvidia/z-ai/glm-5.3-flash");
  const cooldowns = [];
  for (let i = 0; i < 5; i++) {
    clock.now = NOW + i * 10_000;
    catalog.recordLimit(model, { kind: "rate_limit", message: "Too Many Requests" });
    const limit = catalog.activeLimit(model);
    cooldowns.push(limit.until - clock.now);
    assert.equal(limit.strikes, i + 1);
    assert.equal(limit.kind, "rate_limit");
  }
  assert.deepEqual(cooldowns, [60_000, 180_000, 600_000, 1_800_000, 1_800_000]);
  assert.equal(catalog.activeLimit(byId("nvidia/poolside/laguna-xs-2.1")), undefined, "a rate limit is per model");
});

test("S8: rate limits less than 2 s apart count as one strike", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  const model = byId("nvidia/z-ai/glm-5.3-flash");
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  clock.now = NOW + 1_500;
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  assert.equal(catalog.activeLimit(model).strikes, 1);
});

test("S8: a quota cools every model of that provider, and only that provider", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  catalog.recordLimit(byId("opencode/deepseek-v4.1-flash-free"), { kind: "quota", message: "free usage limit reached" });
  const sibling = catalog.activeLimit(byId("opencode/big-pickle"));
  assert.equal(sibling?.kind, "quota");
  assert.equal(sibling.until - NOW, core.QUOTA_COOLDOWN_MS);
  assert.equal(catalog.activeLimit(byId("nvidia/z-ai/glm-5.3-flash")), undefined);
});

test("S8: a retry delay in the message sets the cooldown", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  catalog.recordLimit(byId("opencode/glm-5.3-flash-free"), { kind: "quota", message: "free usage limit reached. Try again in 12m" });
  assert.equal(catalog.activeLimit(byId("opencode/glm-5.3-flash-free")).until - NOW, 720_000);
  catalog.recordLimit(byId("nvidia/z-ai/glm-5.3-flash"), { kind: "rate_limit", message: "retry after 30s" });
  assert.equal(catalog.activeLimit(byId("nvidia/z-ai/glm-5.3-flash")).until - NOW, 30_000);
});

test("S8: a request too large for the tier is not remembered (it depends on the request)", () => {
  const catalog = catalogAt({ now: NOW });
  catalog.recordLimit(byId("nvidia/z-ai/glm-5.3-flash"), { kind: "request_too_large", message: "Request too large" });
  assert.equal(catalog.activeLimit(byId("nvidia/z-ai/glm-5.3-flash")), undefined);
});

test("S8: a cooldown ends at its time, and a success clears it and resets the ladder", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  const model = byId("nvidia/z-ai/glm-5.3-flash");
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  clock.now = NOW + 60_001;
  assert.equal(catalog.activeLimit(model), undefined);
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  assert.equal(catalog.activeLimit(model).strikes, 2);
  catalog.recordSuccess(model);
  assert.equal(catalog.activeLimit(model), undefined);
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  assert.equal(catalog.activeLimit(model).strikes, 1);
  catalog.recordLimit(byId("opencode/big-pickle"), { kind: "quota", message: "quota exceeded" });
  catalog.recordSuccess(byId("opencode/deepseek-v4.1-flash-free"));
  assert.equal(catalog.activeLimit(byId("opencode/big-pickle")), undefined, "a success on the provider ends its quota cooldown");
});

test("S8: the auto order puts cooling models last, and still returns them when nothing else is left", () => {
  const limited = new Set(["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"]);
  const activeLimit = (model) => limited.has(model.id) ? { kind: "rate_limit", until: NOW + 60_000, strikes: 1 } : undefined;
  const order = buildAutoOrder(FREE, { activeLimit, maxAttempts: 5 }).map((m) => m.id);
  assert.deepEqual(order.slice(-2), ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"]);
  const allLimited = buildAutoOrder(FREE, { activeLimit: () => ({ kind: "quota", until: NOW + 1, strikes: 1 }) });
  assert.ok(allLimited.length > 0);
});

// --- analyze_code remembers limits between calls -------------------------------

function tools({ clock, runner }) {
  const registry = new Map();
  const catalog = createModelCatalog({ runner, spawnImpl: scriptedSpawn(FIXTURE), env: {}, nowImpl: () => clock.now });
  registerAnalysisTools({ registerTool: (name, config, handler) => registry.set(name, { config, handler }) },
    { runner, catalog, resolveAllowedPath: async () => "C:\\Develop\\canonical", isAbsolute: path.win32.isAbsolute, nowImpl: () => clock.now });
  return { analyze: registry.get("analyze_code").handler, catalog };
}

test("S8: a runtime rate limit on model A is remembered, so the next auto call starts elsewhere", async () => {
  const clock = { now: NOW };
  const calls = [];
  const runner = async (call) => {
    calls.push(call.model);
    if (call.model === "opencode/deepseek-v4.1-flash-free") return { status: "failed", quota: true, limitKind: "rate_limit", error: "OpenCode quota or rate limit: AI_RetryError Too Many Requests" };
    return { text: `answer from ${call.model}`, elapsedMs: 5 };
  };
  const { analyze } = tools({ clock, runner });
  const first = await analyze({ directory: "C:\\Develop\\x", prompt: "inspect" });
  assert.match(first.content[0].text, /answer from opencode\/big-pickle/);
  calls.length = 0;
  clock.now += 5_000;
  const second = await analyze({ directory: "C:\\Develop\\x", prompt: "inspect" });
  assert.equal(calls[0], "opencode/big-pickle", "the rate-limited model is not tried first again");
  assert.match(second.content[0].text, /Selection: auto \(opencode\/big-pickle/);
});

test("S8: a runtime quota cools the whole provider for the next auto call", async () => {
  const clock = { now: NOW };
  const calls = [];
  const runner = async (call) => {
    calls.push(call.model);
    if (call.model.startsWith("opencode/")) return { status: "failed", quota: true, limitKind: "quota", error: "OpenCode quota or rate limit: free usage limit reached" };
    return { text: `answer from ${call.model}`, elapsedMs: 5 };
  };
  const { analyze } = tools({ clock, runner });
  await analyze({ directory: "C:\\Develop\\x", prompt: "inspect" });
  calls.length = 0;
  clock.now += 5_000;
  const second = await analyze({ directory: "C:\\Develop\\x", prompt: "inspect" });
  assert.ok(calls[0].startsWith("nvidia/"), `first call went to ${calls[0]}`);
  assert.equal(second.isError, undefined);
});

test("S8: a caller's chain keeps its order, but a model cooling down moves to the end", async () => {
  const clock = { now: NOW };
  const calls = [];
  const runner = async (call) => {
    calls.push(call.model);
    if (call.model === "nvidia/z-ai/glm-5.3-flash" && clock.now === NOW) return { status: "failed", quota: true, limitKind: "rate_limit", error: "OpenCode quota or rate limit: 429 Too Many Requests" };
    return { text: `answer from ${call.model}`, elapsedMs: 5 };
  };
  const { analyze } = tools({ clock, runner });
  const chain = { model: "nvidia/z-ai/glm-5.3-flash", models: ["nvidia/poolside/laguna-xs-2.1", "opencode/big-pickle"] };
  await analyze({ directory: "C:\\Develop\\x", prompt: "inspect", ...chain });
  assert.deepEqual(calls, ["nvidia/z-ai/glm-5.3-flash", "nvidia/poolside/laguna-xs-2.1"]);
  calls.length = 0;
  clock.now += 5_000;
  const second = await analyze({ directory: "C:\\Develop\\x", prompt: "inspect", ...chain });
  assert.deepEqual(calls, ["nvidia/poolside/laguna-xs-2.1"]);
  assert.match(second.content[0].text, /Selection: caller/);
});

// --- review round (Gemini 4 Neon xhigh) ----------------------------------------

test("S8 review: delay parsing does not misread unknown units, and reads escaped JSON and key=value", () => {
  assert.equal(core.parseRetryAfterMs("try again in 500 ms"), 500);
  assert.equal(core.parseRetryAfterMs("try again in 2 weeks"), undefined);
  assert.equal(core.parseRetryAfterMs('AI_RetryError: 429 {\\"Retry-After\\":\\"45\\"}'), 45_000);
  assert.equal(core.parseRetryAfterMs("retry-after=45"), 45_000);
});

test("S8 review: a cooldown is at least 5 s and at most 24 h, whatever the provider says", () => {
  const catalog = catalogAt({ now: NOW });
  catalog.recordLimit(byId("nvidia/z-ai/glm-5.3-flash"), { kind: "rate_limit", message: "Retry-After: 0" });
  assert.equal(catalog.activeLimit(byId("nvidia/z-ai/glm-5.3-flash")).until - NOW, 5_000);
  catalog.recordLimit(byId("opencode/big-pickle"), { kind: "quota", message: "Retry-After: 1794787200" });
  assert.equal(catalog.activeLimit(byId("opencode/big-pickle")).until - NOW, 86_400_000);
});

test("S8 review: a probe that hits a limit records it, and a probe that answers clears it", async () => {
  const clock = { now: NOW };
  const runner = async (call) => call.model === "opencode/big-pickle"
    ? { status: "failed", quota: true, limitKind: "quota", error: "OpenCode quota or rate limit: free usage limit reached" }
    : { text: "OK", elapsedMs: 3 };
  const catalog = catalogAt(clock, runner);
  catalog.recordLimit(byId("nvidia/z-ai/glm-5.3-flash"), { kind: "rate_limit", message: "429" });
  await catalog.probe([byId("opencode/big-pickle"), byId("nvidia/z-ai/glm-5.3-flash")], { refresh: true });
  assert.equal(catalog.activeLimit(byId("opencode/deepseek-v4.1-flash-free"))?.kind, "quota", "provider quota from the probe");
  assert.equal(catalog.activeLimit(byId("nvidia/z-ai/glm-5.3-flash")), undefined, "the probe answered, so the rate limit is cleared");
});

test("S8 review: a limit is kept on the attempt even when the stopped process may still run", async () => {
  const result = await core.runAnalysis({ directory: "C:\\Develop\\x", prompt: "p", budgetMs: 60_000, models: [byId("opencode/big-pickle"), byId("nvidia/z-ai/glm-5.3-flash")],
    runner: async () => ({ status: "failed", killConfirmed: false, quota: true, limitKind: "quota", error: "OpenCode quota or rate limit: free usage limit reached" }) });
  assert.equal(result.attempts[0].limitKind, "quota");
});

test("S8 review 2: a rate limit long after the last one starts the ladder again (30 min window, as in Cline)", () => {
  const clock = { now: NOW };
  const catalog = catalogAt(clock);
  const model = byId("nvidia/z-ai/glm-5.3-flash");
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  clock.now = NOW + 10_000;
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  assert.equal(catalog.activeLimit(model).strikes, 2);
  clock.now = NOW + 10_000 + core.RATE_LIMIT_STRIKE_WINDOW_MS + 1;
  catalog.recordLimit(model, { kind: "rate_limit", message: "429" });
  assert.equal(catalog.activeLimit(model).strikes, 1);
  assert.equal(catalog.activeLimit(model).until - clock.now, 60_000);
});
