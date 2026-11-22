import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createModelCatalog } from "../src/core.js";

// Live use 2026-11-22 (F10 live check): under load one helper's `opencode models --verbose` failed once,
// the catalog silently fell back to the name rule (no nvidia/* models), cached it for the full TTL,
// and an edit with a valid nvidia model was refused.

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end() {}, write() {}, destroy() {} };
  child.pid = 4321; child.kill = () => true;
  return child;
}
function scriptedSpawn(script, calls = []) {
  return (executable, args, options) => {
    const child = fakeChild();
    calls.push(args);
    const reply = script(args, calls.length) ?? {};
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit("data", reply.stdout);
      if (reply.stderr) child.stderr.emit("data", reply.stderr);
      child.emit("close", reply.code ?? 0);
    });
    return child;
  };
}
const block = (id) => {
  const [providerID, ...rest] = id.split("/");
  return `${id}\n${JSON.stringify({ id: rest.join("/"), providerID, name: id, status: "active",
    cost: { input: 0, output: 0 }, capabilities: { toolcall: true }, limit: { context: 1000, output: 100 }, variants: {} }, null, 2)}\n`;
};
const VERBOSE = block("opencode/a-free") + block("nvidia/vendor/model-x");
const PLAIN = "opencode/a-free\nnvidia/vendor/model-x\n";

test("a failed verbose listing is retried once before the name-rule fallback", async () => {
  const calls = [];
  let verboseRuns = 0;
  const catalog = createModelCatalog({ runner: async () => ({}), env: {}, listRetryDelayMs: 0,
    spawnImpl: scriptedSpawn((args) => {
      if (args.includes("--verbose")) return ++verboseRuns === 1 ? { code: 1, stderr: "database is locked" } : { stdout: VERBOSE };
      return { stdout: PLAIN };
    }, calls) });
  const listed = await catalog.list();
  assert.equal(listed.source, "opencode models --verbose");
  assert.ok(listed.models.some((m) => m.id === "nvidia/vendor/model-x"));
  assert.equal(verboseRuns, 2);
  assert.equal(calls.filter((a) => !a.includes("--verbose")).length, 0);
});

test("a name-rule fallback is marked degraded, names the reason and is cached only briefly", async () => {
  let now = 0;
  let verboseOk = false;
  const catalog = createModelCatalog({ runner: async () => ({}), env: {}, listRetryDelayMs: 0, nowImpl: () => now,
    spawnImpl: scriptedSpawn((args) => {
      if (args.includes("--verbose")) return verboseOk ? { stdout: VERBOSE } : { code: 1, stderr: "database is locked" };
      return { stdout: PLAIN };
    }) });
  const degraded = await catalog.list();
  assert.equal(degraded.source, "opencode models (name rule)");
  assert.equal(degraded.degraded, true);
  assert.match(degraded.degradedReason, /database is locked/);
  assert.ok(!degraded.models.some((m) => m.id === "nvidia/vendor/model-x"));
  verboseOk = true;
  now += 31_000; // well inside the normal 10-minute TTL
  const healed = await catalog.list();
  assert.equal(healed.source, "opencode models --verbose");
  assert.ok(healed.models.some((m) => m.id === "nvidia/vendor/model-x"));
});

test("a required model missing from a degraded list triggers one fresh listing before refusing", async () => {
  let verboseCalls = 0;
  const catalog = createModelCatalog({ runner: async () => ({}), env: {}, listRetryDelayMs: 0,
    spawnImpl: scriptedSpawn((args) => {
      if (args.includes("--verbose")) return ++verboseCalls <= 2 ? { code: 1, stderr: "database is locked" } : { stdout: VERBOSE };
      return { stdout: PLAIN };
    }) });
  const first = await catalog.list();
  assert.equal(first.degraded, true);
  const required = await catalog.list({ require: ["nvidia/vendor/model-x"] });
  assert.equal(required.source, "opencode models --verbose");
  assert.ok(required.models.some((m) => m.id === "nvidia/vendor/model-x"));
});
