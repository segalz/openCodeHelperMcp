import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createOpenCodeRunner, runAnalysis } from "../src/core.js";
import { runEdits } from "../src/edits.js";
import { confirmTreeDead } from "../src/proctree.js";
import { createServerPool } from "../src/server-pool.js";
import { runVerification } from "../src/verify.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeClock() {
  const timers = new Set();
  let now = 0;
  return {
    now: () => now,
    set(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clear: timer => timers.delete(timer),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers.delete(next);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr);
}

async function realRepo(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-s18x-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "r");
  await mkdir(root);
  git(root, "init", "-q");
  await writeFile(path.join(root, "main.js"), "broken\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const options = { lockDirectory: path.join(base, "locks"), snapshotOptions: { snapshotBase: path.join(base, "snapshots") } };
  return { base, root, options };
}

async function mockLifecycle(t, extra = {}) {
  const lockDirectory = await mkdtemp(path.join(os.tmpdir(), "oc-s18x-lock-"));
  t.after(() => rm(lockDirectory, { recursive: true, force: true, maxRetries: 5 }));
  const root = process.cwd();
  return {
    lockDirectory,
    resolveRoot: async () => root,
    ignoredPathsImpl: async () => [],
    identityImpl: async () => ({ head: "same", indexHash: "same" }),
    takeSnapshotImpl: async () => ({ directory: "fixture" }),
    restoreSnapshotImpl: async () => ({ restored: [], removed: [], failed: [] }),
    discardSnapshotImpl: async () => {},
    ...extra,
  };
}

const editInput = (directory, extra = {}) => ({
  directory,
  prompt: "Fix main.js",
  model: "opencode/test-free",
  codeMap: false,
  verify: { command: process.execPath, args: ["-e", "0"] },
  ...extra,
});

const editResponse = (extra = {}) => ({
  text: "Changed main.js",
  sessionID: "ses_s18x",
  usage: { inputTokens: 10, steps: 1 },
  ...extra,
});

function serveFixture({ onRun, onTerminate, codeMapBuilder, listen = true } = {}) {
  const clock = fakeClock();
  const servers = [], runs = [];
  let nextPort = 25000;
  function spawnMock(executable, args, options) {
    const child = Object.assign(new EventEmitter(), {
      executable, args, options, stdout: new PassThrough(), stderr: new PassThrough(), input: "", closed: false,
    });
    child.stdin = new Writable({ write(bytes, _enc, done) { child.input += bytes.toString(); done(); } });
    child.finish = (code = 0) => {
      if (child.closed) return;
      child.closed = true;
      child.emit("exit", code);
      child.emit("close", code);
    };
    if (args[0] === "serve") {
      servers.push(child);
      const port = Number(args[args.indexOf("--port") + 1]);
      child.url = `http://127.0.0.1:${port}`;
      if (listen) queueMicrotask(() => child.stdout.write(`opencode server listening on ${child.url}\n`));
    } else {
      assert.equal(args[0], "run");
      runs.push(child);
      child.url = args.includes("--attach") ? args[args.indexOf("--attach") + 1] : undefined;
      queueMicrotask(() => {
        if (onRun && onRun(child, servers) === false) return;
        child.stdout.write('{"type":"text","sessionID":"ses_s18x","text":"answer"}\n');
        child.finish(0);
      });
    }
    return child;
  }
  const pool = createServerPool({ getFreePort: async () => ++nextPort, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear });
  const runner = createOpenCodeRunner({
    spawnImpl: spawnMock,
    serverPool: pool,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    nowImpl: clock.now,
    killProcessTreeImpl: child => {
      if (onTerminate) onTerminate(child, servers);
      else child.finish(null);
    },
    graceMs: 1,
    ...(codeMapBuilder ? { codeMapBuilder } : {}),
  });
  return { clock, servers, runs, pool, runner };
}

// ---- Item 2: unconfirmed kills on edit run or check ----

