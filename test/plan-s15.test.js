import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeMap } from "../src/codemap.js";
import { parseRetryAfterMs } from "../src/core.js";
import { withProgressHeartbeat } from "../src/progress.js";
import { registerEditTools } from "../src/edits.js";

// Plan S15 (review items C7/C8, D5, and the leftovers recorded for S15 in S9 and Gate 2).
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("S15 (S9 leftover): buildCodeMap without CODEINDEX_CLI propagates caller cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-s15-map-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "main.js"), "export function current() {}\n");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(buildCodeMap(root, { env: {}, signal: controller.signal }), (error) => error?.name === "AbortError");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("S15 (Gate 2 leftover): parseRetryAfterMs reads FreeLLMAPI's 'Soonest reset ~89s'", () => {
  assert.equal(parseRetryAfterMs("All free models are rate limited. Soonest reset ~89s"), 89_000);
  assert.equal(parseRetryAfterMs("Soonest reset ~2m 5s"), 125_000);
  assert.equal(parseRetryAfterMs("soonest reset: ~30 seconds"), 30_000);
  // Existing forms still work, and a bare "reset" word elsewhere is not a delay.
  assert.equal(parseRetryAfterMs("Please try again in 12m"), 720_000);
  assert.equal(parseRetryAfterMs("The counter will reset 5 times"), undefined);
});

test("S15 D5: a progress token gets a heartbeat while the call runs and none after it ends", async () => {
  const sent = [];
  const extra = { _meta: { progressToken: "tok-1" }, sendNotification: async (n) => { sent.push(n); } };
  // The work ends only after two heartbeats arrived, so a slow event loop cannot make this flaky.
  const until = Date.now() + 20_000;
  const result = await withProgressHeartbeat(extra, async () => {
    while (sent.length < 2) { assert.ok(Date.now() < until, "no heartbeat"); await delay(5); }
    return "value";
  }, { intervalMs: 20 });
  assert.equal(result, "value");
  for (const [i, n] of sent.entries()) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "tok-1");
    assert.equal(n.params.progress, i + 1);
    assert.equal(typeof n.params.message, "string");
  }
  const count = sent.length; await delay(80);
  assert.equal(sent.length, count, "no heartbeat after the call settled");
});

test("S15 D5: no progress token means no notifications; a failing send never fails the call", async () => {
  const sent = [];
  assert.equal(await withProgressHeartbeat({ sendNotification: async (n) => { sent.push(n); } },
    async () => { await delay(60); return 1; }, { intervalMs: 10 }), 1);
  assert.equal(sent.length, 0);
  assert.equal(await withProgressHeartbeat({}, async () => 3, { intervalMs: 10 }), 3);
  const failing = { _meta: { progressToken: 7 }, sendNotification: async () => { throw new Error("transport closed"); } };
  assert.equal(await withProgressHeartbeat(failing, async () => { await delay(60); return 2; }, { intervalMs: 10 }), 2);
  await assert.rejects(withProgressHeartbeat(failing, async () => { await delay(30); throw new Error("work failed"); }, { intervalMs: 10 }), /work failed/);
});

// ---- Codex review of S15 ----

test("S15 review: an empty-string progress token is valid and gets heartbeats", async () => {
  const sent = [];
  const extra = { _meta: { progressToken: "" }, sendNotification: async (n) => { sent.push(n); } };
  const deadline = Date.now() + 20_000;
  await withProgressHeartbeat(extra, async () => {
    while (sent.length < 2) { assert.ok(Date.now() < deadline, "no heartbeat"); await delay(5); }
  }, { intervalMs: 10 });
  assert.deepEqual(sent.map((n) => n.params.progress), sent.map((_, i) => i + 1));
  assert.equal(sent[0].params.progressToken, "");
});

test("S15 review: a failing send is really attempted and still never fails the call", async () => {
  let attempts = 0;
  const failing = { _meta: { progressToken: 7 }, sendNotification: async () => { attempts += 1; throw new Error("transport closed"); } };
  const deadline = Date.now() + 20_000;
  assert.equal(await withProgressHeartbeat(failing, async () => {
    while (attempts < 2) { assert.ok(Date.now() < deadline, "send never attempted"); await delay(5); }
    return 2;
  }, { intervalMs: 10 }), 2);
});

test("S15 review: a cancel during the file scan (no CODEINDEX_CLI) propagates instead of returning no map", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-s15-scan-"));
  try {
    await writeFile(path.join(root, "main.js"), "export function current() {}\n");
    const controller = new AbortController();
    // Git lists the files, and the caller cancels while that listing is running.
    const spawnImpl = () => {
      const c = new EventEmitter(); c.pid = 42;
      c.stdin = { on() {}, write() {}, end() {} };
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdout.setEncoding = c.stderr.setEncoding = () => {}; c.stderr.resume = () => {};
      c.kill = () => c.emit("close", null);
      setImmediate(() => { controller.abort(); c.stdout.emit("data", Buffer.from("main.js\0")); c.emit("close", 0); });
      return c;
    };
    await assert.rejects(buildCodeMap(root, { env: {}, spawnImpl, signal: controller.signal }), (error) => error?.name === "AbortError");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("S15 review: apply_opencode_edits reports a caller cancel before launch as cancelled, a spent budget as budget_exceeded", async () => {
  const call = async (signal, nowImpl) => {
    const tools = new Map();
    registerEditTools({ registerTool: (name, _config, handler) => tools.set(name, handler) }, {
      runner: () => assert.fail("no model"), resolveAllowedPath: async (dir) => dir, ...(nowImpl ? { nowImpl } : {}),
      catalog: { list: () => new Promise(() => {}) } });
    const out = await tools.get("apply_opencode_edits")({ directory: path.resolve("."), prompt: "Fix", model: "opencode/test-free",
      verify: { none: true, reason: "cancel classification test" }, codeMap: false }, { signal });
    assert.equal(out.isError, true);
    return JSON.parse(out.content[0].text).error;
  };
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await call(cancelled.signal), "cancelled");
  // The clock jumps past the whole budget, so the preparation deadline fires at once.
  let t = 0;
  assert.equal(await call(new AbortController().signal, () => { const now = t; t += 10_000_000; return now; }), "budget_exceeded");
});
