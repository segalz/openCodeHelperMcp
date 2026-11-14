import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createModelCatalog, createOpenCodeRunner, providerLimitError, runAnalysis } from "../src/core.js";

const directory = "C:\\Develop\\sample";

const modelBlock = (id, { input = 0, output = 0, toolcall = true, status = "active" } = {}) => {
  const [providerID, ...rest] = id.split("/");
  const meta = { id: rest.join("/"), providerID, name: id, family: "f", status,
    cost: { input, output, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 },
    capabilities: { toolcall, input: { text: true } }, variants: {} };
  return `${id}\n${JSON.stringify(meta, null, 2)}\n`;
};

const FIXTURE = [
  modelBlock("opencode/glm-5.3-flash-free"),
  modelBlock("nvidia/z-ai/glm-5.3-flash"),
  modelBlock("cloudflare-workers-ai/@cf/openai/gpt-oss-120b", { input: 0.35, output: 0.75 }),
  modelBlock("cloudflare-workers-ai/@cf/meta/llama-guard-3-8b", { input: 0.48, output: 0.03, toolcall: false }),
  modelBlock("cloudflare-workers-ai/@cf/old/model", { input: 0.1, output: 0.1, status: "deprecated" }),
  modelBlock("groq/openai/gpt-oss-120b", { input: 0.15, output: 0.6 }),
].join("");

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  for (const name of ["stdout", "stderr"]) { child[name] = new EventEmitter(); child[name].setEncoding = () => {}; }
  child.pid = pid;
  return child;
}

const spawnFixture = () => (executable, args) => {
  const child = fakeChild();
  setImmediate(() => { child.stdout.emit("data", FIXTURE); child.emit("close", 0); });
  return child;
};

test("providers in OPENCODE_HELPER_FREE_PROVIDERS count as free, with the same tool and status filters", async () => {
  const catalog = createModelCatalog({ runner: async () => ({ text: "OK" }), spawnImpl: spawnFixture(),
    env: { OPENCODE_BIN: "C:\\tools\\opencode.exe", OPENCODE_HELPER_FREE_PROVIDERS: " cloudflare-workers-ai , other " } });
  const listed = await catalog.list();
  const ids = listed.models.map(m => m.id);
  assert.deepEqual(ids, ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash", "cloudflare-workers-ai/@cf/openai/gpt-oss-120b"]);
  const cf = listed.models.find(m => m.provider === "cloudflare-workers-ai");
  assert.equal(cf.freeBasis, "provider");
  assert.ok(!ids.includes("groq/openai/gpt-oss-120b"), "a provider not on the list stays paid");
});

test("without OPENCODE_HELPER_FREE_PROVIDERS the free list is unchanged", async () => {
  const catalog = createModelCatalog({ runner: async () => ({ text: "OK" }), spawnImpl: spawnFixture(), env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" } });
  const listed = await catalog.list();
  assert.deepEqual(listed.models.map(m => m.id), ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash"]);
});

const GROQ_TOO_LARGE = 'timestamp=2026-11-13T22:26:28.381Z level=ERROR run=9a93ebb3 message="stream error" providerID=groq error.error="AI_APICallError: Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17676, please reduce your message size and try again."\n';
const QUOTA_LINE = 'timestamp=2026-11-13T19:53:32.174Z level=ERROR run=1 message="stream error" error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode"\n';
const RETRY_429_LINE = 'timestamp=2026-11-13T19:53:38.109Z level=ERROR run=1 message="stream error" error.error="AI_RetryError: Failed after 3 attempts. Last error: Too Many Requests"\n';

test("providerLimitError classifies quota, exhausted rate-limit retries and requests too large for the tier", () => {
  assert.equal(providerLimitError(QUOTA_LINE)?.kind, "quota");
  assert.equal(providerLimitError(RETRY_429_LINE)?.kind, "rate_limit");
  assert.equal(providerLimitError(GROQ_TOO_LARGE)?.kind, "request_too_large");
  assert.match(providerLimitError(GROQ_TOO_LARGE)?.message, /Request too large/);
  assert.equal(providerLimitError('level=INFO message="Request too large"'), undefined);
  const gateway = 'level=ERROR message="stream error" error.error="AI_APICallError: All models exhausted: 1 route checked (1 rate-limited or on cooldown). Soonest reset ~2m."';
  assert.equal(providerLimitError(gateway)?.kind, "rate_limit");
});

for (const [line, kind] of [[QUOTA_LINE, "quota"], [RETRY_429_LINE, "rate_limit"], [GROQ_TOO_LARGE, "request_too_large"]]) {
  test(`runner stops at once and reports limitKind ${kind}`, async () => {
    const child = fakeChild(), killed = [];
    const runner = createOpenCodeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
      killProcessTreeImpl: target => { killed.push(target.pid); target.emit("close", null); }, env: {}, codeMapBuilder: async () => undefined });
    const pending = runner({ directory, prompt: "x", model: "groq/openai/gpt-oss-120b", timeoutMs: 240_000 });
    await new Promise(resolve => setImmediate(resolve));
    child.stderr.emit("data", line);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.quota, true);
    assert.equal(result.limitKind, kind);
    assert.match(result.error, /^OpenCode quota or rate limit: /);
    assert.deepEqual(killed, [4242]);
  });
}

test("runAnalysis records limitKind on the attempt and moves to the next model", async () => {
  const replies = [{ status: "failed", quota: true, limitKind: "quota", error: "OpenCode quota or rate limit: x" }, { text: "answer" }];
  const result = await runAnalysis({ directory, prompt: "p", budgetMs: 60_000, runner: async () => replies.shift(),
    models: [{ id: "opencode/a-free" }, { id: "nvidia/b" }] });
  assert.equal(result.text, "answer");
  assert.equal(result.attempts[0].limitKind, "quota");
  assert.equal(result.attempts[1].limitKind, undefined);
});
