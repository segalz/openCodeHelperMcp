import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runEdits, verificationSchema, registerEditTools } from "../src/edits.js";
import { acquire, checkoutLockPath, canonicalCheckoutPath } from "../src/checkoutlock.js";
import { takeSnapshot, restoreSnapshot, discardSnapshot, headAndIndexIdentity } from "../src/snapshot.js";
import { runVerification, VerificationError } from "../src/verify.js";
import { createOpenCodeRunner } from "../src/core.js";

// Materialize valid loose objects and a v2 index directly: tests never invoke a
// Git write command, and the actual checkout's Git metadata is never changed.
async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "opencode-edits-test-"));
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); await rm(base, { recursive: true, force: true }); });
  const root = path.join(base, "repo"), git = path.join(root, ".git");
  await mkdir(path.join(git, "objects"), { recursive: true }); await mkdir(path.join(git, "refs", "heads"), { recursive: true });
  await writeFile(path.join(git, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n");
  await writeFile(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  const object = async (type, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    const hash = createHash("sha1").update(raw).digest("hex"), dir = path.join(git, "objects", hash.slice(0, 2));
    await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, hash.slice(2)), deflateSync(raw)); return hash;
  };
  const files = { ".gitignore": "ignored.txt\nignored-dir/\n", "data.bin": Buffer.from([0, 255, 1]), "deleted.txt": "deleted baseline", "main.js": "HEAD content\n" };
  const tree = [], entries = [];
  for (const name of Object.keys(files).sort()) {
    const value = Buffer.from(files[name]), blob = await object("blob", value);
    tree.push(Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, "hex")]));
    const staged = name === "main.js" ? Buffer.from("staged owner content\n") : value;
    const hash = name === "main.js" ? await object("blob", staged) : blob;
    const header = Buffer.alloc(62); header.writeUInt32BE(0o100644, 24); header.writeUInt32BE(staged.length, 36); Buffer.from(hash, "hex").copy(header, 40); header.writeUInt16BE(Buffer.byteLength(name), 60);
    const entry = Buffer.concat([header, Buffer.from(name), Buffer.from([0])]);
    entries.push(Buffer.concat([entry, Buffer.alloc((8 - entry.length % 8) % 8)]));
    await writeFile(path.join(root, name), name === "main.js" ? "owner dirty bytes\n" : value);
  }
  const treeHash = await object("tree", Buffer.concat(tree));
  const head = await object("commit", `tree ${treeHash}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nfixture\n`);
  await writeFile(path.join(git, "refs", "heads", "main"), head + "\n");
  const header = Buffer.alloc(12); header.write("DIRC"); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const index = Buffer.concat([header, ...entries]); await writeFile(path.join(git, "index"), Buffer.concat([index, createHash("sha1").update(index).digest()]));
  await rm(path.join(root, "deleted.txt")); await writeFile(path.join(root, "notes.txt"), "owner untracked"); await writeFile(path.join(root, "ignored.txt"), "ignored owner");
  const options = { lockDirectory: path.join(base, "locks"), snapshotOptions: { snapshotBase: path.join(base, "snapshots") } };
  return { base, root, git, options };
}
const verify = { command: process.execPath, args: ["-e", "process.exit(require('fs').readFileSync('main.js','utf8')==='fixed'?0:1)"] };
const input = root => ({ directory: root, prompt: "Fix main.js", model: "opencode/test-free", verify, codeMap: false });
const response = () => ({ text: "Changed main.js", sessionID: "ses_fixture", usage: { inputTokens: 15, steps: 1 } });
const failedCheck = () => ({ passed: false, exitCode: 1, signal: null, timedOut: false, killedForOutput: false, stdoutTail: "expected fixed", stderrTail: "api_key=secret123", durationMs: 1 });
const passedCheck = () => ({ ...failedCheck(), passed: true, exitCode: 0, stderrTail: "" });
const missing = async file => { await assert.rejects(access(file)); };

test("snapshot restores dirty/staged/untracked/binary/deleted bytes without changing index", async t => {
  const f = await repository(t), before = await headAndIndexIdentity(f.root);
  const snapshot = await takeSnapshot(f.root, f.options.snapshotOptions);
  await rm(path.join(f.root, "main.js")); await writeFile(path.join(f.root, "rename.js"), "new");
  await writeFile(path.join(f.root, "data.bin"), "broken"); await writeFile(path.join(f.root, "deleted.txt"), "created"); await rm(path.join(f.root, "notes.txt"));
  const report = await restoreSnapshot(snapshot); assert.deepEqual(report.failed, []);
  assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), "owner dirty bytes\n");
  assert.deepEqual(await readFile(path.join(f.root, "data.bin")), Buffer.from([0, 255, 1]));
  assert.equal(await readFile(path.join(f.root, "notes.txt"), "utf8"), "owner untracked"); await missing(path.join(f.root, "deleted.txt")); await missing(path.join(f.root, "rename.js"));
  assert.deepEqual(await headAndIndexIdentity(f.root), before); await discardSnapshot(snapshot);
});

