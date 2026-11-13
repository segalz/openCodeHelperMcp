import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildCodeMap } from "../src/codemap.js";
import { createOpenCodeRunner, runAnalysis, formatAnalysisResult, registerAnalysisTools } from "../src/core.js";
import { defaultKillTree, windowsCommandLineLength } from "../src/process-utils.js";

const envelope = map => ({ schemaVersion: 2, command: "map", referencesAreCandidates: true, truncated: false, anchors: [], map });
const successScript = `console.log(JSON.stringify(${JSON.stringify(envelope("structural"))}))`;

function fakeChild(output = "", code = 0) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 12345; child.unref = () => {};
  setImmediate(() => { child.stdout.end(output); child.emit("close", code); });
  return child;
}

async function fixture(t, script = successScript) {
  const base = await mkdtemp(path.resolve(".codeindex-test-")), root = path.join(base, "repo"), cli = path.join(base, "fake cli.mjs");
  t.after(async () => {
    assert.equal(path.dirname(base), process.cwd());
    await rm(base, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(root, "main.js"), "export function regexFallback() {}\n");
  await writeFile(cli, script);
  const calls = [], sources = [];
  const options = {
    env: { ...process.env, CODEINDEX_CLI: cli }, onSource: source => sources.push(source),
    spawnImpl: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      if (args.includes("ls-files")) return fakeChild("main.js\0");
      return spawn(exe, args, opts);
    },
  };
  return { base, root, cli, calls, sources, options };
}

test("structural adapter uses Node, exact root, stdin, shell:false and schema v2", async t => {
  const f = await fixture(t);
  const prompt = 'Trace entry() with "quotes" and \\ paths\nsecond line';
  // Capture stdin and argv in a schema-valid map without interpolating JSON.
  await writeFile(f.cli, `let query=''; for await (const c of process.stdin) query+=c;
    console.log(JSON.stringify({ ...${JSON.stringify(envelope(""))}, map: JSON.stringify({query,args:process.argv.slice(2)}) }));`);
  const map = await buildCodeMap(f.root, { ...f.options, prompt });
  const recorded = JSON.parse(map), call = f.calls.find(c => c.exe === process.execPath);
  assert.equal(recorded.query, prompt);
  assert.deepEqual(recorded.args.slice(0, 4), ["map", "--root", f.root, "--json"]);
  assert.equal(call.args[0], f.cli); assert.equal(call.opts.shell, false); assert.equal(call.opts.cwd, f.root);
  assert.equal(call.args.includes(prompt), false); assert.equal(call.args[call.args.indexOf("--budget") + 1], "6000");
  const ms = Number(call.args[call.args.indexOf("--deadline-ms") + 1]); assert.ok(ms > 1500 && ms <= 10000);
  assert.deepEqual(f.sources, ["codeindex"]); assert.equal(f.calls.some(c => c.args.includes("ls-files")), false);
});

test("every optional CLI failure silently retains the regex map", async t => {
  const invalid = [
    ["nonzero exit", "process.exit(1)"],
    ["CLI deadline exit", "process.exit(3)"],
    ["CLI cancellation exit without caller abort", "process.exit(4)"],
    ["invalid JSON", "console.log('broken')"],
    ["invalid UTF-8", `process.stdout.write(Buffer.concat([Buffer.from(JSON.stringify(${JSON.stringify(envelope("invalid"))}).replace('invalid','PLACEHOLDER').split('PLACEHOLDER')[0]),Buffer.from([255]),Buffer.from('"}\\n')]));`],
    ["wrong version", `console.log(JSON.stringify(${JSON.stringify({ ...envelope("bad"), schemaVersion: 1 })}))`],
    ["wrong command", `console.log(JSON.stringify(${JSON.stringify({ ...envelope("bad"), command: "outline" })}))`],
    ["non-string map", `console.log(JSON.stringify(${JSON.stringify(envelope(42))}))`],
    ["missing envelope", "console.log(JSON.stringify({schemaVersion:2,command:'map',map:'bad'}))"],
    ["invalid anchors", `console.log(JSON.stringify(${JSON.stringify({ ...envelope("bad"), anchors: [{ text: "x", kind: "identifier", matched: [] }] })}))`],
    ["extra properties", `console.log(JSON.stringify(${JSON.stringify({ ...envelope("bad"), extra: true })}))`],
    ["oversize stdout", "process.stdout.write('x'.repeat(65537))"],
    ["over contract budget", `console.log(JSON.stringify(${JSON.stringify(envelope("x".repeat(6000)))}))`],
  ];
  for (const [name, script] of invalid) await t.test(name, async t => {
    const f = await fixture(t, script);
    assert.match(await buildCodeMap(f.root, f.options), /regexFallback:1/);
    assert.deepEqual(f.sources, ["regex"]);
  });
});

test("unset, relative, absent and directory CLI paths retain existing behavior", async t => {
  for (const kind of ["unset", "relative", "absent", "directory"]) await t.test(kind, async t => {
    const f = await fixture(t), env = { ...process.env };
    delete env.CODEINDEX_CLI;
    if (kind !== "unset") env.CODEINDEX_CLI = kind === "relative" ? "fake.mjs" : kind === "absent" ? path.join(f.base, "missing.mjs") : f.base;
    assert.match(await buildCodeMap(f.root, { ...f.options, env }), /regexFallback:1/);
    assert.equal(f.calls.some(c => c.exe === process.execPath), false);
    assert.deepEqual(f.sources, ["regex"]);
  });
});

test("non-Git directories and checkout subdirectories never launch structural CLI", async t => {
  const f = await fixture(t);
  for (const root of [f.base, path.join(f.root, "nested")]) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "main.js"), "export function regexFallback() {}\n");
    assert.match(await buildCodeMap(root, f.options), /regexFallback:1/);
  }
  assert.equal(f.calls.some(c => c.exe === process.execPath), false);
});