test("S18 (2): unconfirmed edit run kill (with text) skips verify/repairs and auto-restore, retains snapshot and reports PIDs", async t => {
  const f = await realRepo(t);
  let runs = 0;
  const out = await runEdits(editInput(f.root, { maxFixRuns: 2 }), {
    ...f.options,
    verifyImpl: () => assert.fail("verify must not run when edit process is not confirmed dead"),
    runner: async () => {
      runs++;
      await writeFile(path.join(f.root, "main.js"), "partial\n");
      return editResponse({ killConfirmed: false, stillAlive: [7001] });
    },
  });
  assert.equal(runs, 1);
  assert.equal(out.status, "failed");
  assert.equal(out.error, "process_still_running");
  assert.equal(out.verification.restored, false);
  assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), "partial\n");
  assert.deepEqual(out.evidence.processesStillAlive, [7001]);
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory));
  assert.ok(out.warnings?.some(w => /may still be running/i.test(w)));
});

test("S18 (2): unconfirmed edit run kill with keepOnFailure keeps edit and retains recovery snapshot", async t => {
  const f = await realRepo(t);
  const out = await runEdits(editInput(f.root, { keepOnFailure: true, maxFixRuns: 2 }), {
    ...f.options,
    verifyImpl: () => assert.fail("no verify"),
    runner: async () => {
      await writeFile(path.join(f.root, "main.js"), "partial\n");
      return { status: "failed", error: "OpenCode timed out", killConfirmed: false, stillAlive: [7002] };
    },
  });
  assert.equal(out.verification.kept, true);
  assert.equal(out.verification.restored, false);
  assert.equal(await readFile(path.join(f.root, "main.js"), "utf8"), "partial\n");
  assert.deepEqual(out.evidence.processesStillAlive, [7002]);
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory));
  assert.ok(out.warnings?.some(w => /may still be running/i.test(w)));
});

test("S18 (2): unconfirmed check kill cannot pass even if verifyImpl returned passed=true", async t => {
  const f = await realRepo(t);
  let runs = 0;
  const out = await runEdits(editInput(f.root, { maxFixRuns: 2 }), {
    ...f.options,
    runner: async () => {
      runs++;
      await writeFile(path.join(f.root, "main.js"), "edit\n");
      return editResponse();
    },
    verifyImpl: async () => ({
      passed: true, exitCode: 0, signal: null, timedOut: false, killedForOutput: false,
      durationMs: 1, stdoutTail: "", stderrTail: "", killConfirmed: false, stillAlive: [7003],
    }),
  });
  assert.equal(runs, 1);
  assert.equal(out.verification.passed, false);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(out.evidence.processesStillAlive, [7003]);
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory));
});

// ---- Item 3: passing edit commit point & editScope.close() ----

test("S18 (3): passing edit is not rolled back when editScope.close() reports unconfirmed server stop", async t => {
  const calls = [];
  const lifecycle = await mockLifecycle(t, {
    restoreSnapshotImpl: async () => { calls.push("restore"); return { restored: [], removed: [], failed: [] }; },
    discardSnapshotImpl: async () => { calls.push("discard"); },
  });
  const out = await runEdits(editInput(process.cwd()), {
    ...lifecycle,
    runner: async ({ editScope }) => {
      editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [5555], killUnverified: true }) };
      return editResponse();
    },
    verifyImpl: async () => ({ passed: true, exitCode: 0 }),
  });
  assert.equal(out.status, "done");
  assert.equal(out.error, undefined);
  assert.equal(out.verification.passed, true);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(out.evidence.processesStillAlive, [5555]);
  assert.equal(out.evidence.snapshotDirectory, "fixture");
  assert.ok(out.warnings?.some(w => /may still be running/i.test(w)));
  assert.deepEqual(calls, []);
});

