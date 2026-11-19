import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import { createModelCatalog, createOpenCodeRunner, runAnalysis, shutdownAnalysis } from "../src/core.js";

// Plan S13 review (Codex GPT-6.2-Astra high). Server shutdown is final: once shutdownAnalysis() runs,
// (1) a cancelled run is reported as cancelled even if OpenCode had already printed a quota line, so the
//     analysis does not fall back to the next model, and
// (2) no further OpenCode child starts at all (fallback models, queued probes, new calls).
// This file runs in its own process, so the module-wide shutdown does not leak into other test files.

const directory = "C:\\Develop\\sample";
// Not newline-terminated: the runner only sees it after the stop, when it parses the stderr tail.
const QUOTA_TAIL = 'timestamp=2026-11-13T19:53:32.174Z level=ERROR run=29ea3636 message="stream error" providerID=opencode modelID=glm-5.3-flash-free error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"';

function hangingChild(onSpawn) {
  const child = new EventEmitter();
  child.pid = 5150;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  setImmediate(() => onSpawn?.(child));
  return child;
}

test("S13 review 1: shutdown during a run whose stderr holds a quota line reports cancelled and starts no fallback model", async () => {
  const spawned = [];
  const runner = createOpenCodeRunner({ env: {}, platform: "win32", codeMapBuilder: async () => undefined, graceMs: 10,
    spawnImpl: () => hangingChild(child => { spawned.push(child); child.stderr.emit("data", QUOTA_TAIL); }),
    killProcessTreeImpl: target => { target.emit("close", null); } });
  const pending = runAnalysis({ directory, prompt: "Explain.", maxWords: 100, budgetMs: 120_000, codeMap: false, runner,
    models: [{ id: "opencode/first-free" }, { id: "nvidia/second" }] });
  while (spawned.length === 0) await new Promise(resolve => setImmediate(resolve));
  await shutdownAnalysis();
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still running"), 5_000))]);
  assert.notEqual(result, "still running");
  assert.equal(spawned.length, 1, "no fallback model may start after shutdown");
  assert.equal(result.cancelled, true, JSON.stringify(result).slice(0, 400));
});

test("S13 review 2: after shutdown no runner call or queued probe starts an OpenCode child", async () => {
  await shutdownAnalysis();
  let spawns = 0;
  const runner = createOpenCodeRunner({ env: {}, platform: "win32", codeMapBuilder: async () => undefined, graceMs: 10,
    spawnImpl: () => { spawns++; return hangingChild(child => child.emit("close", 0)); },
    killProcessTreeImpl: target => { target.emit("close", null); } });
  const result = await runner({ directory, prompt: "Explain.", model: "opencode/free", timeoutMs: 30_000, maxWords: 100, codeMap: false });
  assert.equal(spawns, 0);
  assert.equal(result.cancelled, true);
  const catalog = createModelCatalog({ runner });
  await catalog.probe?.([{ id: "opencode/a-free" }, { id: "opencode/b-free" }], { refresh: true });
  assert.equal(spawns, 0, "queued probes must not start after shutdown");
});