test("edits pass first check with real verification process", async t => {
  const f = await repository(t);
  const out = await runEdits(input(f.root), { ...f.options, runner: async call => { assert.equal(call.mode, "edits"); assert.equal(call.sessionID, undefined); assert.ok(call.ignoredPaths.includes("ignored.txt")); await writeFile(path.join(f.root, "main.js"), "fixed"); return response(); } });
  assert.equal(out.status, "done"); assert.equal(out.verification.passed, true); assert.equal(out.verification.fixRuns, 0); assert.equal(out.verification.attempts.length, 1); assert.equal(out.verification.restored, false);
  assert.equal(out.sessionID, "ses_fixture"); assert.equal(out.usage.inputTokens, 15); assert.deepEqual(await readdir(path.join(f.base, "snapshots")), []);
});

test("failed check repairs in the exact session and aggregates usage/guard", async t => {
  const f = await repository(t), calls = []; let checks = 0;
  const out = await runEdits(input(f.root), { ...f.options, verifyImpl: async () => ++checks === 1 ? failedCheck() : passedCheck(), runner: async call => {
    calls.push(call); call.guardState.observe({ type: "usage", sessionID: "ses_fixture", id: String(calls.length), usage: { inputTokens: 15 } });
    await writeFile(path.join(f.root, "main.js"), calls.length === 1 ? "partial" : "fixed"); return response();
  } });
  assert.equal(out.status, "done"); assert.equal(calls.length, 2); assert.equal(calls[1].sessionID, "ses_fixture"); assert.equal(calls[1].model, calls[0].model); assert.equal(calls[1].guardState, calls[0].guardState);
  assert.match(calls[1].prompt, /never weaken or bypass/); assert.match(calls[1].prompt, /Exact verification/); assert.ok(!calls[1].prompt.includes("secret123"));
  assert.equal(out.verification.fixRuns, 1); assert.equal(out.usage.inputTokens, 30); assert.equal(out.guard.totalInputTokens, 30);
});

test("exhausted fixes restore once to owner bytes; keepOnFailure keeps explicitly", async t => {
  for (const keepOnFailure of [false, true]) {
    const f = await repository(t); let calls = 0, snapshots = 0;
    const out = await runEdits({ ...input(f.root), keepOnFailure }, { ...f.options,
      takeSnapshotImpl: async (...args) => { snapshots++; return takeSnapshot(...args); }, verifyImpl: async () => failedCheck(),
      runner: async () => { calls++; await writeFile(path.join(f.root, "main.js"), "partial"); await writeFile(path.join(f.root, "new.js"), "new"); return response(); } });
    assert.equal(calls, 3); assert.equal(snapshots, 1); assert.equal(out.verification.fixRuns, 2); assert.equal(out.error, "verify_failed"); assert.equal(out.verification.kept, keepOnFailure); assert.equal(out.verification.restored, !keepOnFailure);
    assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), keepOnFailure ? "partial" : "owner dirty bytes\n"); if (!keepOnFailure) await missing(path.join(f.root, "new.js"));
    const release = acquire(f.root, { lockDirectory: f.options.lockDirectory }); release();
  }
});

test("none is strict and bypasses checks/repairs without implying a pass", async t => {
  const f = await repository(t);
  for (const bad of [{ none: true, reason: "short" }, { none: true, reason: "explicit exemption", command: "x" }, { command: "x", extra: true }, { command: "x\0" }]) assert.equal(verificationSchema.safeParse(bad).success, false);
  const out = await runEdits({ ...input(f.root), verify: { none: true, reason: "Explicit owner exemption" } }, { ...f.options, runner: async () => response(), verifyImpl: () => assert.fail("no check") });
  assert.equal(out.status, "done"); assert.equal(out.verification.required, false); assert.equal(out.verification.passed, null); assert.deepEqual(out.verification.attempts, []);
});