test("S18 (3): verify:none commit point treats unconfirmed server stop as warning, not failure", async t => {
  const calls = [];
  const lifecycle = await mockLifecycle(t, {
    restoreSnapshotImpl: async () => { calls.push("restore"); return { restored: [], removed: [], failed: [] }; },
    discardSnapshotImpl: async () => { calls.push("discard"); },
  });
  const out = await runEdits(editInput(process.cwd(), { verify: { none: true, reason: "Doc-only edit exemption" } }), {
    ...lifecycle,
    runner: async ({ editScope }) => {
      editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [6666] }) };
      return editResponse();
    },
  });
  assert.equal(out.status, "done");
  assert.equal(out.error, undefined);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(out.evidence.processesStillAlive, [6666]);
  assert.ok(out.warnings?.some(w => /may still be running/i.test(w)));
  assert.deepEqual(calls, []);
});

test("S18 (3): caller cancel during editScope.close() after passing check does not restore", async t => {
  const controller = new AbortController();
  const calls = [];
  const lifecycle = await mockLifecycle(t, {
    restoreSnapshotImpl: async () => { calls.push("restore"); return { restored: [], removed: [], failed: [] }; },
    discardSnapshotImpl: async () => { calls.push("discard"); },
  });
  const out = await runEdits(editInput(process.cwd()), {
    ...lifecycle,
    signal: controller.signal,
    runner: async ({ editScope }) => {
      editScope.server = {
        stop: async () => {
          controller.abort();
          await sleep(10);
          return { killConfirmed: true };
        },
      };
      return editResponse();
    },
    verifyImpl: async () => ({ passed: true, exitCode: 0 }),
  });
  assert.equal(out.status, "done");
  assert.equal(out.error, undefined);
  assert.equal(out.verification.passed, true);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(calls, ["discard"]);
  assert.equal(out.evidence.snapshotDirectory, undefined);
});

test("S18 (3): keepOnFailure with identity change followed by unconfirmed server stop still sets verification.kept", async t => {
  let head = "before";
  const calls = [];
  const lifecycle = await mockLifecycle(t, {
    identityImpl: async () => ({ head, indexHash: "same" }),
    restoreSnapshotImpl: async () => { calls.push("restore"); return { restored: [], removed: [], failed: [] }; },
    discardSnapshotImpl: async () => { calls.push("discard"); },
  });
  const out = await runEdits(editInput(process.cwd(), { keepOnFailure: true }), {
    ...lifecycle,
    runner: async ({ editScope }) => {
      head = "after";
      editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [7777] }) };
      return editResponse();
    },
    verifyImpl: async () => ({ passed: true, exitCode: 0 }),
  });
  assert.equal(out.error, "identity_changed");
  assert.equal(out.verification.kept, true);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(out.evidence.processesStillAlive, [7777]);
  assert.equal(out.evidence.snapshotDirectory, "fixture");
  assert.deepEqual(calls, []);
});

test("S18 (3): pool-backed passing edit stays done when stopping the edit server is unconfirmed", async t => {
  const clock = fakeClock();
  let nextPort = 26000;
  const basePool = createServerPool({ getFreePort: async () => ++nextPort, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear });
  const wrappedPool = {
    acquire(config, opts) {
      return basePool.acquire(config, {
        ...opts,
        runProcess: async pOpts => {
          pOpts.onStdout?.(`opencode server listening on http://127.0.0.1:${nextPort}\n`);
          await new Promise(resolve => pOpts.signal.addEventListener("abort", resolve, { once: true }));
          return { killConfirmed: false, stillAlive: [8888] };
        },
      });
    },
  };
  const runner = createOpenCodeRunner({
    serverPool: wrappedPool,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    nowImpl: clock.now,
    graceMs: 1,
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(_c, _e, d) { d(); } }),
      });
      queueMicrotask(() => {
        child.stdout.write('{"type":"text","sessionID":"ses_s18x","text":"Changed main.js"}\n');
        child.emit("close", 0);
      });
      return child;
    },
  });
  const lifecycle = await mockLifecycle(t);
  const out = await runEdits(editInput(process.cwd()), {
    ...lifecycle,
    runner,
    verifyImpl: async () => ({ passed: true, exitCode: 0 }),
  });
  assert.equal(out.status, "done");
  assert.equal(out.error, undefined);
  assert.equal(out.verification.passed, true);
  assert.equal(out.verification.restored, false);
  assert.deepEqual(out.evidence.processesStillAlive, [8888]);
  assert.ok(out.warnings?.some(w => /may still be running/i.test(w)));
});

