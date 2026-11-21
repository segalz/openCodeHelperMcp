import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { acquire, CheckoutBusyError, checkoutLockPath } from "../src/checkoutlock.js";
import { buildCodeMap } from "../src/codemap.js";
import { createOpenCodeRunner, registerAnalysisTools, runAnalysis, runBoundedProcess } from "../src/core.js";
import { runEdits, VERIFY_RESERVE_MARGIN_MS } from "../src/edits.js";
import { createWindowsJob } from "../src/jobobject.js";
import { confirmTreeDead, listProcessTable } from "../src/proctree.js";
import { createServerPool } from "../src/server-pool.js";
import { createdFiles, headAndIndexIdentity, restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { runVerification } from "../src/verify.js";
import * as waits from "../src/waits.js";

const {
  KILL_CONFIRM_MARGIN_MS, KILL_SETTLE_MS, PROCESS_QUERY_TIMEOUT_MS, PROCESS_TABLE_TIMEOUT_MS,
  RESTORE_BUDGET_MS, SETTLE_MARGIN_MS, TREE_KILL_CONFIRM_MS,
} = waits;

function child(exitCode = null) {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true, exitCode, signalCode: null,
  });
}

function mockSpawn(t, spawn) {
  const stub = t.mock.method(childProcess, "spawn", spawn);
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
}

function drainedJob() {
  let alive = true, assigned = false, confirmed = false;
  return {
    get alive() { return alive; },
    get assigned() { return assigned; },
    get confirmed() { return confirmed; },
    assign() { assigned = true; },
    async close() { alive = false; assigned = false; confirmed = true; return true; },
  };
}