test("guard trips restore without any repair/check", async t => {
  const f = await repository(t); let calls = 0;
  const out = await runEdits(input(f.root), { ...f.options, verifyImpl: () => assert.fail("no check"), runner: async call => {
    calls++; await writeFile(path.join(f.root, "main.js"), "partial");
    for (let i = 0; i < 3; i++) call.guardState.observe({ type: "tool", id: String(i), tool: "edit", input: { filePath: "main.js" }, status: "error", error: "not found" });
    return response();
  } });
  assert.equal(calls, 1); assert.equal(out.guard.kind, "loop_detected"); assert.equal(out.verification.restored, true); assert.equal(out.verification.fixRuns, 0);
});

test("HEAD/index changes refuse restoration, retain snapshot and release writer lock", async t => {
  for (const change of ["HEAD", "index"]) {
    const f = await repository(t);
    const out = await runEdits(input(f.root), { ...f.options, runner: async () => {
      await writeFile(path.join(f.root, "main.js"), "partial");
      if (change === "HEAD") await writeFile(path.join(f.git, "refs", "heads", "main"), "1".repeat(40) + "\n");
      else await writeFile(path.join(f.git, "index"), "changed index");
      return response();
    }, verifyImpl: () => assert.fail("identity failed") });
    assert.equal(out.error, "identity_changed"); assert.equal(out.verification.restored, false); await access(out.evidence.snapshotDirectory);
    assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), "partial"); const release = acquire(f.root, { lockDirectory: f.options.lockDirectory }); release();
  }
});

test("refused verification spends zero fixes; missing continuation refuses a repair", async t => {
  for (const refused of [true, false]) {
    const f = await repository(t); let calls = 0;
    const out = await runEdits(input(f.root), { ...f.options, runner: async () => { calls++; return { ...response(), sessionID: refused ? "ses_fixture" : undefined }; },
      verifyImpl: async () => { if (refused) throw new VerificationError("verification_refused", "No shell"); return failedCheck(); } });
    assert.equal(calls, 1); assert.equal(out.verification.fixRuns, 0); assert.equal(out.verification.restored, true); assert.equal(out.error, refused ? "verify_failed" : "session_unavailable");
  }
});

test("shared Cline-compatible lock refuses a second writer and existing foreign holder", async t => {
  const f = await repository(t), root = canonicalCheckoutPath(f.root);
  const expected = path.join(os.homedir(), ".cline-mcp", "locks", createHash("sha256").update(root).digest("hex") + ".lock");
  assert.equal(checkoutLockPath(f.root), expected);
  const release = acquire(f.root, { lockDirectory: f.options.lockDirectory });
  assert.throws(() => acquire(f.root, { lockDirectory: f.options.lockDirectory }), { kind: "checkout_busy" }); release();
  const file = checkoutLockPath(f.root, f.options.lockDirectory); await writeFile(file, JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token: "foreign-cline-holder" }));
  assert.throws(() => acquire(f.root, { lockDirectory: f.options.lockDirectory }), { kind: "checkout_busy" });
  const out = await runEdits(input(f.root), { ...f.options, runner: () => assert.fail("busy must not run") }); assert.equal(out.error, "checkout_busy"); await rm(file);
});

test("verification resolves literal Node commands, redacts tails and refuses Windows batch", async () => {
  const out = await runVerification({ command: process.execPath, args: ["-e", "process.stdout.write('api_key=secret123'); process.stderr.write('tail');"] }, process.cwd());
  assert.equal(out.passed, true); assert.ok(!out.stdoutTail.includes("secret123")); assert.equal(out.stderrTail, "tail");
  if (process.platform === "win32") await assert.rejects(runVerification({ command: "unsafe.cmd" }, process.cwd()), { kind: "verification_refused" });
  await assert.rejects(runVerification({ command: "opencode-helper-missing-executable" }, process.cwd()), { kind: "verification_launch_failed" });
});