// ---- Item 4: A4 isNoQuestionRest edge cases ----

test("S18 (4): A4 distinguishes real questions starting with No or containing ? from non-questions", async t => {
  const lifecycle = await mockLifecycle(t);
  // A question mark marks a real question (Opus review: "No, all done." style statements are final answers).
  for (const text of ["Done.\nQuestion: No tests exist. Should I add one?", "Done.\nQuestion: none?", "Done.\nQuestion: No fallback?"]) {
    const out = await runEdits(editInput(process.cwd()), {
      ...lifecycle,
      verifyImpl: () => assert.fail(`must ask input for ${text}`),
      runner: async () => editResponse({ text }),
    });
    assert.equal(out.error, "input_required", text);
  }
  for (const text of [
    "Done.\nQuestion: No.",
    "Done.\nQuestion: none",
    "Done.\nQuestion: No open questions",
    "Done.\nQuestion: N/A (all clear)",
  ]) {
    const out = await runEdits(editInput(process.cwd()), {
      ...lifecycle,
      verifyImpl: async () => ({ passed: true, exitCode: 0 }),
      runner: async () => editResponse({ text }),
    });
    assert.equal(out.error, undefined, text);
    assert.equal(out.status, "done", text);
  }
});

// ---- Item 5: runVerification fallback without a Windows job ----

test("S18 (5): without an assigned job, close before exitGrace runs confirmTreeDead", async () => {
  function spawnFakeChild() {
    const child = Object.create(ChildProcess.prototype);
    EventEmitter.call(child);
    child.pid = 31337;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  }

  const seen = [];
  const noJob = await runVerification({ command: "node", timeoutSeconds: 10 }, process.cwd(), undefined, {
    resolveImpl: async () => ({ command: "node", args: [] }),
    spawnImpl: spawnFakeChild,
    killImpl: () => {},
    createWindowsJob: async () => undefined,
    confirmTreeDead: async pid => { seen.push(pid); return { confirmed: false, alive: [31338] }; },
  });
  assert.deepEqual(seen, [31337]);
  assert.equal(noJob.passed, false);
  assert.equal(noJob.killConfirmed, false);
  assert.deepEqual(noJob.stillAlive, [31338]);

  const unassignedCalls = [];
  const unassigned = await runVerification({ command: "node", timeoutSeconds: 10 }, process.cwd(), undefined, {
    resolveImpl: async () => ({ command: "node", args: [] }),
    spawnImpl: spawnFakeChild,
    killImpl: () => {},
    createWindowsJobImpl: async () => ({ assigned: false, assign() {}, close: async () => {} }),
    confirmTreeDeadImpl: async pid => { unassignedCalls.push(pid); return { confirmed: true, alive: [] }; },
  });
  assert.deepEqual(unassignedCalls, [31337]);
  assert.equal(unassigned.passed, true);

  const assignedCalls = [];
  const assigned = await runVerification({ command: "node", timeoutSeconds: 10 }, process.cwd(), undefined, {
    resolveImpl: async () => ({ command: "node", args: [] }),
    spawnImpl: spawnFakeChild,
    killImpl: () => {},
    createWindowsJob: async () => ({ assigned: true, assign() {}, close: async () => {} }),
    confirmTreeDead: async pid => { assignedCalls.push(pid); return { confirmed: true, alive: [] }; },
  });
  assert.deepEqual(assignedCalls, []);
  assert.equal(assigned.passed, true);
});

