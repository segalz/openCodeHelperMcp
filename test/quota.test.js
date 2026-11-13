import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createOpenCodeRunner } from "../src/core.js";

const directory = "C:\\Develop\\sample";

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  for (const name of ["stdout", "stderr"]) { child[name] = new EventEmitter(); child[name].setEncoding = () => {}; }
  child.pid = pid;
  return child;
}

function hangingRunner(child, killed, calls = []) {
  return createOpenCodeRunner({
    spawnImpl: (executable, args) => { calls.push(args); return child; },
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
    killProcessTreeImpl: target => { killed.push(target.pid); target.emit("close", null); },
    env: {}, codeMapBuilder: async () => undefined,
  });
}

const QUOTA_LINE = 'timestamp=2026-11-13T19:53:32.174Z level=ERROR run=29ea3636 message="stream error" providerID=opencode modelID=glm-5.3-flash-free error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"\n';
const RETRY_429_LINE = 'timestamp=2026-11-13T19:53:38.109Z level=ERROR run=1 message="stream error" providerID=nvidia error.error="AI_RetryError: Failed after 3 attempts. Last error: Too Many Requests"\n';
const SINGLE_429_LINE = 'timestamp=2026-11-13T19:53:33.000Z level=ERROR run=1 message="stream error" providerID=nvidia error.error="AI_APICallError: Too Many Requests"\n';

test("runner asks OpenCode for error-level logs on stderr", async () => {
  const child = fakeChild(), killed = [], calls = [];
  const pending = hangingRunner(child, killed, calls)({ directory, prompt: "x", model: "opencode/glm-5.3-flash-free" });
  await new Promise(resolve => setImmediate(resolve));
  child.emit("close", 0);
  await pending;
  const args = calls[0];
  assert.ok(args.includes("--print-logs"), "missing --print-logs");
  assert.equal(args[args.indexOf("--log-level") + 1], "ERROR");
});

test("an exhausted free quota stops the attempt at once instead of waiting for the timeout", async () => {
  const child = fakeChild(), killed = [];
  const pending = hangingRunner(child, killed)({ directory, prompt: "x", model: "opencode/glm-5.3-flash-free", timeoutMs: 240_000 });
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.emit("data", QUOTA_LINE);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.quota, true);
  assert.match(result.error, /quota/i);
  assert.match(result.error, /Free usage limit reached/);
  assert.deepEqual(killed, [4242]);
});

test("rate limiting stops the attempt only after OpenCode's own retries are exhausted", async () => {
  const child = fakeChild(), killed = [];
  const pending = hangingRunner(child, killed)({ directory, prompt: "x", model: "nvidia/x", timeoutMs: 240_000 });
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.emit("data", SINGLE_429_LINE);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(killed, [], "a single 429 must leave OpenCode's retry running");
  child.stderr.emit("data", RETRY_429_LINE);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.quota, true);
  assert.match(result.error, /Too Many Requests/);
  assert.deepEqual(killed, [4242]);
});

test("a quota line split across stderr chunks is still detected", async () => {
  const child = fakeChild(), killed = [];
  const pending = hangingRunner(child, killed)({ directory, prompt: "x", model: "opencode/glm-5.3-flash-free" });
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.emit("data", QUOTA_LINE.slice(0, 150));
  child.stderr.emit("data", QUOTA_LINE.slice(150));
  const result = await pending;
  assert.equal(result.quota, true);
});