test("runner launches build with explicit edits permissions and --session, never auto/fork", async () => {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    calls.push({ args, options }); const c = new EventEmitter(); c.pid = 42; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdout.setEncoding = c.stderr.setEncoding = () => {};
    setImmediate(() => { c.stdout.emit("data", JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", id: "p", messageID: "m", text: "fixed" } }) + "\n"); c.emit("close", 0); }); return c;
  };
  const runner = createOpenCodeRunner({ env: {}, spawnImpl });
  const out = await runner({ directory: "C:\\fake", prompt: "repair", model: "m/a", mode: "edits", sessionID: "ses_fixture", codeMap: false, ignoredPaths: ["cache/", "ignored.txt"] });
  assert.equal(out.text, "fixed"); const { args, options } = calls[0]; assert.equal(args[args.indexOf("--agent") + 1], "build"); assert.equal(args[args.indexOf("--session") + 1], "ses_fixture");
  for (const flag of ["--auto", "--continue", "--fork"]) assert.equal(args.includes(flag), false);
  const permissions = JSON.parse(options.env.OPENCODE_PERMISSION); assert.equal(permissions.edit["*"], "allow"); assert.equal(permissions.edit["ignored.txt"], "deny");
  for (const key of ["bash", "task", "webfetch", "websearch"]) assert.equal(permissions[key], "deny"); assert.doesNotMatch(args.at(-1), /edits.*unavailable in analysis/);
});

test("MCP edits return structured verification and validate explicit model without fallback", async t => {
  const f = await repository(t), tools = new Map();
  let codeMapSource = "codeindex";
  registerEditTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, {
    runner: async () => ({ ...response(), codeMapSource }), catalog: { list: async () => ({ models: [{ id: "opencode/test-free" }] }) },
    resolveAllowedPath: async dir => dir === f.root ? f.root : null, lifecycleOptions: { ...f.options, verifyImpl: async () => passedCheck() },
  });
  for (const source of ["codeindex", "regex", "none"]) {
    codeMapSource = source;
    const out = await tools.get("apply_opencode_edits").handler(input(f.root)); const payload = JSON.parse(out.content[0].text);
    assert.equal(out.isError, undefined); assert.equal(payload.verification.passed, true); assert.equal(payload.codeMapSource, source);
  }
  const refused = await tools.get("apply_opencode_edits").handler({ ...input(f.root), model: "m/not-listed" }); assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).codeMapSource, "none");
});

test("structural map rebuilds at the resolved checkout root for initial edits and repairs", async t => {
  const f = await repository(t), cli = path.join(f.base, "map cli.mjs"), launches = [], prompts = [];
  await mkdir(path.join(f.root, "subdir"));
  await writeFile(cli, `import { readFileSync } from 'node:fs'; import path from 'node:path';
    let query=''; for await (const chunk of process.stdin) query+=chunk;
    const root=process.argv[process.argv.indexOf('--root')+1];
    console.log(JSON.stringify({schemaVersion:2,command:'map',referencesAreCandidates:true,truncated:false,anchors:[],
      map:'STRUCTURAL '+root+' CONTENT '+readFileSync(path.join(root,'main.js'),'utf8')}));`);
  let checks = 0;
  const runner = createOpenCodeRunner({ env: { ...process.env, CODEINDEX_CLI: cli }, spawnImpl: (exe, args, options) => {
    if (exe === process.execPath) launches.push({ args, options });
    if (args[0] !== "run") return spawn(exe, args, options);
    prompts.push(args.at(-1));
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    setImmediate(async () => {
      await writeFile(path.join(f.root, "main.js"), "partial");
      child.stdout.emit("data", JSON.stringify({ type: "text", sessionID: "ses_fixture", text: "changed" }) + "\n"); child.emit("close", 0);
    }); return child;
  } });
  const out = await runEdits({ ...input(path.join(f.root, "subdir")), codeMap: true }, { ...f.options, runner,
    verifyImpl: async () => ++checks === 1 ? failedCheck() : passedCheck() });
  assert.equal(out.status, "done"); assert.equal(out.codeMapSource, "codeindex"); assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.args[launch.args.indexOf("--root") + 1], f.root);
    assert.equal(launch.options.cwd, f.root);
  }
  assert.match(prompts[0], /CONTENT owner dirty bytes/); assert.match(prompts[1], /CONTENT partial/);
});

test("deadline/cancellation restore before returning; neither spends fixes", async t => {
  for (const cancel of [true, false]) {
    const f = await repository(t), controller = new AbortController(); let now = 0;
    const out = await runEdits(input(f.root), { ...f.options, nowImpl: () => now, signal: controller.signal,
      runner: async () => { await writeFile(path.join(f.root, "main.js"), "partial"); if (cancel) controller.abort(); else now = 300001; return response(); },
      verifyImpl: () => assert.fail("no check after interruption") });
    assert.equal(out.error, cancel ? "cancelled" : "budget_exceeded"); assert.equal(out.verification.restored, true); assert.equal(out.verification.fixRuns, 0);
    assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), "owner dirty bytes\n");
  }
});