test("S18 (5): real detached child closing its pipes is reaped via confirmTreeDead when no job is created", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-s18x-verify-"));
  const beatPath = path.join(dir, "beat");
  const childPidPath = path.join(dir, "child.pid");
  t.after(async () => {
    try {
      const pid = Number(await readFile(childPidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else try { process.kill(pid, "SIGKILL"); } catch {}
      }
    } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ticker = `const fs = require("node:fs");
    const dir = process.argv[1];
    setInterval(() => { if (!fs.existsSync(dir)) process.exit(0); fs.appendFileSync(dir + "/beat", "."); }, 20);
    setTimeout(() => process.exit(0), 20000);`;
  const rootScript = `const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(ticker)}, ${JSON.stringify(dir)}], {
      cwd: ${JSON.stringify(dir)}, detached: ${process.platform === "win32"}, stdio: "ignore", windowsHide: true
    });
    fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
    const wait = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(beatPath)})) { clearInterval(wait); child.unref(); process.exit(0); }
    }, 15);`;
  let confirmCalls = 0;
  const result = await runVerification({ command: process.execPath, args: ["-e", rootScript], timeoutSeconds: 15 }, dir, undefined, {
    createWindowsJob: async () => undefined,
    confirmTreeDead: (pid, opts) => { confirmCalls++; return confirmTreeDead(pid, opts); },
  });
  assert.equal(confirmCalls, 1);
  assert.equal(result.passed, true);
  const sizeBefore = (await readFile(beatPath)).length;
  assert.ok(sizeBefore > 0);
  await sleep(250);
  assert.equal((await readFile(beatPath)).length, sizeBefore, "detached child must be dead when runVerification resolves");
});

// ---- Item 6: tests for earlier fixes that have none ----

test("S18 (6a): warm server failure with no budget left for cold retry keeps codeMapSource", async () => {
  for (const source of ["codeindex", "regex"]) {
    let f;
    f = serveFixture({
      codeMapBuilder: async (_dir, { onSource }) => {
        onSource?.(source);
        return "## Code map\nsrc/main.js (1 lines): main:1";
      },
      onRun(child, servers) {
        if (!child.url) return;
        queueMicrotask(() => servers[0].finish(1));
        return false;
      },
      onTerminate(child) {
        child.finish(null);
        if (child.args[0] === "run") f.clock.advance(10_000);
      },
    });
    const out = await f.runner({ directory: process.cwd(), prompt: "inspect", model: "m/a", timeoutMs: 10_000, codeMap: true });
    assert.equal(out.status, "timeout");
    assert.equal(out.codeMapSource, source);
    assert.match(out.error, /warm OpenCode server failed/i);
    assert.equal(f.runs.length, 1);
  }
});

test("S18 (6b): unconfirmed server stop leaves the analysis pool so future runs still warm-start", async () => {
  const clock = fakeClock();
  let nextPort = 27000;
  const spawnedPorts = [];
  const pool = createServerPool({ getFreePort: async () => ++nextPort, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear });
  const startAndIdleTimeout = async dir => {
    const lease = await pool.acquire({ executable: "opencode", mode: "analysis", cwd: dir, env: {} }, {
      signal: new AbortController().signal,
      remainingMs: () => 120_000,
      runProcess: async opts => {
        const port = Number(opts.args[opts.args.indexOf("--port") + 1]);
        spawnedPorts.push(port);
        opts.onStdout(`opencode server listening on http://127.0.0.1:${port}\n`);
        await new Promise(resolve => opts.signal.addEventListener("abort", resolve, { once: true }));
        return { killConfirmed: false, stillAlive: [9000 + spawnedPorts.length] };
      },
    });
    assert.ok(lease, `expected warm lease for ${dir}`);
    lease.release();
  };
  await startAndIdleTimeout("/repo/a");
  await startAndIdleTimeout("/repo/b");
  clock.advance(120_000);
  await turn();
  // Both prior servers had unconfirmed stops; they must have left the pool so /repo/c still gets a warm server.
  await startAndIdleTimeout("/repo/c");
  assert.equal(spawnedPorts.length, 3);
});

test("S18 (6c): unconfirmed eviction makes the caller run cold without failing", async () => {
  const clock = fakeClock();
  let nextPort = 28000;
  const basePool = createServerPool({ getFreePort: async () => ++nextPort, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear });
  let stopCount = 0;
  const wrappedPool = {
    acquire(config, opts) {
      return basePool.acquire(config, {
        ...opts,
        runProcess: async pOpts => {
          const port = Number(pOpts.args[pOpts.args.indexOf("--port") + 1]);
          pOpts.onStdout(`opencode server listening on http://127.0.0.1:${port}\n`);
          await new Promise(resolve => pOpts.signal.addEventListener("abort", resolve, { once: true }));
          stopCount++;
          return { killConfirmed: false, stillAlive: [9500 + stopCount] };
        },
      });
    },
  };
  const runs = [];
  const runner = createOpenCodeRunner({
    serverPool: wrappedPool,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    nowImpl: clock.now,
    graceMs: 1,
    spawnImpl: (_exe, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(_c, _e, d) { d(); } }),
      });
      runs.push(args);
      queueMicrotask(() => {
        child.stdout.write('{"type":"text","sessionID":"ses_evict","text":"cold-ok"}\n');
        child.emit("close", 0);
      });
      return child;
    },
  });
  await runner({ directory: path.join(process.cwd(), "a"), prompt: "q", model: "m/a", codeMap: false });
  await runner({ directory: path.join(process.cwd(), "b"), prompt: "q", model: "m/a", codeMap: false });
  const third = await runner({ directory: path.join(process.cwd(), "c"), prompt: "q", model: "m/a", codeMap: false });
  assert.equal(third.text, "cold-ok");
  assert.equal(third.error, undefined);
  assert.equal(stopCount, 1);
  assert.ok(runs[0].includes("--attach") && runs[1].includes("--attach"));
  assert.equal(runs[2].includes("--attach"), false, "caller must run cold after unconfirmed eviction");
});