function fakeGitSpawn(t, root, filesList = "a.txt\0") {
  mockSpawn(t, (_file, args) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = filesList;
    else if (cmd === "check-ignore") out = "";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
}

for (const stage of ["checkout", "identity"]) {
  test(`aborting an in-flight ${stage} Git call stops the child without waiting for close`, async t => {
    const controller = new AbortController();
    const reason = new Error("cancelled during Git");
    let kills = 0, calls = 0;
    mockSpawn(t, (_file, args) => {
      const proc = child();
      calls++;
      if (stage === "identity" && args.includes("--show-toplevel")) {
        queueMicrotask(() => { proc.stdout.end(process.cwd()); proc.emit("close", 0); });
      } else {
        proc.kill = () => { kills++; return true; };
        queueMicrotask(() => controller.abort(reason));
      }
      return proc;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const work = stage === "identity" ? headAndIndexIdentity(process.cwd(), controller.signal)
      : takeSnapshot(process.cwd(), { signal: controller.signal });
    await assert.rejects(work, error => error === reason);
    assert.equal(kills, 1);
    assert.equal(calls, stage === "identity" ? 2 : 1);
  });
}

for (const { remainingMs, timeoutSeconds, workMs } of [
  { remainingMs: 800, timeoutSeconds: 30, workMs: 800 },
  { remainingMs: 60_000, timeoutSeconds: 1, workMs: 1_000 },
]) {
  test(`a stalled confirmation settles within the shorter verify budget (${workMs} ms) plus margin`, async t => {
    assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    mockSpawn(t, file => {
      const proc = child();
      if (file === process.execPath) { started(); return Object.assign(proc, { pid: 12345, exitCode: 0 }); }
      return proc;
    });
    let confirmCap;
    const result = runVerification({ command: process.execPath, timeoutSeconds }, process.cwd(), undefined, {
      remainingMs, now: Date.now, createWindowsJob: async () => undefined,
      confirmTreeDead: (_pid, options) => { confirmCap = options.capMs; return new Promise(() => {}); },
    });
    await launched;
    t.mock.timers.tick(workMs);
    assert.equal(confirmCap, KILL_CONFIRM_MARGIN_MS);
    t.mock.timers.tick(KILL_CONFIRM_MARGIN_MS);
    const check = await result;
    assert.deepEqual([check.passed, check.timedOut, check.killConfirmed, check.killUnverified], [false, true, false, true]);
    assert.equal(check.durationMs, workMs + KILL_CONFIRM_MARGIN_MS);
  });
}

for (const reason of ["timeout", "cancelled"]) {
  test(`real-PID runner confirmation respects the ${reason} settlement cap`, async t => {
    assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    const controller = new AbortController();
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    const cap = reason === "timeout" ? 175 : KILL_CONFIRM_MARGIN_MS;
    let received;
    const runner = createOpenCodeRunner({
      env: {}, platform: "win32", nowImpl: Date.now,
      killProcessTreeImpl: () => {},
      createWindowsJob: async () => undefined,
      settlementDeadlineMs: reason === "timeout" ? cap : undefined,
      spawnImpl: () => {
        started();
        return Object.assign(new childProcess.ChildProcess(), {
          pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(),
          stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
        });
      },
      confirmTreeDead: (_pid, opts) => {
        received = opts.capMs;
        return new Promise(resolve => setTimeout(() => resolve({ confirmed: false, alive: [], unverified: true }), received));
      },
    });
    const pending = runner({
      directory: process.cwd(), prompt: "test", model: "m/a", codeMap: false,
      timeoutMs: 1_000, signal: controller.signal,
    });
    await launched;
    if (reason === "cancelled") controller.abort(); else t.mock.timers.tick(1_000);
    assert.equal(received, cap);
    t.mock.timers.tick(cap);
    const result = await pending;
    assert.equal(result.killConfirmed, false);
    assert.equal(result.killUnverified, true);
    if (reason === "cancelled") assert.equal(result.cancelled, true);
    else assert.equal(result.status, "timeout");
  });
}

test("cancel also shortens a verification already waiting for its process table", async t => {
  assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const controller = new AbortController();
  let started;
  const confirming = new Promise(resolve => { started = resolve; });
  mockSpawn(t, () => {
    const proc = Object.assign(child(0), { pid: 12345 });
    queueMicrotask(() => { proc.emit("exit", 0, null); proc.emit("close", 0, null); });
    return proc;
  });
  const pending = runVerification({ command: process.execPath }, process.cwd(), controller.signal, {
    now: Date.now, createWindowsJob: async () => undefined,
    confirmTreeDead: () => { started(); return new Promise(() => {}); },
  });
  await confirming;
  controller.abort();
  t.mock.timers.tick(KILL_CONFIRM_MARGIN_MS);
  const result = await pending;
  assert.deepEqual([result.passed, result.killConfirmed, result.killUnverified], [false, false, true]);
  assert.equal(result.durationMs, KILL_CONFIRM_MARGIN_MS);
});

test("budget constants satisfy the shutdown, reserve, drain, and two-read invariants", () => {
  assert.equal(typeof RESTORE_BUDGET_MS, "number");
  assert.equal(typeof SETTLE_MARGIN_MS, "number");
  assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
  assert.equal(typeof PROCESS_QUERY_TIMEOUT_MS, "number");
  assert.equal(typeof waits.boundedSignal, "function");
  assert.equal(typeof waits.settlementBudget, "function");
  assert.equal(typeof waits.untilAborted, "function");
  assert.ok(RESTORE_BUDGET_MS < 120_000, "restore budget fits below the 120 s shutdown cap");
  assert.ok(SETTLE_MARGIN_MS < 5_000, "settlement margin stays short");
  assert.ok(SETTLE_MARGIN_MS < VERIFY_RESERVE_MARGIN_MS, "verify settlement margin fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS <= VERIFY_RESERVE_MARGIN_MS, "kill settle cap fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS > 2_000, "job.close() cap exceeds the Windows job owner's 2 s drain");
  assert.ok(KILL_CONFIRM_MARGIN_MS >= PROCESS_TABLE_TIMEOUT_MS + 1_000, "confirmation margin fits a full table read plus polling");
  assert.ok(KILL_CONFIRM_MARGIN_MS < TREE_KILL_CONFIRM_MS, "confirmation margin stays below two-read cap");
  assert.ok(TREE_KILL_CONFIRM_MS >= 2 * PROCESS_TABLE_TIMEOUT_MS + 2_000, "two process-table reads fit with slack");
});

test("createdFiles and restoreSnapshot honor AbortSignal and the 90 s RESTORE_BUDGET_MS cap", async t => {
  assert.equal(typeof RESTORE_BUDGET_MS, "number");
  const dir = await mkdtemp(path.join(os.tmpdir(), "snap-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handle = { checkoutRoot: dir, directory: path.join(dir, "store"), manifest: [] };
  const controller = new AbortController();
  const reason = new Error("cancelled createdFiles");
  let phase = "created";
  let secondStarted;
  const secondGit = new Promise(resolve => { secondStarted = resolve; });
  let thirdStarted;
  const thirdGit = new Promise(resolve => { thirdStarted = resolve; });
  let kills = 0;
  let gitCalls = 0;
  mockSpawn(t, (_file, args) => {
    const proc = child();
    if (phase === "created") {
      if (args.includes("--show-toplevel")) {
        queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
      } else {
        proc.kill = () => { kills++; return true; };
        queueMicrotask(() => controller.abort(reason));
      }
      return proc;
    }
    gitCalls++;
    if (args.includes("--show-toplevel")) {
      queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
    } else if (gitCalls === 2) {
      // First ls-files takes 50 s (under the 60 s per-call cap), leaving 40 s of RESTORE_BUDGET_MS.
      secondStarted();
      setTimeout(() => { proc.stdout.end(""); proc.emit("close", 0); }, 50_000);
    } else {
      // Next Git call stalls forever; must abort at RESTORE_BUDGET_MS (90 s), not 50 s + 60 s = 110 s.
      proc.kill = () => { kills++; return true; };
      thirdStarted();
    }
    return proc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(createdFiles(handle, controller.signal), err => err === reason);
  assert.equal(kills, 1);

  phase = "restore";
  kills = 0;
  const restoring = restoreSnapshot(handle);
  await secondGit;
  t.mock.timers.tick(50_000);
  await thirdGit;
  assert.equal(kills, 0);
  t.mock.timers.tick(RESTORE_BUDGET_MS - 50_000);
  const report = await restoring;
  assert.equal(kills, 1);
  assert.deepEqual(report.failed, [{ path: ".", error: "not attempted (restore deadline): created-files scan did not run" }]);
});

test("checkoutlock acquire honors signal abort and deadlineMs across stale-lock reclamation", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lock-budget-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo"), locks = path.join(base, "locks");
  await mkdir(repo); await mkdir(locks);
  const lockFile = checkoutLockPath(repo, locks);
  await writeFile(lockFile, JSON.stringify({ pid: process.ppid, time: new Date(Date.now() - 3_600_000).toISOString(), token: "stale" }));

  let kills = 0;
  let execCalls = 0;
  const stub = t.mock.method(childProcess, "execFile", () => {
    execCalls++;
    const proc = child();
    proc.kill = () => { kills++; return true; };
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  if (process.platform === "win32") {
    const controller = new AbortController();
    const reason = new Error("cancelled lock acquire");
    const pendingCancel = acquire(repo, { lockDirectory: locks, signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    await assert.rejects(pendingCancel, err => err === reason);
    assert.equal(execCalls, 1);
    assert.equal(kills, 1);

    execCalls = 0; kills = 0;
    const pendingDeadline = acquire(repo, { lockDirectory: locks, deadlineMs: 120 });
    const busy = assert.rejects(pendingDeadline, CheckoutBusyError);
    t.mock.timers.tick(120);
    await busy;
    assert.equal(execCalls, 1);
    assert.equal(kills, 1);
  }
});

test("listProcessTable and buildCodeMap respect caller timeout and abort signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let kills = 0;
  let destroyed = 0;
  mockSpawn(t, () => {
    const proc = child();
    proc.kill = () => { kills++; return true; };
    const origDestroy = proc.stdout.destroy.bind(proc.stdout);
    proc.stdout.destroy = (...args) => { destroyed++; return origDestroy(...args); };
    return proc;
  });

  if (process.platform === "win32") {
    const pendingTimeout = listProcessTable(300);
    t.mock.timers.tick(299);
    assert.equal(kills, 0);
    t.mock.timers.tick(1);
    assert.equal(await pendingTimeout, null);
    assert.equal(kills, 1);

    kills = 0;
    const controller = new AbortController();
    const pendingAbort = listProcessTable(PROCESS_TABLE_TIMEOUT_MS, controller.signal);
    controller.abort();
    assert.equal(await pendingAbort, null);
    assert.equal(kills, 1);
  }

  kills = 0; destroyed = 0;
  const controller = new AbortController();
  let spawnStarted;
  const mapSpawned = new Promise(resolve => { spawnStarted = resolve; });
  const mapWork = buildCodeMap(process.cwd(), {
    env: {},
    signal: controller.signal,
    spawnImpl: () => {
      const proc = child();
      proc.pid = undefined;
      proc.kill = () => { kills++; return true; };
      const origDestroy = proc.stdout.destroy.bind(proc.stdout);
      proc.stdout.destroy = (...args) => { destroyed++; return origDestroy(...args); };
      spawnStarted();
      return proc;
    },
  });
  await mapSpawned;
  controller.abort();
  await assert.rejects(mapWork, { name: "AbortError" });
  assert.equal(kills, 1);
  assert.ok(destroyed >= 1, "aborted code-map Git child must destroy stdout");
});

test("analysis runner settles within budget plus margin when confirmTreeDead hangs, and warm server stop/eviction obey budget", async t => {
  assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started;
  const launched = new Promise(resolve => { started = resolve; });
  const runner = createOpenCodeRunner({
    env: {}, platform: "win32", nowImpl: Date.now,
    killProcessTreeImpl: () => {},
    createWindowsJob: async () => undefined,
    confirmTreeDead: () => new Promise(() => {}),
    spawnImpl: () => {
      started();
      return Object.assign(new childProcess.ChildProcess(), {
        pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      });
    },
  });
  const pending = runAnalysis({
    directory: process.cwd(), prompt: "test", budgetMs: 30_000, codeMap: false,
    models: [{ id: "m/a" }], runner, nowImpl: Date.now,
  });
  await launched;
  t.mock.timers.tick(30_000 + KILL_CONFIRM_MARGIN_MS);
  const result = await pending;
  assert.equal(result.killConfirmed, false);
  assert.equal(result.killUnverified, true);
  assert.equal(Date.now() - 1_000, 30_000 + KILL_CONFIRM_MARGIN_MS);

  // Idle server eviction must stop waiting when the caller's remaining budget expires (or on cancel).
  let nextPort = 29000;
  const pool = createServerPool({ getFreePort: async () => ++nextPort });
  const startIdle = async (dir) => {
    const lease = await pool.acquire({ executable: "opencode", mode: "analysis", cwd: dir, env: {} }, {
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
      runProcess: async opts => {
        const port = Number(opts.args[opts.args.indexOf("--port") + 1]);
        opts.onStdout(`opencode server listening on http://127.0.0.1:${port}\n`);
        // Never resolves on abort — simulates a slow/wedged server stop during eviction.
        return new Promise(() => {});
      },
    });
    assert.ok(lease);
    lease.release();
  };
  await startIdle(path.join(process.cwd(), "a"));
  await startIdle(path.join(process.cwd(), "b"));
  const evictStarted = Date.now();
  const evicting = pool.acquire({ executable: "opencode", mode: "analysis", cwd: path.join(process.cwd(), "c"), env: {} }, {
    signal: new AbortController().signal,
    remainingMs: () => Math.max(0, evictStarted + 500 - Date.now()),
    runProcess: async () => ({ exitCode: 0 }),
  });
  t.mock.timers.tick(500);
  const thirdLease = await evicting;
  assert.equal(thirdLease, undefined, "eviction must stop waiting at caller's remainingMs and let caller fall back");
  assert.equal(Date.now() - evictStarted, 500);
});

test("combined attached client and warm server timeout settle in parallel within budget plus margin", async t => {
  assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let nextPort = 29500;
  const pool = createServerPool({ getFreePort: async () => ++nextPort });
  let clientStarted;
  const clientLaunched = new Promise(resolve => { clientStarted = resolve; });
  const runner = createOpenCodeRunner({
    env: {}, platform: "win32", nowImpl: Date.now, serverPool: pool,
    killProcessTreeImpl: () => {},
    createWindowsJob: async () => undefined,
    confirmTreeDead: () => new Promise(() => {}),
    spawnImpl: (_exe, args) => {
      const proc = Object.assign(new childProcess.ChildProcess(), {
        pid: args[0] === "serve" ? 20001 : 20002,
        stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      });
      if (args[0] === "serve") {
        const port = Number(args[args.indexOf("--port") + 1]);
        queueMicrotask(() => proc.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`));
      } else {
        clientStarted();
      }
      return proc;
    },
  });
  const pending = runner({ directory: process.cwd(), prompt: "test", model: "m/a", codeMap: false, timeoutMs: 1_000 });
  await clientLaunched;
  t.mock.timers.tick(1_000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(KILL_CONFIRM_MARGIN_MS);
  const out = await pending;
  assert.equal(out.status, "timeout");
  assert.equal(out.killConfirmed, false);
  assert.deepEqual(out.stillAlive, [20002, 20001]);
  assert.equal(Date.now() - 1_000, 1_000 + KILL_CONFIRM_MARGIN_MS);
});

test("slow 12 s process-table read confirms a timed-out check when no Job Object is available", async t => {
  assert.equal(typeof KILL_CONFIRM_MARGIN_MS, "number");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started;
  const launched = new Promise(resolve => { started = resolve; });
  let proc;
  mockSpawn(t, file => {
    const p = child();
    if (file === process.execPath) {
      proc = p;
      started();
      return Object.assign(p, { pid: 12345 });
    }
    return p;
  });
  const readCaps = [];
  const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
    now: Date.now,
    createWindowsJob: async () => undefined,
    confirmTreeDead: (pid, opts) => confirmTreeDead(pid, {
      ...opts,
      platform: "win32",
      killRoot: () => { proc.exitCode = 1; proc.emit("exit", 1, null); proc.emit("close", 1, null); },
      listTable: ms => {
        readCaps.push(ms);
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve([]), 12_000);
          opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(null); }, { once: true });
        });
      },
    }),
  });
  await launched;
  t.mock.timers.tick(1_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readCaps, [PROCESS_TABLE_TIMEOUT_MS]);
  t.mock.timers.tick(12_000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(250);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, undefined, "12 s table read must confirm the kill");
  assert.equal(result.killUnverified, undefined);
});

test("Windows Job Object still runs process-table confirmation and confirms an unreadable table when no pipes are held open", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let tableCalls = 0;
  let verifyStarted;
  const verifyLaunched = new Promise(resolve => { verifyStarted = resolve; });
  let verifyProc;
  mockSpawn(t, file => {
    const proc = child();
    if (file === process.execPath) {
      verifyProc = proc;
      verifyStarted();
      return Object.assign(proc, { pid: 12345 });
    }
    return proc;
  });
  let closed = false;
  const mockJob = () => {
    let alive = true, assigned = false, confirmed = false;
    return {
      get alive() { return alive; },
      get assigned() { return assigned; },
      get confirmed() { return confirmed; },
      assign() { assigned = true; },
      async close() {
        closed = true;
        alive = false;
        assigned = false;
        confirmed = true;
        queueMicrotask(() => verifyProc?.emit?.("close", null, "SIGKILL"));
        return true;
      },
    };
  };
  const verified = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
    now: Date.now,
    createWindowsJob: async () => mockJob(),
    confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
  });
  await verifyLaunched;
  t.mock.timers.tick(1_000);
  const result = await verified;
  assert.equal(closed, true);
  assert.equal(tableCalls, 1, "drained Job Object must still run confirmTreeDead");
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, undefined);
  assert.equal(result.killUnverified, undefined);

  // Also test runBoundedProcess with a real-PID child assigned to a WindowsJob.
  let runnerStarted;
  const runnerLaunched = new Promise(resolve => { runnerStarted = resolve; });
  closed = false;
  const pendingRun = runBoundedProcess({
    executable: "mock", args: [], cwd: process.cwd(), env: {}, timeoutMs: 1_000,
    platform: "win32", nowImpl: Date.now, terminate: () => {},
    createWindowsJob: async () => mockJob(),
    confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
    spawnImpl: () => {
      runnerStarted();
      return Object.assign(new childProcess.ChildProcess(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
    },
  });
  await runnerLaunched;
  t.mock.timers.tick(1_000);
  const runResult = await pendingRun;
  assert.equal(closed, true);
  assert.equal(tableCalls, 2, "runner with drained Job Object must still run confirmTreeDead");
  assert.equal(runResult.timedOut, true);
  assert.equal(runResult.killConfirmed, undefined);
  assert.equal(runResult.killUnverified, undefined);
});

test("real Windows Job Object helper confirms ActiveProcesses == 0 on close", { skip: process.platform !== "win32" }, async t => {
  const job = await createWindowsJob(15_000);
  assert.ok(job);
  const proc = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => { proc.kill(); await job.close(); });
  job.assign(proc);
  const deadline = Date.now() + 10_000;
  while (!job.assigned && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(job.assigned, true);
  const confirmed = await job.close();
  assert.equal(confirmed, true, "closing an assigned job must confirm ActiveProcesses == 0");
});

test("a restore that hits RESTORE_BUDGET_MS mid-loop finishes the current file, returns a partial report, keeps the snapshot, and sets evidence.restore", async t => {
  assert.equal(typeof RESTORE_BUDGET_MS, "number");
  const base = await mkdtemp(path.join(os.tmpdir(), "partial-restore-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  for (const [name, content] of [["a.txt", "base-a"], ["b.txt", "base-b"], ["c.txt", "base-c"]]) {
    await writeFile(path.join(root, name), content);
  }
  fakeGitSpawn(t, root, "a.txt\0b.txt\0c.txt\0");

  // Hit RESTORE_BUDGET_MS while restoring a.txt; a.txt must still finish cleanly, while b.txt and c.txt are marked not attempted.
  const realRename = fsPromises.rename;
  let tripped = false;
  let restoringPhase = false;
  const renameMock = t.mock.method(fsPromises, "rename", async (...args) => {
    if (restoringPhase && !tripped && String(args[1]).endsWith("a.txt")) {
      tripped = true;
      t.mock.timers.tick(RESTORE_BUDGET_MS);
    }
    return realRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const out = await runEdits(
    { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, verify: { none: true, reason: "Partial restore fixture" } },
    {
      resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      ignoredPathsImpl: async () => [],
      runner: async () => {
        await writeFile(path.join(root, "a.txt"), "edit-a");
        await writeFile(path.join(root, "b.txt"), "edit-b");
        await writeFile(path.join(root, "c.txt"), "edit-c");
        restoringPhase = true;
        return { text: "QUESTION: Stop here?", sessionID: "ses_pr" };
      },
    },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.error, "input_required");
  assert.equal(out.verification.restored, false);
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory), "snapshot directory must be kept after partial restore");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "base-a", "current file must finish restoring");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "edit-b");
  assert.equal(await readFile(path.join(root, "c.txt"), "utf8"), "edit-c");
  const report = out.evidence.restore;
  assert.ok(report, "evidence.restore must be populated with the partial report");
  assert.deepEqual(report.restored, ["a.txt"]);
  assert.deepEqual(report.failed, [
    { path: "b.txt", error: "not attempted (restore deadline)" },
    { path: "c.txt", error: "not attempted (restore deadline)" },
  ]);
});

test("an unconfirmed kill never triggers an automatic restore in sync edits (run, verify, or cancel)", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "unconfirmed-no-restore-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  fakeGitSpawn(t, root, "a.txt\0");

  // 1. Cancelled edit with unconfirmed kill: must NOT restore.
  await writeFile(path.join(root, "a.txt"), "baseline");
  const controller = new AbortController();
  const cancelledOut = await runEdits(
    { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, verify: { none: true, reason: "Unconfirmed cancel fixture" } },
    {
      resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      ignoredPathsImpl: async () => [], signal: controller.signal,
      runner: async () => {
        await writeFile(path.join(root, "a.txt"), "edited-before-cancel");
        controller.abort();
        return { status: "failed", cancelled: true, error: "OpenCode run cancelled.", killConfirmed: false, stillAlive: [9090], killUnverified: true };
      },
    },
  );
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-before-cancel", "must not restore while kill is unconfirmed");
  assert.equal(cancelledOut.verification.restored, false);
  assert.deepEqual(cancelledOut.evidence.processesStillAlive, [9090]);
  assert.equal(cancelledOut.evidence.killUnverified, true);
  assert.ok(typeof cancelledOut.evidence.snapshotDirectory === "string" && existsSync(cancelledOut.evidence.snapshotDirectory));

  // 2. Real runner timeout with unconfirmed kill: must NOT restore.
  await writeFile(path.join(root, "a.txt"), "baseline");
  const runner = createOpenCodeRunner({
    env: {}, platform: "win32",
    killProcessTreeImpl: () => {},
    createWindowsJob: async () => undefined,
    settlementDeadlineMs: 20,
    confirmTreeDead: async () => ({ confirmed: false, alive: [4242], unverified: true }),
    spawnImpl: () => {
      void writeFile(path.join(root, "a.txt"), "edited-sync");
      return Object.assign(new childProcess.ChildProcess(), {
        pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      });
    },
  });
  const syncOut = await runEdits(
    { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, verify: { none: true, reason: "Sync unconfirmed fixture" } },
    {
      resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      ignoredPathsImpl: async () => [], deadline: Date.now() + 5_000,
      runner: call => runner({ ...call, timeoutMs: 40 }),
    },
  );
  assert.equal(syncOut.verification.restored, false);
  assert.deepEqual(syncOut.evidence.processesStillAlive, [4242]);
  assert.ok(typeof syncOut.evidence.snapshotDirectory === "string" && existsSync(syncOut.evidence.snapshotDirectory));
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-sync", "sync edits must not restore while kill is unconfirmed");

  // 3. Failed verification with unconfirmed kill: must NOT restore, no repair runs.
  await writeFile(path.join(root, "a.txt"), "baseline");
  let verifyRunCount = 0;
  const verifyOut = await runEdits(
    { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, maxFixRuns: 2, verify: { command: process.execPath, args: ["-e", "0"] } },
    {
      resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      ignoredPathsImpl: async () => [],
      runner: async () => {
        verifyRunCount++;
        await writeFile(path.join(root, "a.txt"), "edited-verify");
        return { text: "done", sessionID: "ses_v" };
      },
      verifyImpl: async () => ({
        passed: false, exitCode: null, signal: "SIGKILL", timedOut: true, killedForOutput: false,
        durationMs: 1, stdoutTail: "", stderrTail: "", killConfirmed: false, stillAlive: [5151], killUnverified: true,
      }),
    },
  );
  assert.equal(verifyRunCount, 1, "no repair may launch after an unconfirmed verify kill");
  assert.equal(verifyOut.verification.restored, false);
  assert.deepEqual(verifyOut.evidence.processesStillAlive, [5151]);
  assert.equal(verifyOut.evidence.killUnverified, true);
  assert.ok(typeof verifyOut.evidence.snapshotDirectory === "string" && existsSync(verifyOut.evidence.snapshotDirectory));
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-verify", "verify unconfirmed kill must not trigger auto-restore");
});

test("cancelling analyze_code while catalog.list is pending stops waiting promptly", async () => {
  const controller = new AbortController();
  const tools = new Map();
  registerAnalysisTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, {
    resolveAllowedPath: async dir => dir,
    catalog: { list: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } },
    runner: () => assert.fail("cancelled analysis must not launch a model"),
  });
  const reply = await tools.get("analyze_code")(
    { directory: process.cwd(), prompt: "inspect", codeMap: false },
    { signal: controller.signal },
  );
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /cancelled/i);
});

test("a cold catalog.list never holds analyze_code past budgetMs", async t => {
  // Opus review of the OpenCode mirror: the catalog's own 60 s cap was not bounded by budgetMs.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tools = new Map();
  registerAnalysisTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, {
    resolveAllowedPath: async dir => dir,
    catalog: { list: () => new Promise(() => {}) },
    runner: () => assert.fail("no model may run without a catalog"),
  });
  const pending = tools.get("analyze_code")({ directory: process.cwd(), prompt: "inspect", codeMap: false, budgetMs: 30_000 }, {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(30_001);
  const reply = await pending;
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /did not answer within budgetMs \(30000 ms\)/);
});

test("verify exitGrace gets its full 500 ms inside the settle margin when the check exits at its deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started;
  const launched = new Promise(resolve => { started = resolve; });
  let proc;
  mockSpawn(t, () => {
    proc = child();
    started();
    return Object.assign(proc, { pid: 12345 });
  });
  const job = { alive: true, assigned: true, assign() {}, async close() { return true; } };
  const pending = runVerification({ command: process.execPath, timeoutSeconds: 10 }, process.cwd(), undefined, {
    remainingMs: 1_000,
    now: Date.now,
    createWindowsJob: async () => job,
  });
  await launched;
  // Advance to right before deadline, jump to exact deadline as child exits, then close 50 ms later.
  t.mock.timers.tick(999);
  t.mock.timers.setTime(2_000);
  proc.exitCode = 0;
  proc.emit("exit", 0, null);
  t.mock.timers.tick(50);
  proc.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.passed, true, "exit at deadline followed by prompt close must not be treated as pipesHeldOpen");
  assert.equal(result.timedOut, false);
  assert.equal(result.killConfirmed, undefined);
  assert.equal(result.durationMs, 1_050);
});

test("timeout during keepOnFailure preserves the snapshot and does not mark edits kept", async t => {
  assert.equal(typeof RESTORE_BUDGET_MS, "number");
  const base = await mkdtemp(path.join(os.tmpdir(), "keep-timeout-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "baseline");
  let stallIdentity = false;
  let identityStarted;
  const identityStalled = new Promise(resolve => { identityStarted = resolve; });
  mockSpawn(t, (_file, args) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    if (stallIdentity && cmd === "rev-parse" && arg === "HEAD") {
      identityStarted();
      return proc; // stalls forever
    }
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runEdits(
    { directory: root, prompt: "Edit", model: "opencode/test-free", keepOnFailure: true, codeMap: false, verify: { none: true, reason: "Keep timeout fixture" } },
    {
      resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      ignoredPathsImpl: async () => [],
      runner: async () => {
        stallIdentity = true;
        return { status: "failed", error: "model failed" };
      },
    },
  );
  await identityStalled;
  // First identity check is post-run; stall recovery's identity check as well.
  t.mock.timers.tick(RESTORE_BUDGET_MS);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(RESTORE_BUDGET_MS);
  const out = await pending;
  assert.equal(out.verification.kept, false, "timeout during keep must not mark edits kept");
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory), "snapshot must be kept when keep times out");
});

test("a child alive outside a drained Job Object is NOT confirmed in verify or runner, and triggers no auto-restore", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "job-escape-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "baseline");

  // 1. runVerification timeout: drained job + live descendant in table => NOT confirmed.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    let verifyProc;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12345 }); }
      return p;
    });
    let tableCalls = 0;
    const job = drainedJob();
    const origClose = job.close.bind(job);
    job.close = async () => {
      const ok = await origClose();
      queueMicrotask(() => { verifyProc.exitCode = 1; verifyProc.emit("exit", 1, null); verifyProc.emit("close", 1, null); });
      return ok;
    };
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => job,
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [9001] }; },
    });
    await launched;
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(tableCalls, 1, "confirmTreeDead must still run after a drained job");
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.deepEqual(result.stillAlive, [9001]);
    t.mock.timers.reset();
  }

  // 2. runVerification pipesHeldOpen: root exits 0, drained job + live descendant => NOT confirmed.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    let verifyProc;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12346 }); }
      return p;
    });
    let tableCalls = 0;
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 10 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [9002] }; },
    });
    await launched;
    verifyProc.exitCode = 0;
    verifyProc.emit("exit", 0, null);
    t.mock.timers.tick(500);
    const result = await pending;
    assert.equal(tableCalls, 1, "pipesHeldOpen must still run confirmTreeDead after a drained job");
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.deepEqual(result.stillAlive, [9002]);
    t.mock.timers.reset();
  }

  // 3. Sync runEdits with drained job + live descendant in runner (timeout and exit-with-held-pipes): NOT confirmed, NO auto-restore.
  fakeGitSpawn(t, root, "a.txt\0");
  for (const mode of ["timeout", "pipesHeldOpen"]) {
    await writeFile(path.join(root, "a.txt"), "baseline");
    const alivePid = mode === "timeout" ? 9003 : 9004;
    let tableCalls = 0;
    const runner = createOpenCodeRunner({
      env: {}, platform: "win32", graceMs: 25,
      killProcessTreeImpl: () => {},
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [alivePid] }; },
      spawnImpl: () => {
        const proc = Object.assign(new childProcess.ChildProcess(), {
          pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
          stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
        });
        void writeFile(path.join(root, "a.txt"), `edited-${mode}`).then(() => {
          if (mode === "pipesHeldOpen") {
            proc.stdout.write('{"type":"text","sessionID":"ses_esc","text":"done"}\n');
            proc.exitCode = 0;
            proc.emit("exit", 0, null);
            // Deliberately do NOT emit "close" — simulates an escaped child holding pipes open.
          }
        });
        return proc;
      },
    });
    const out = await runEdits(
      { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, verify: { none: true, reason: `Escaped child ${mode} fixture` } },
      {
        resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
        ignoredPathsImpl: async () => [],
        runner: call => runner({ ...call, timeoutMs: mode === "timeout" ? 40 : 2_000 }),
      },
    );
    assert.equal(out.status, "failed", `${mode}: must fail`);
    assert.equal(out.verification.restored, false, `${mode}: must NOT auto-restore`);
    assert.deepEqual(out.evidence.processesStillAlive, [alivePid]);
    assert.ok(typeof out.evidence.snapshotDirectory === "string" && existsSync(out.evidence.snapshotDirectory));
    assert.equal(tableCalls, 1, `${mode}: runner must run confirmTreeDead after drained job`);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), `edited-${mode}`, `${mode}: file must stay unrestored`);
  }
});

test("drained Job Object + unreadable process table: confirmed without pipesHeldOpen, unconfirmed with pipesHeldOpen", async t => {
  // 1. runVerification: timeout (pipesHeldOpen = false) + drained job + unreadable table => confirmed.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    let verifyProc;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12345 }); }
      return p;
    });
    let tableCalls = 0;
    const job = drainedJob();
    const origClose = job.close.bind(job);
    job.close = async () => {
      const ok = await origClose();
      queueMicrotask(() => { verifyProc.exitCode = 1; verifyProc.emit("exit", 1, null); verifyProc.emit("close", 1, null); });
      return ok;
    };
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => job,
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
    });
    await launched;
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(tableCalls, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.killConfirmed, undefined);
    assert.equal(result.killUnverified, undefined);
    t.mock.timers.reset();
  }

  // 2. runVerification: pipesHeldOpen = true + drained job + unreadable table => unconfirmed (unverified: true).
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started;
    const launched = new Promise(resolve => { started = resolve; });
    let verifyProc;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12346 }); }
      return p;
    });
    let tableCalls = 0;
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 10 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
    });
    await launched;
    verifyProc.exitCode = 0;
    verifyProc.emit("exit", 0, null);
    t.mock.timers.tick(500);
    const result = await pending;
    assert.equal(tableCalls, 1);
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.equal(result.killUnverified, true);
    t.mock.timers.reset();
  }

  // 3. runner: exit-with-held-pipes + drained job + unreadable table => unconfirmed (no auto-restore).
  {
    const base = await mkdtemp(path.join(os.tmpdir(), "runner-unreadable-pipes-"));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
    const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
    await mkdir(root);
    await writeFile(path.join(root, "a.txt"), "baseline");
    fakeGitSpawn(t, root, "a.txt\0");

    let tableCalls = 0;
    const runner = createOpenCodeRunner({
      env: {}, platform: "win32", graceMs: 25,
      killProcessTreeImpl: () => {},
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
      spawnImpl: () => {
        const proc = Object.assign(new childProcess.ChildProcess(), {
          pid: 4243, stdout: new PassThrough(), stderr: new PassThrough(),
          stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
        });
        void writeFile(path.join(root, "a.txt"), "edited-unreadable").then(() => {
          proc.stdout.write('{"type":"text","sessionID":"ses_unr","text":"done"}\n');
          proc.exitCode = 0;
          proc.emit("exit", 0, null);
        });
        return proc;
      },
    });
    const out = await runEdits(
      { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, verify: { none: true, reason: "Unreadable table pipesHeldOpen fixture" } },
      {
        resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
        ignoredPathsImpl: async () => [],
        runner: call => runner({ ...call, timeoutMs: 2_000 }),
      },
    );
    assert.equal(out.status, "failed");
    assert.equal(out.verification.restored, false);
    assert.equal(out.evidence.killUnverified, true);
    assert.ok(typeof out.evidence.snapshotDirectory === "string" && existsSync(out.evidence.snapshotDirectory));
    assert.equal(tableCalls, 1);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-unreadable");
  }
});

test("jobobject close() resolves false if any queued root was never sent or assigned", { skip: process.platform !== "win32" }, async t => {
  const warmup = await createWindowsJob(15_000);
  await warmup?.close();

  const makeFakeRoot = pid => Object.assign(new childProcess.ChildProcess(), { pid, exitCode: null, signalCode: null });

  const runOwnerScenario = async scenario => {
    let helper;
    const receivedLines = [];
    const stub = t.mock.method(childProcess, "spawn", file => {
      assert.equal(path.basename(file), "owner.exe");
      const proc = child();
      helper = Object.assign(proc, { unref: () => {}, ref: () => {} });
      let buf = "";
      const emitDrainedAndExit = () => {
        proc.stdout.write("drained\n");
        proc.stdout.end();
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      };
      proc.stdin.on("data", chunk => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) {
          if (!line) continue;
          receivedLines.push(line);
          if (/^\d+$/.test(line)) {
            if (scenario === "queued-exited" && receivedLines.length === 1) continue;
            proc.stdout.write("opened\n");
          } else if (line === "assign" || line === "skip") {
            const reply = (scenario === "first-skipped-second-assigned" && receivedLines.filter(l => l === "assign" || l === "skip").length === 1)
              ? "skipped" : (line === "assign" ? "assigned" : "skipped");
            proc.stdout.write(reply + "\n");
          }
        }
      });
      proc.stdin.on("end", () => emitDrainedAndExit());
      queueMicrotask(() => proc.stdout.write("ready\n"));
      return Object.assign(helper, { emitOpened: () => proc.stdout.write("opened\n") });
    });
    syncBuiltinESMExports();
    try {
      const job = await createWindowsJob(15_000);
      assert.ok(job);
      if (scenario === "queued-exited") {
        const root1 = makeFakeRoot(1001), root2 = makeFakeRoot(1002);
        job.assign(root1);
        job.assign(root2);
        root2.exitCode = 0;
        helper.emitOpened();
        const confirmed = await job.close();
        assert.equal(confirmed, false, "queued root2 was never sent/assigned: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else if (scenario === "first-skipped-second-assigned") {
        const root1 = makeFakeRoot(2001), root2 = makeFakeRoot(2002);
        job.assign(root1);
        await new Promise(r => setTimeout(r, 10));
        job.assign(root2);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(job.assigned, true);
        const confirmed = await job.close();
        assert.equal(confirmed, false, "root1 was skipped even though root2 succeeded: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else if (scenario === "assign-already-dead") {
        const root1 = makeFakeRoot(3001), deadRoot2 = makeFakeRoot(3002);
        deadRoot2.exitCode = 0;
        job.assign(root1);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(job.assigned, true);
        job.assign(deadRoot2);
        const confirmed = await job.close();
        assert.equal(confirmed, false, "deadRoot2 was never assigned: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else {
        const root1 = makeFakeRoot(4001), root2 = makeFakeRoot(4002);
        job.assign(root1);
        job.assign(root2);
        const confirmed = await job.close();
        assert.equal(confirmed, true, "all queued roots assigned and drained: close() must resolve true");
        assert.equal(job.confirmed, true);
      }
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  };

  await runOwnerScenario("queued-exited");
  await runOwnerScenario("first-skipped-second-assigned");
  await runOwnerScenario("assign-already-dead");
  await runOwnerScenario("all-assigned");
});

test("sync runEdits after a partial restore keeps original failure reason (verify/budget/cancel) and notes incomplete restore", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "sync-partial-restore-msg-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);

  const breakBForPartialRestore = async () => {
    await writeFile(path.join(root, "a.txt"), "edited");
    await rm(path.join(root, "b.txt"), { recursive: true, force: true });
    await mkdir(path.join(root, "b.txt"));
    await writeFile(path.join(root, "b.txt", "nested.txt"), "blocks rmdir so restoreEntry fails");
  };

  fakeGitSpawn(t, root, "a.txt\0b.txt\0");

  for (const mode of ["verify", "budget", "cancel"]) {
    await rm(path.join(root, "b.txt"), { recursive: true, force: true });
    await writeFile(path.join(root, "a.txt"), "base-a");
    await writeFile(path.join(root, "b.txt"), "base-b");
    const controller = new AbortController();
    let now = 0;
    const verifySpec = mode === "verify"
      ? { command: process.execPath, args: ["-e", "process.exit(1)"] }
      : { none: true, reason: `Partial restore ${mode} fixture` };

    const out = await runEdits(
      { directory: root, prompt: "Edit", model: "opencode/test-free", codeMap: false, maxFixRuns: 0, verify: verifySpec },
      {
        resolveRoot: async () => root, lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
        ignoredPathsImpl: async () => [],
        signal: controller.signal,
        nowImpl: () => now,
        verifyImpl: async () => ({ passed: false, exitCode: 1, signal: null, timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }),
        runner: async () => {
          await breakBForPartialRestore();
          if (mode === "cancel") { controller.abort(); return { status: "failed", cancelled: true, error: "OpenCode run cancelled." }; }
          if (mode === "budget") { now = 400_000; return { status: "timeout", error: "OpenCode timed out." }; }
          return { text: "done", sessionID: "ses_pr" };
        },
      },
    );
    assert.equal(out.status, "failed");
    assert.equal(out.verification.restored, false);
    assert.match(out.message, /incomplete/i, `${mode}: must mention incomplete restore: ${out.message}`);
    if (mode === "verify") {
      assert.equal(out.error, "verify_failed");
      assert.match(out.message, /verif/i, `${mode}: must preserve verify reason: ${out.message}`);
    }
    if (mode === "budget") {
      assert.equal(out.error, "budget_exceeded");
      assert.match(out.message, /budget|deadline|timed out/i, `${mode}: must preserve budget/timeout reason: ${out.message}`);
    }
    if (mode === "cancel") {
      assert.equal(out.error, "cancelled");
      assert.match(out.message, /cancel/i, `${mode}: must preserve cancel reason: ${out.message}`);
    }
    assert.ok(out.evidence.restore?.failed?.some(f => f.path === "b.txt"), `${mode}: evidence.restore must list b.txt`);
  }
});

test("snapshot finishPartial adds an explicit failed entry when the deadline hits before the created-files scan ran, even with non-empty manifest", async t => {
  assert.equal(typeof RESTORE_BUDGET_MS, "number");
  const dir = await mkdtemp(path.join(os.tmpdir(), "snap-no-created-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const handle = {
    checkoutRoot: dir,
    directory: path.join(dir, "store"),
    manifest: [{ path: "a.txt", size: 4, sha256: "0".repeat(64) }],
  };
  let lsFilesStarted;
  const lsFilesRunning = new Promise(resolve => { lsFilesStarted = resolve; });
  mockSpawn(t, (_file, args) => {
    const proc = child();
    if (args.includes("--show-toplevel")) {
      queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
    } else {
      lsFilesStarted();
    }
    return proc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restoring = restoreSnapshot(handle);
  await lsFilesRunning;
  t.mock.timers.tick(RESTORE_BUDGET_MS);
  const report = await restoring;
  assert.ok(
    report.failed.some(f => f.path === "a.txt" && /not attempted/i.test(f.error)),
    `manifest file should be marked not attempted: ${JSON.stringify(report.failed)}`,
  );
  assert.ok(
    report.failed.some(f => /created-files scan did not run/i.test(f.error)),
    `must include explicit failed entry saying created-files scan did not run: ${JSON.stringify(report.failed)}`,
  );
});
