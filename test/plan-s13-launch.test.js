import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import * as core from "../src/core.js";
import { createOpenCodeRunner } from "../src/core.js";
import { permissionEnvironment } from "../src/permissions.js";

// Plan S13 (review items C3, C6, D5).
// C3: Next.js / SvelteKit folders such as `app/[id]` or `routes/{slug}` in the ignored-path list must not
//     stop the launch. OpenCode 1.19.5 treats `[ ] { }` in permission patterns literally (only `*` and `?`
//     are wildcards), so these paths are denied as they are.
// C6: the OpenCode child runs with GIT_OPTIONAL_LOCKS=0, and server shutdown stops running analysis children.
// D5: the prompt reaches OpenCode on stdin, so a long repair prompt is not bound by the Windows command line.

const directory = "C:\\Develop\\sample";
const ANSWER = '{"type":"text","part":{"type":"text","text":"answer"}}\n{"type":"text","text":"answer"}\n';

/** A fake OpenCode child that records what it receives on stdin. */
function fakeChild({ hang = false } = {}) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.received = "";
  child.stdinEnded = false;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { child.received += chunk.toString("utf8"); callback(); },
    final(callback) { child.stdinEnded = true; callback(); },
  });
  child.kill = () => child.emit("close", null);
  if (!hang) setImmediate(() => { child.stdout.emit("data", ANSWER); child.emit("close", 0); });
  return child;
}

function recordingSpawn(calls, options = {}) {
  return (executable, args, spawnOptions) => {
    const child = fakeChild(options);
    calls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
}

function deniedReads(env) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  const agent = Object.values(config.agent)[0];
  return agent.permission.read;
}

test("S13 C3: ignored paths with [id], [...slug] and {slug} are denied literally instead of failing the launch", () => {
  const ignored = ["app/[id]/page.tsx", "pages/[...slug].tsx", "src/routes/{slug}/", "src/routes/[[lang]]/+page.svelte"];
  for (const mode of ["analysis", "edits"]) {
    const env = permissionEnvironment({}, mode, ignored, "C:/Develop/site");
    const read = deniedReads(env);
    assert.equal(read["app/[id]/page.tsx"], "deny");
    assert.equal(read["pages/[...slug].tsx"], "deny");
    assert.equal(read["src/routes/{slug}"], "deny");
    assert.equal(read["src/routes/{slug}/*"], "deny");
    assert.equal(read["src/routes/[[lang]]/+page.svelte"], "deny");
    assert.equal(read["C:/Develop/site/app/[id]/page.tsx"], "deny");
  }
  // Unsafe shapes are still refused.
  assert.throws(() => permissionEnvironment({}, "analysis", ["a\u0000b"], "C:/Develop/site"));
  assert.throws(() => permissionEnvironment({}, "analysis", ["../outside"], "C:/Develop/site"));
  assert.throws(() => permissionEnvironment({}, "analysis", ["/abs/path"], "C:/Develop/site"));
});

test("S13 C3: a runner call with [id] and {slug} ignored paths launches OpenCode", async () => {
  const calls = [];
  const runner = createOpenCodeRunner({ spawnImpl: recordingSpawn(calls), env: {}, platform: "win32", codeMapBuilder: async () => undefined });
  const result = await runner({ directory, prompt: "Explain the router.", model: "opencode/free", timeoutMs: 30_000, maxWords: 100,
    codeMap: false, ignoredPaths: ["app/[id]/page.tsx", "src/routes/{slug}/"] });
  assert.equal(calls.length, 1, `OpenCode was not launched: ${result.error ?? ""}`);
  assert.notEqual(result.localFailure, true);
});

test("S13 D5: a 30k-character edit prompt is sent on stdin, not on the Windows command line", async () => {
  const calls = [];
  const runner = createOpenCodeRunner({ spawnImpl: recordingSpawn(calls), env: {}, platform: "win32", codeMapBuilder: async () => undefined });
  const prompt = "Repair the failing check. " + "verification output line\n".repeat(1200); // about 30k characters
  assert.ok(prompt.length >= 30_000);
  const result = await runner({ directory, prompt, model: "opencode/free", timeoutMs: 30_000, mode: "edits", codeMap: false,
    ignoredPaths: ["app/[id]/page.tsx"] });
  assert.equal(calls.length, 1, `OpenCode was not launched: ${result.error ?? ""}`);
  assert.notEqual(result.localFailure, true);
  const { args, options, child } = calls[0];
  assert.ok(args.every(arg => !arg.includes("verification output line")), "the prompt must not be on the command line");
  assert.ok(args.join(" ").length < 4_000, `command line is ${args.join(" ").length} characters`);
  assert.equal(options.stdio[0], "pipe");
  assert.ok(child.received.includes(prompt), "OpenCode must receive the whole prompt on stdin");
  assert.equal(child.stdinEnded, true, "stdin must be closed so OpenCode stops reading");
});

test("S13 D5: analysis prompts also go on stdin", async () => {
  const calls = [];
  const runner = createOpenCodeRunner({ spawnImpl: recordingSpawn(calls), env: {}, platform: "win32", codeMapBuilder: async () => undefined });
  await runner({ directory, prompt: "Where is the router defined?", model: "opencode/free", timeoutMs: 30_000, maxWords: 100, codeMap: false });
  const { args, child } = calls[0];
  assert.ok(args.every(arg => !arg.includes("Where is the router defined?")));
  assert.ok(child.received.includes("Where is the router defined?"));
});

test("S13 C6: the OpenCode child runs with GIT_OPTIONAL_LOCKS=0 in analysis and edits", async () => {
  for (const mode of ["analysis", "edits"]) {
    const calls = [];
    const runner = createOpenCodeRunner({ spawnImpl: recordingSpawn(calls), env: { GIT_OPTIONAL_LOCKS: "1" }, platform: "win32",
      codeMapBuilder: async () => undefined });
    await runner({ directory, prompt: "Check.", model: "opencode/free", timeoutMs: 30_000, maxWords: 100, mode, codeMap: false });
    assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, "0", mode);
  }
});

test("S13 C6: shutdownAnalysis stops running OpenCode children and the calls settle", async () => {
  assert.equal(typeof core.shutdownAnalysis, "function", "core.js must export shutdownAnalysis");
  const calls = [], killed = [];
  const runner = createOpenCodeRunner({ spawnImpl: recordingSpawn(calls, { hang: true }), env: {}, platform: "win32",
    codeMapBuilder: async () => undefined, graceMs: 10,
    killProcessTreeImpl: target => { killed.push(target.pid); target.emit("close", null); } });
  const pending = runner({ directory, prompt: "Long analysis.", model: "opencode/free", timeoutMs: 120_000, maxWords: 100, codeMap: false });
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  await core.shutdownAnalysis();
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still running"), 5_000))]);
  assert.notEqual(result, "still running", "the analysis call must settle after shutdown");
  assert.deepEqual(killed, [4321]);
  // Once stopped, a later call is not affected by the earlier shutdown of other calls.
});