test("S18 (6d): guard loop trip on attached warm server stops that server and fallback runs with shared guard", async () => {
  const toolFailure = (id, sid) => JSON.stringify({
    type: "tool_use", sessionID: sid,
    part: { type: "tool", id, callID: id, messageID: "m1", tool: "read", state: { status: "error", input: { filePath: "missing.js" }, error: "ENOENT" } },
  });
  const toolSuccess = (id, sid) => JSON.stringify({
    type: "tool_use", sessionID: sid,
    part: { type: "tool", id, callID: id, messageID: "m2", tool: "read", state: { status: "completed", input: { filePath: "ok.js" }, output: "ok" } },
  });
  const f = serveFixture({
    onRun(child) {
      assert.ok(child.url, "both attempts should attach to warm servers");
      const model = child.args[child.args.indexOf("--model") + 1];
      if (model === "m/a") {
        child.stdout.write([toolFailure("1", "ses_a"), toolFailure("2", "ses_a"), toolFailure("3", "ses_a")].join("\n") + "\n");
        child.finish(0);
        return false;
      }
      child.stdout.write([
        toolSuccess("4", "ses_b"),
        JSON.stringify({ type: "text", sessionID: "ses_b", part: { type: "text", id: "t1", messageID: "m2", text: "answer from b" } }),
      ].join("\n") + "\n");
      child.finish(0);
      return false;
    },
  });
  const result = await runAnalysis({
    directory: process.cwd(),
    prompt: "Explain",
    models: [{ id: "m/a" }, { id: "m/b" }],
    guard: { maxRepeatedFailures: 3, maxToolCalls: 10 },
    codeMap: false,
    runner: f.runner,
  });
  assert.equal(result.text, "answer from b");
  assert.equal(result.model, "m/b");
  assert.equal(f.servers.length, 2);
  assert.equal(f.servers[0].closed, true, "loop trip on attached run must stop that warm server");
  assert.equal(f.runs.length, 2, "must not retry looping model cold");
  assert.equal(f.runs[0].url, f.servers[0].url);
  assert.equal(f.runs[1].url, f.servers[1].url);
  assert.equal(result.guard.totalToolCalls, 4, "fallback model shares cumulative guard counters");
});