test("launch exceptions and emitted launch errors fall back", async t => {
  for (const throws of [true, false]) {
    const f = await fixture(t), original = f.options.spawnImpl;
    const map = await buildCodeMap(f.root, { ...f.options, spawnImpl: (exe, args, opts) => {
      if (exe !== process.execPath) return original(exe, args, opts);
      if (throws) throw new Error("cannot launch");
      const child = fakeChild(); process.nextTick(() => child.emit("error", new Error("ENOENT"))); return child;
    }, killTreeImpl: () => {} });
    assert.match(map, /regexFallback:1/);
  }
});

test("stdout cap is in bytes and overflow kills the child tree before fallback", async t => {
  const f = await fixture(t), original = f.options.spawnImpl, kills = [];
  const map = await buildCodeMap(f.root, { ...f.options,
    spawnImpl: (exe, args, opts) => {
      if (exe !== process.execPath) return original(exe, args, opts);
      const child = fakeChild();
      process.nextTick(() => child.stdout.emit("data", Buffer.from("\u20ac".repeat(22000))));
      return child;
    }, killTreeImpl: pid => kills.push(pid) });
  assert.match(map, /regexFallback:1/); assert.deepEqual(kills, [12345]); assert.deepEqual(f.sources, ["regex"]);
});

test("adapter deadline kills its process tree and uses remaining time for regex", async t => {
  const f = await fixture(t, "setInterval(() => {}, 1000)"), killed = [];
  const started = performance.now();
  const map = await buildCodeMap(f.root, { ...f.options, timeBudgetMs: 12000,
    killTreeImpl: pid => { killed.push(pid); defaultKillTree(pid); } });
  assert.match(map, /regexFallback:1/);
  assert.equal(killed.length, 1); assert.ok(performance.now() - started < 12000);
  const call = f.calls.find(c => c.exe === process.execPath);
  assert.ok(Number(call.args.at(-1)) <= 10000);
});

test("remaining attempt time bounds the adapter and prevents late fallback", async t => {
  const f = await fixture(t, "setInterval(() => {}, 1000)"), original = f.options.spawnImpl, killed = [];
  const map = await buildCodeMap(f.root, { ...f.options, timeBudgetMs: 80,
    spawnImpl: (exe, args, opts) => {
      if (args.includes("rev-parse")) return fakeChild(f.root + "\n");
      return original(exe, args, opts);
    }, killTreeImpl: pid => { killed.push(pid); defaultKillTree(pid); } });
  assert.equal(map, undefined); assert.deepEqual(f.sources, ["none"]);
  assert.equal(f.calls.some(c => c.args.includes("ls-files")), false); assert.equal(killed.length, 1);
  const call = f.calls.find(c => c.exe === process.execPath); assert.ok(Number(call.args.at(-1)) <= 80);
});

test("caller cancellation propagates without regex fallback and kills the tree", async t => {
  const f = await fixture(t), controller = new AbortController(), kills = [], original = f.options.spawnImpl;
  await assert.rejects(buildCodeMap(f.root, { ...f.options, signal: controller.signal,
    spawnImpl: (exe, args, opts) => {
      if (exe !== process.execPath) return original(exe, args, opts);
      const child = new EventEmitter(); child.pid = 9876; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => controller.abort()); return child;
    }, killTreeImpl: pid => kills.push(pid) }), { name: "AbortError" });
  assert.deepEqual(kills, [9876]); assert.deepEqual(f.sources, []);
  assert.equal(f.calls.some(c => c.args.includes("ls-files")), false);
  await assert.rejects(buildCodeMap(f.root, { ...f.options, signal: controller.signal }), { name: "AbortError" });
});