test("partial restoration retains snapshot/evidence and releases lock", async t => {
  const f = await repository(t);
  const out = await runEdits({ ...input(f.root), maxFixRuns: 0 }, { ...f.options, runner: async () => response(), verifyImpl: async () => failedCheck(),
    restoreSnapshotImpl: async () => ({ restored: [], removed: [], failed: [{ path: "main.js", error: "locked" }] }) });
  assert.equal(out.verification.restored, false); assert.match(out.evidence.recoveryError, /incomplete/); await access(out.evidence.snapshotDirectory);
  const release = acquire(f.root, { lockDirectory: f.options.lockDirectory }); release();
});

test("same-session repair rejects a changed session and restores", async t => {
  const f = await repository(t); let calls = 0;
  const out = await runEdits(input(f.root), { ...f.options, runner: async () => ({ ...response(), sessionID: ++calls === 1 ? "ses_fixture" : "ses_wrong" }), verifyImpl: async () => failedCheck() });
  assert.equal(out.error, "session_mismatch"); assert.equal(calls, 2); assert.equal(out.verification.restored, true); assert.equal(out.sessionID, "ses_fixture");
});

test("MCP preparation cancellation never launches edits", async () => {
  const tools = new Map(), controller = new AbortController();
  registerEditTools({ registerTool: (name, _config, handler) => tools.set(name, handler) }, { runner: () => assert.fail("no model"),
    resolveAllowedPath: async dir => dir, catalog: { list: () => { setImmediate(() => controller.abort()); return new Promise(() => {}); } } });
  const out = await tools.get("apply_opencode_edits")(input(path.resolve(".")), { signal: controller.signal });
  assert.equal(out.isError, true); assert.match(JSON.parse(out.content[0].text).message, /cancelled/);
});

test("verification injected timeout/output limits kill the child and cannot pass", async () => {
  for (const overflow of [false, true]) {
    const c = new EventEmitter(), timers = [], kills = []; c.pid = 123; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdout.destroy = c.stderr.destroy = () => {}; c.kill = () => {};
    const pending = runVerification({ command: "node", timeoutSeconds: 1 }, process.cwd(), undefined, {
      resolveImpl: async () => ({ command: "node", args: [] }), spawnImpl: (_exe, _args, options) => { assert.equal(options.shell, false); return c; },
      killImpl: pid => { kills.push(pid); c.emit("close", 0, null); }, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl: () => {} });
    await new Promise(resolve => setImmediate(resolve));
    if (overflow) c.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 65)); else timers[0].fn();
    const out = await pending; assert.equal(out.passed, false); assert.deepEqual(kills, [123]); assert.equal(out.killedForOutput, overflow); assert.equal(out.timedOut, !overflow); assert.ok(Buffer.byteLength(out.stdoutTail) <= 8192);
  }
});

test("guard budget is cumulative across repairs and exhausted budgets prevent a launch", async t => {
  for (const tokens of [6000, 10000]) {
    const f = await repository(t); let calls = 0, checks = 0;
    const out = await runEdits({ ...input(f.root), guard: { maxInputTokens: 10000 } }, { ...f.options,
      runner: async call => {
        calls++; call.guardState.observe({ type: "usage", id: String(calls), sessionID: "ses_fixture", usage: { inputTokens: tokens } });
        return { ...response(), usage: { inputTokens: tokens, steps: 1 } };
      }, verifyImpl: async () => { checks++; return failedCheck(); } });
    assert.equal(calls, tokens === 6000 ? 2 : 1); assert.equal(checks, 1); assert.equal(out.guard.kind, "budget_exceeded");
    assert.equal(out.guard.totalInputTokens, tokens * calls); assert.equal(out.usage.inputTokens, tokens * calls);
    assert.equal(out.verification.fixRuns, calls - 1); assert.equal(out.verification.restored, true);
  }
});

test("runner cancellation kills its child and preserves cancellation on a repair", async () => {
  const controller = new AbortController(), kills = []; let c;
  const runner = createOpenCodeRunner({ env: {}, spawnImpl: () => {
    c = new EventEmitter(); c.pid = 456; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdout.setEncoding = c.stderr.setEncoding = () => {}; return c;
  }, killProcessTreeImpl: child => { kills.push(child.pid); child.emit("close", null); } });
  const pending = runner({ directory: "C:\\fake", prompt: "repair", model: "m/a", mode: "edits", sessionID: "ses_fixture", codeMap: false, signal: controller.signal });
  controller.abort(); const out = await pending;
  assert.deepEqual(kills, [456]); assert.match(out.error, /cancelled/);
});