test("escaped command headroom clamps the requested budget or omits maps below 800", async t => {
  const f = await fixture(t, `console.log(JSON.stringify(${JSON.stringify(envelope('"\\'.repeat(90)))}))`);
  const commandLineLength = map => 30000 + windowsCommandLineLength("node", [map]);
  const map = await buildCodeMap(f.root, { ...f.options, maxChars: 12000, commandLineLength });
  const call = f.calls.find(c => c.exe === process.execPath), budget = Number(call.args[call.args.indexOf("--budget") + 1]);
  assert.ok(budget < 1000); assert.ok(map.length <= 6000); assert.ok(commandLineLength(map + "\n\n") <= 31000);
  const before = f.calls.length;
  assert.equal(await buildCodeMap(f.root, { ...f.options, commandLineLength: () => 30201 }), undefined);
  assert.equal(await buildCodeMap(f.root, { ...f.options, maxChars: 0 }), undefined);
  assert.equal(f.calls.length, before); assert.equal(f.sources.at(-1), "none");
});

test("empty structural map is omitted without invoking regex", async t => {
  const f = await fixture(t, `console.log(JSON.stringify(${JSON.stringify(envelope(""))}))`);
  assert.equal(await buildCodeMap(f.root, f.options), undefined);
  assert.deepEqual(f.sources, ["none"]); assert.equal(f.calls.some(c => c.args.includes("ls-files")), false);
});

test("runner and analyze header report codeindex, regex and none", async t => {
  const f = await fixture(t, `console.log(JSON.stringify(${JSON.stringify(envelope("structural map"))}))`);
  const spawnImpl = (exe, args, opts) => args[0] === "run"
    ? fakeChild('{"type":"text","text":"answer"}\n') : f.options.spawnImpl(exe, args, opts);
  for (const [source, env, codeMap] of [["codeindex", f.options.env, true], ["regex", { ...process.env, CODEINDEX_CLI: "" }, true], ["none", f.options.env, false]]) {
    const runner = createOpenCodeRunner({ env, spawnImpl });
    const result = await runAnalysis({ directory: f.root, prompt: "query", codeMap, models: [{ id: "m/free" }], runner });
    assert.equal(result.codeMapSource, source); assert.match(formatAnalysisResult(result), new RegExp(`code map: ${source}`));
  }
});

test("runner counts map preparation against the attempt and never launches after cancellation", async () => {
  let now = 0, calls = 0;
  const runner = createOpenCodeRunner({ env: {}, nowImpl: () => now,
    spawnImpl: () => { calls++; return fakeChild('{"type":"text","text":"answer"}\n'); },
    codeMapBuilder: async (_root, options) => { assert.equal(options.timeBudgetMs, 50); now += 51; return "map"; } });
  const out = await runner({ directory: process.cwd(), prompt: "q", model: "m/free", timeoutMs: 50 });
  assert.equal(out.status, "timeout"); assert.equal(out.codeMapSource, "none"); assert.equal(calls, 0);
  const controller = new AbortController();
  const cancelled = createOpenCodeRunner({ env: {}, spawnImpl: () => assert.fail("cancelled launch"),
    codeMapBuilder: async () => { controller.abort(); throw controller.signal.reason; } });
  const result = await cancelled({ directory: process.cwd(), prompt: "q", model: "m/free", signal: controller.signal });
  assert.equal(result.localFailure, true); assert.match(result.error, /cancelled/);
});

test("source becomes none when a returned map cannot fit at launch", async () => {
  const runner = createOpenCodeRunner({ env: {},
    codeMapBuilder: async (_root, options) => { options.onSource("codeindex"); return "x".repeat(6001); },
    spawnImpl: () => fakeChild('{"type":"text","text":"answer"}\n') });
  const result = await runner({ directory: process.cwd(), prompt: "q", model: "m/free" });
  assert.equal(result.codeMapSource, "none"); assert.equal(result.text, "answer");
});

test("MCP analysis forwards caller cancellation and stops without another model", async () => {
  const controller = new AbortController(), tools = new Map(); let calls = 0;
  registerAnalysisTools({ registerTool: (name, _config, handler) => tools.set(name, handler) }, {
    resolveAllowedPath: async value => value,
    catalog: { list: async () => ({ models: [{ id: "m/first-free" }, { id: "m/second-free" }] }) },
    runner: async call => { calls++; assert.equal(call.signal, controller.signal); controller.abort(); throw controller.signal.reason; },
  });
  const out = await tools.get("analyze_code")({ directory: process.cwd(), prompt: "q", models: ["m/first-free", "m/second-free"] }, { signal: controller.signal });
  assert.equal(calls, 1); assert.equal(out.isError, true); assert.match(out.content[0].text, /cancelled/);
});
