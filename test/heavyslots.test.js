import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquire, canonicalCheckoutPath, CheckoutBusyError, checkoutLockPath, deadHolderText, holderIsDead } from "../src/checkoutlock.js";
import { registerEditTools, runEdits } from "../src/edits.js";
import { acquireHeavySlot, setFailedTicketRetryIntervalMs } from "../src/heavyslots.js";
import { withProgressHeartbeat } from "../src/progress.js";

const TEST_WAIT_MS = 60_000;
const moduleUrl = new URL("../src/heavyslots.js", import.meta.url).href;
const signal = new AbortController().signal;
const noneVerify = { none: true, reason: "Heavy queue lifecycle test fixture" };
function dir() { return process.env.BRIDGE_HEAVY_DIR; }
function data(file) { return JSON.parse(readFileSync(path.join(dir(), file), "utf8")); }

async function until(check) {
  const end = Date.now() + TEST_WAIT_MS;
  while (!check()) {
    assert.ok(Date.now() < end, "condition timed out");
    await delay(15);
  }
}

async function spawnLiveChild(t) {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const exited = once(proc, "exit");
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
  });
  await once(proc, "spawn");
  return { proc, exited };
}

// Every worker uses its own bridge PID and the same machine directory. IPC gates
// admission attempts and releases, so ordering assertions need no timing guesses.
async function worker(t, crash = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const crash = process.argv[1];
    const link = fs.linkSync;
    fs.linkSync = (src, dst) => {
      if (crash && dst.endsWith("slot-1.json")) {
        if (!JSON.parse(fs.readFileSync(src)).token) process.exit(9);
        if (crash === "after") link(src, dst);
        process.exit(77);
      }
      link(src, dst);
    };
    syncBuiltinESMExports();
    const { acquireHeavySlot } = await import(${JSON.stringify(moduleUrl)});
    let lease;
    process.on("message", async cmd => {
      if (cmd === "go") {
        lease = await acquireHeavySlot(process.env.BRIDGE_HEAVY_DIR, () => ${TEST_WAIT_MS},
          new AbortController().signal, q => { if (q) process.send("queued"); });
        process.send("acquired");
      } else { lease(); process.disconnect(); }
    });
    process.send("ready");
  `, crash], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [];
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  child.on("message", msg => messages.push(msg));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const wait = (msg) => until(() => {
    assert.ok(child.exitCode === null && child.signalCode === null, errors || "worker exited");
    return messages.includes(msg);
  });
  await wait("ready");
  return { child, wait, exited, messages };
}

async function editFixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "opencode-heavy-edit-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo");
  const locks = path.join(base, "locks");
  const snapshots = path.join(base, "snapshots");
  await mkdir(root, { recursive: true });
  await mkdir(locks, { recursive: true });
  await mkdir(snapshots, { recursive: true });
  await writeFile(path.join(root, "main.js"), "baseline\n");
  const options = {
    resolveRoot: async () => root,
    lockDirectory: locks,
    snapshotOptions: { snapshotBase: snapshots },
    identityImpl: async () => ({ head: "h".repeat(40), indexHash: "i".repeat(64) }),
    ignoredPathsImpl: async () => [],
    takeSnapshotImpl: async () => {
      const snapDir = await mkdtemp(path.join(snapshots, "snap-"));
      return { directory: snapDir, manifest: [] };
    },
    restoreSnapshotImpl: async () => ({ restored: [], removed: [], failed: [] }),
    discardSnapshotImpl: async (snap) => { if (snap?.directory) await rm(snap.directory, { recursive: true, force: true }); },
    createdFilesImpl: async () => [],
  };
  const input = (extra = {}) => ({
    directory: root,
    prompt: "Fix main.js",
    model: "opencode/test-free",
    codeMap: false,
    verify: noneVerify,
    ...extra,
  });
  return { base, root, locks, snapshots, options, input };
}

test("two slots admit three waiters in FIFO order across real child processes, including a newcomer at release", async t => {
  mkdirSync(dir(), { recursive: true });
  const first = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  const second = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(first);
  t.after(second);
  const waiters = [];
  for (let i = 0; i < 3; i++) {
    const w = await worker(t);
    w.child.send("go");
    await w.wait("queued");
    waiters.push(w);
  }
  assert.equal(data("state.json").queued, 3);
  const newcomer = await worker(t);
  first();
  newcomer.child.send("go");
  waiters.push(newcomer);
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    await w.wait("acquired");
    assert.ok(waiters.slice(i + 1).every(other => !other.messages.includes("acquired")));
    const slot = data("slot-1.json");
    assert.equal(slot.pid, w.child.pid);
    assert.equal(slot.bridge, "opencode");
    w.child.send("release");
    await w.exited;
  }
  second();
  assert.deepEqual(data("state.json").active, []);
  assert.equal(data("state.json").queued, 0);
});

test("a crash either side of hard-link publication leaves a reclaimable admission lock and no partial slot", async t => {
  mkdirSync(dir(), { recursive: true });
  for (const stage of ["before", "after"]) {
    const w = await worker(t, stage);
    w.child.send("go");
    assert.equal((await w.exited)[0], 77);
    assert.ok(existsSync(path.join(dir(), "admission.lock")));
    assert.equal(existsSync(path.join(dir(), "slot-1.json")), stage === "after");
    if (stage === "after") assert.equal(data("slot-1.json").pid, w.child.pid);
    const release = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
    assert.equal(data("slot-1.json").pid, process.pid);
    release();
  }
});

test("cross-bridge: Cline slot and recorded survivor block OpenCode; stale slot/ticket reaped; OpenCode slot matches Cline rules", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const w = await worker(t);
  const time = new Date().toISOString();
  // Exact slot format written by ClineMcp/src/heavyslots.ts.
  const clineSlot = {
    pid: process.pid,
    time,
    token: "5d193092-66f9-4fa1-b62e-39cb782d25c6",
    bridge: "cline",
    kind: "edit",
    checkout: "a".repeat(64),
    started_at: time,
  };
  const file = path.join(dir(), "slot-1.json");
  writeFileSync(file, JSON.stringify(clineSlot));

  // Cancel while queued behind the Cline slot removes the ticket cleanly.
  const controller = new AbortController();
  await assert.rejects(acquireHeavySlot(dir(), () => TEST_WAIT_MS, controller.signal, q => {
    if (q) { assert.deepEqual(q, { position: 1, total: 1 }); controller.abort(); }
  }), { name: "AbortError" });
  assert.deepEqual(readdirSync(path.join(dir(), "queue")), []);

  // Live Cline-format ticket while all slots are held: OpenCode queues behind it at position 2 with stamp >= Cline ms + 1,
  // and is admitted once the Cline ticket is removed and the slot frees.
  const clineTicketMs = Date.now() + 5_000;
  const clineTicketToken = "11111111-2222-4333-8444-555555555555";
  const clineTicketName = `${clineTicketMs}-${process.pid}-${clineTicketToken}.json`;
  const clineTicketPath = path.join(dir(), "queue", clineTicketName);
  writeFileSync(clineTicketPath, JSON.stringify({
    pid: process.pid,
    time,
    token: clineTicketToken,
    bridge: "cline",
    kind: "edit",
    checkout: "a".repeat(64),
    started_at: time,
  }));
  let queuedBehindCline;
  const queuedPending = acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal, q => {
    if (q) queuedBehindCline = q;
  });
  await until(() => queuedBehindCline !== undefined);
  assert.deepEqual(queuedBehindCline, { position: 2, total: 2 });
  const queueEntries = readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json"));
  const opencodeTicketName = queueEntries.find(n => n !== clineTicketName);
  assert.ok(opencodeTicketName, `expected OpenCode ticket alongside Cline ticket: ${JSON.stringify(queueEntries)}`);
  assert.ok(parseInt(opencodeTicketName, 10) >= clineTicketMs + 1,
    `OpenCode ticket stamp ${parseInt(opencodeTicketName, 10)} must be >= ${clineTicketMs + 1}`);
  unlinkSync(clineTicketPath);
  unlinkSync(file);
  const admittedAfterCline = await queuedPending;
  assert.equal(data("slot-1.json").bridge, "opencode");
  assert.equal(data("slot-1.json").pid, process.pid);
  assert.deepEqual(readdirSync(path.join(dir(), "queue")), []);
  admittedAfterCline();
  writeFileSync(file, JSON.stringify(clineSlot));

  // Queue a worker and kill it so a stale ticket sits in queue/.
  w.child.send("go");
  await w.wait("queued");
  w.child.kill();
  await w.exited;

  // Cline bridge PID died while a recorded survivor still owns the lease: stays blocked, dead worker ticket is reaped.
  writeFileSync(file, JSON.stringify({ ...clineSlot, pid: w.child.pid, survivors: [process.pid], survivor_time: time }));
  const other = new AbortController();
  await assert.rejects(acquireHeavySlot(dir(), () => TEST_WAIT_MS, other.signal, q => {
    if (q) { assert.equal(q.total, 1, "dead worker ticket must be reaped"); other.abort(); }
  }), { name: "AbortError" });

  // Dead Cline bridge PID + reused survivor PID (start time past 5 s tolerance): OpenCode reclaims the stale slot.
  const live = await worker(t);
  writeFileSync(file, JSON.stringify({
    ...clineSlot,
    pid: w.child.pid,
    survivors: [live.child.pid],
    survivor_time: "2000-01-01T00:00:00.000Z",
  }));
  const release = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  const rawSlot = readFileSync(file, "utf8");
  const actual = JSON.parse(rawSlot);

  // Verify every Cline protocol rule on the slot file OpenCode published.
  assert.equal(actual.bridge, "opencode");
  assert.equal(actual.kind, "edit");
  assert.equal(actual.pid, process.pid);
  assert.match(actual.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(Number.isFinite(Date.parse(actual.time)));
  assert.ok(Number.isFinite(Date.parse(actual.started_at)));
  assert.equal(actual.checkout, createHash("sha256").update(canonicalCheckoutPath(dir())).digest("hex"));
  assert.equal(rawSlot.includes(dir()), false, "slot file must never leak a raw local path");
  assert.equal(await deadHolderText(rawSlot), false, "live OpenCode slot must parse as live under Cline rules");
  assert.equal(await holderIsDead({ ...actual, pid: w.child.pid }), true, "dead PID must parse as stale under Cline rules");
  assert.equal(await holderIsDead({ ...actual, pid: live.child.pid, time: "2000-01-01T00:00:00.000Z" }), true, "reused PID must parse as stale under Cline rules");

  const state = data("state.json");
  assert.equal(state.version, 1);
  assert.equal(state.slots, 1);
  assert.equal(state.queued, 0);
  assert.deepEqual(state.active, [{ bridge: "opencode", kind: "edit", started_at: actual.started_at }]);
  assert.ok(Number.isFinite(Date.parse(state.updated_at)));

  // Replacing the slot externally must not let the old token unlink it.
  writeFileSync(file, JSON.stringify(clineSlot));
  release();
  assert.deepEqual(data("slot-1.json"), clineSlot, "old token cannot release a replacement");
});

test("progress heartbeat reports queue position and returns to elapsed time after admission (unit and apply_opencode_edits)", async t => {
  const messages = [];
  await withProgressHeartbeat({
    _meta: { progressToken: 1 },
    sendNotification: async n => { messages.push(n.params.message); },
  }, async update => {
    update({ position: 2, total: 3 });
    await until(() => messages.includes("queued for a heavy-run slot: position 2 of 3"));
    update();
    await until(() => messages.some(m => m.startsWith("still running")));
  }, { intervalMs: 5 });

  // End-to-end check through registerEditTools: onQueue fires while queued and clears on admission.
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const f = await editFixture(t);
  const git = (...args) => {
    const res = spawnSync("git", ["-C", f.root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    assert.equal(res.status, 0, res.stderr || res.error?.message);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "base");
  const blocker = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
  t.after(blocker);
  const tools = new Map();
  const seenQueue = [];
  registerEditTools({ registerTool: (name, _config, handler) => tools.set(name, handler) }, {
    runner: async () => ({ text: "Changed main.js", sessionID: "ses_hb" }),
    catalog: { list: async () => ({ models: [{ id: "opencode/test-free" }] }) },
    resolveAllowedPath: async p => p,
    lifecycleOptions: {
      ...f.options,
      onQueue: q => {
        seenQueue.push(q);
        if (q) blocker();
      },
    },
  });
  const reply = await tools.get("apply_opencode_edits")(f.input(), {});
  assert.equal(reply.isError, undefined, reply.content?.[0]?.text);
  assert.equal(JSON.parse(reply.content[0].text).status, "done");
  assert.deepEqual(seenQueue[0], { position: 1, total: 1 });
  assert.equal(seenQueue.at(-1), undefined);
});

test("runEdits machine_busy leaves no snapshot, lock, or ticket; preflight errors keep their kinds; cancel cleans up queued and running", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const f = await editFixture(t);
  const blocker = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
  t.after(blocker);

  let queued = false;
  let launches = 0;
  let snapshotsTaken = 0;
  const opts = {
    ...f.options,
    onQueue: q => { if (q) queued = true; },
    takeSnapshotImpl: async (...args) => { snapshotsTaken++; return f.options.takeSnapshotImpl(...args); },
    runner: async () => { launches++; return { text: "done", sessionID: "ses_q" }; },
  };

  // Budget below the 60 s first-run floor (including verify:none) fails before queueing.
  const shortBudget = await runEdits(f.input({ budgetMs: 30_000 }), opts);
  assert.equal(shortBudget.error, "budget_exceeded");
  assert.equal(queued, false);

  // Missing verifier fails before queueing.
  const badVerify = await runEdits(f.input({ verify: { command: "nonexistent-f10-verifier-opencode" } }), opts);
  assert.match(String(badVerify.error), /^verification_(launch_failed|refused)$/);
  assert.equal(queued, false);

  // Queue give-up returns machine_busy with no model run, no snapshot, no checkout lock, and no lingering ticket.
  const busy = await runEdits(f.input({ budgetMs: 62_000 }), opts);
  assert.equal(busy.status, "failed");
  assert.equal(busy.error, "machine_busy");
  assert.match(busy.message, /Heavy-run slots busy: 1 active, 1 queued\. Retry later or send the edit elsewhere\./);
  assert.equal(queued, true);
  assert.equal(launches, 0);
  assert.equal(snapshotsTaken, 0);
  assert.deepEqual(await readdir(f.snapshots), []);
  assert.deepEqual(await readdir(path.join(dir(), "queue")), []);
  const lockAfterBusy = await acquire(f.root, { lockDirectory: f.locks });
  lockAfterBusy();

  // Cancelling a queued runEdits removes its ticket and takes no snapshot or checkout lock.
  const cancelQueued = new AbortController();
  const cancelledQueueOut = await runEdits(f.input(), {
    ...opts,
    signal: cancelQueued.signal,
    onQueue: q => { if (q) cancelQueued.abort(); },
  });
  assert.equal(cancelledQueueOut.error, "cancelled");
  assert.equal(launches, 0);
  assert.equal(snapshotsTaken, 0);
  assert.deepEqual(await readdir(path.join(dir(), "queue")), []);
  const lockAfterCancelQueue = await acquire(f.root, { lockDirectory: f.locks });
  lockAfterCancelQueue();

  // CheckoutBusyError after acquiring a heavy slot releases the heavy slot cleanly.
  blocker();
  const heldLock = await acquire(f.root, { lockDirectory: f.locks });
  const busyCheckout = await runEdits(f.input(), opts);
  assert.equal(busyCheckout.error, "checkout_busy");
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false, "slot must be released when checkout lock fails");
  heldLock();

  // Cancelling a running runEdits frees both checkout lock and heavy slot.
  const cancelRunning = new AbortController();
  const cancelledRunOut = await runEdits(f.input(), {
    ...f.options,
    signal: cancelRunning.signal,
    runner: async ({ signal: runSignal }) => {
      assert.equal(existsSync(path.join(dir(), "slot-1.json")), true);
      cancelRunning.abort();
      assert.equal(runSignal.aborted, true);
      return { status: "failed", error: "OpenCode run cancelled." };
    },
  });
  assert.equal(cancelledRunOut.error, "cancelled");
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false, "running cancel must free heavy slot");
  const lockAfterCancelRun = await acquire(f.root, { lockDirectory: f.locks });
  lockAfterCancelRun();
});

test("60 s floor applies only to the first run; repair runs keep MIN_FIX_RUN_MS (30 s)", async t => {
  const f = await editFixture(t);
  let now = 1_000;
  let calls = 0;
  // 165 s budget, 60 s verify (+10 s margin = 70 s reserve): 95 s left for run 0 (>= 60 s).
  // After run 0 uses 55 s, 40 s remains for repair run 1 (< 60 s, >= 30 s MIN_FIX_RUN_MS): must still run!
  const out = await runEdits(
    f.input({ budgetMs: 165_000, maxFixRuns: 1, verify: { command: process.execPath, args: ["-e", "0"], timeoutSeconds: 60 } }),
    {
      ...f.options,
      nowImpl: () => now,
      verifyImpl: async () => ({
        passed: calls >= 2, exitCode: calls >= 2 ? 0 : 1, signal: null,
        timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "",
      }),
      runner: async () => {
        calls++;
        if (calls === 1) now += 55_000;
        return { text: "Changed main.js", sessionID: "ses_fix" };
      },
    },
  );
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(calls, 2, "repair run with 40 s left must not be blocked by MIN_FIRST_RUN_MS");
  assert.equal(out.verification.fixRuns, 1);
});

test("unconfirmed kill: killUnverified frees the slot with a note while keeping the checkout lock permanently retained", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  for (const mode of ["failed-run", "passed-server-stop"]) {
    const f = await editFixture(t);
    const out = await runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 15,
      runner: async ({ editScope }) => {
        if (mode === "passed-server-stop") {
          editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [], killUnverified: true }) };
          return { text: "Changed main.js", sessionID: "ses_kv" };
        }
        return { status: "failed", error: "timed out", killConfirmed: false, stillAlive: [], killUnverified: true };
      },
    });
    if (mode === "passed-server-stop") {
      assert.equal(out.status, "done");
      assert.equal(out.error, undefined);
    } else {
      assert.equal(out.status, "failed");
    }
    assert.equal(out.evidence.killUnverified, true);
    assert.ok(out.evidence.cleanupNotes?.some(n => /released.*slot.*checkout lock/i.test(n)), JSON.stringify(out.evidence));
    assert.ok(out.warnings?.some(w => /released.*slot.*checkout lock/i.test(w)), JSON.stringify(out.warnings));

    // Heavy slot is freed immediately.
    assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();

    // Checkout lock stays retained with kill_unverified: true and never auto-heals.
    const lockHolder = JSON.parse(await readFile(checkoutLockPath(f.root, f.locks), "utf8"));
    assert.equal(lockHolder.pid, process.pid);
    assert.equal(lockHolder.kill_unverified, true);
    await delay(50);
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);
  }
});

test("unconfirmed kill: killConfirmed=false with missing or empty survivors and no killUnverified is treated as killUnverified", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  for (const outcome of [
    { status: "failed", error: "timed out", killConfirmed: false },
    { status: "failed", error: "timed out", killConfirmed: false, stillAlive: [] },
  ]) {
    const f = await editFixture(t);
    const out = await runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 15,
      runner: async () => outcome,
    });
    assert.equal(out.status, "failed");
    assert.deepEqual(out.evidence.processesStillAlive, []);
    assert.equal(out.evidence.killUnverified, true);
    assert.ok(out.evidence.cleanupNotes?.some(n => /released.*slot.*checkout lock/i.test(n)), JSON.stringify(out.evidence));
    assert.ok(out.warnings?.some(w => /released.*slot.*checkout lock/i.test(w)), JSON.stringify(out.warnings));

    // Heavy slot is freed immediately (never held for the bridge's lifetime).
    assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();

    // Checkout lock stays retained with kill_unverified: true.
    const lockHolder = JSON.parse(await readFile(checkoutLockPath(f.root, f.locks), "utf8"));
    assert.equal(lockHolder.pid, process.pid);
    assert.deepEqual(lockHolder.survivors, []);
    assert.equal(lockHolder.kill_unverified, true);
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);
  }
});

test("unconfirmed kill: survivors-only leases stay held while alive and heal via injected interval (exit and PID reuse)", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";

  // 1. Real survivor child exits -> injected interval frees BOTH checkout lock and heavy slot.
  {
    const f = await editFixture(t);
    const { proc, exited } = await spawnLiveChild(t);
    const out = await runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 20,
      runner: async () => ({ status: "failed", error: "timed out", killConfirmed: false, stillAlive: [proc.pid] }),
    });
    assert.equal(out.status, "failed");
    assert.deepEqual(out.evidence.processesStillAlive, [proc.pid]);

    // Both leases are retained on disk while survivor lives.
    const lockHolder = JSON.parse(await readFile(checkoutLockPath(f.root, f.locks), "utf8"));
    const slotHolder = data("slot-1.json");
    assert.deepEqual(lockHolder.survivors, [proc.pid]);
    assert.deepEqual(slotHolder.survivors, [proc.pid]);
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);
    await assert.rejects(acquireHeavySlot(f.root, () => 0, signal), { kind: "machine_busy" });

    // Once survivor exits, the injected interval force-releases BOTH leases automatically.
    proc.kill();
    await exited;
    await until(() => !existsSync(path.join(dir(), "slot-1.json")) && !existsSync(checkoutLockPath(f.root, f.locks)));
    const lock = await acquire(f.root, { lockDirectory: f.locks });
    lock();
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();
  }

  // 2. PID reuse (start time past 5 s tolerance) heals via injected interval and stops polling once freed.
  {
    const f = await editFixture(t);
    let reused = false;
    let checks = 0;
    await runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 15,
      processStartMs: async () => {
        checks++;
        return reused ? Date.now() + 60_000 : Date.now() - 60_000;
      },
      runner: async () => ({ status: "failed", error: "timed out", killConfirmed: false, stillAlive: [process.ppid] }),
    });
    await until(() => checks >= 2);
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);
    await assert.rejects(acquireHeavySlot(f.root, () => 0, signal), { kind: "machine_busy" });

    reused = true;
    await until(() => !existsSync(path.join(dir(), "slot-1.json")) && !existsSync(checkoutLockPath(f.root, f.locks)));
    const lock = await acquire(f.root, { lockDirectory: f.locks });
    lock();
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();

    const settledChecks = checks;
    await delay(60);
    assert.equal(checks, settledChecks, "interval must stop once leases are force-released");
  }
});

test("survivor timer frees only the slot before disposal, and generation guard ignores a stale in-flight re-check", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";

  // 1. Pre-disposal: survivor dies while editScope.close() is still pending -> slot frees, checkout lock stays held until disposal.
  {
    const f = await editFixture(t);
    const { proc, exited } = await spawnLiveChild(t);
    let releaseClose;
    const closeGate = new Promise(resolve => { releaseClose = resolve; });
    let closeEntered;
    const enteredClose = new Promise(resolve => { closeEntered = resolve; });

    const pending = runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 15,
      runner: async ({ editScope }) => {
        editScope.server = {
          stop: async () => {
            closeEntered();
            await closeGate;
            return { killConfirmed: true };
          },
        };
        return { status: "failed", error: "timed out", killConfirmed: false, stillAlive: [proc.pid] };
      },
    });
    await enteredClose;
    // Kill survivor while runEdits has not reached its finally/disposal point yet.
    proc.kill();
    await exited;
    await until(() => !existsSync(path.join(dir(), "slot-1.json")));
    // Heavy slot is freed immediately, but the checkout lock must stay held until disposal!
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);

    releaseClose();
    await pending;
    // At disposal, checkout lock is freed immediately without waiting for another tick.
    const lock = await acquire(f.root, { lockDirectory: f.locks });
    lock();
  }

  // 2. Generation guard: a newer unconfirmed kill from editScope.close() supersedes an in-flight stale check.
  {
    const f = await editFixture(t);
    const { proc: liveChild, exited } = await spawnLiveChild(t);
    let firstCheckStarted;
    const startedFirstCheck = new Promise(resolve => { firstCheckStarted = resolve; });
    let releaseFirstCheck;
    const firstCheckGate = new Promise(resolve => { releaseFirstCheck = resolve; });
    let paused = false;
    let postGenChecks = 0;
    let closeReleased;
    const closeGate = new Promise(resolve => { closeReleased = resolve; });

    const pending = runEdits(f.input(), {
      ...f.options,
      survivorCheckIntervalMs: 15,
      processStartMs: async pid => {
        if (pid === process.ppid) {
          if (!paused) {
            paused = true;
            firstCheckStarted();
            await firstCheckGate;
          }
          // Old survivor looks reused (dead).
          return Date.now() + 60_000;
        }
        postGenChecks++;
        return Date.now() - 60_000;
      },
      runner: async ({ editScope }) => {
        editScope.server = {
          stop: async () => {
            await closeGate;
            return { killConfirmed: false, stillAlive: [liveChild.pid] };
          },
        };
        return { status: "failed", error: "timed out", killConfirmed: false, stillAlive: [process.ppid] };
      },
    });
    t.after(() => { releaseFirstCheck?.(); closeReleased?.(); });

    // Wait for generation-1 timer check to be in-flight over [process.ppid].
    await startedFirstCheck;
    // Now editScope.close() adds liveChild.pid (generation 2), then runEdits finishes and keeps leases.
    closeReleased();
    await pending;
    // Let the stale generation-1 check resolve "all dead".
    releaseFirstCheck();

    await until(() => postGenChecks >= 2);
    await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), CheckoutBusyError);
    await assert.rejects(acquireHeavySlot(f.root, () => 0, signal), { kind: "machine_busy" });

    // Once liveChild exits, both leases heal cleanly.
    liveChild.kill();
    await exited;
    await until(() => !existsSync(path.join(dir(), "slot-1.json")) && !existsSync(checkoutLockPath(f.root, f.locks)));
    const lock = await acquire(f.root, { lockDirectory: f.locks });
    lock();
    const slot = await acquireHeavySlot(f.root, () => TEST_WAIT_MS, signal);
    slot();
  }
});

test("best-effort retain and release failures record leaseErrors/warnings and never fail a passed edit", async t => {
  // 1. retain failure during an unconfirmed server stop after a passing edit keeps status done.
  {
    const f = await editFixture(t);
    const realRename = fs.renameSync;
    const stub = t.mock.method(fs, "renameSync", (src, dst) => {
      if (String(dst).endsWith(".lock") || String(dst).endsWith("slot-1.json")) {
        throw Object.assign(new Error("injected retain EPERM"), { code: "EPERM" });
      }
      return realRename(src, dst);
    });
    syncBuiltinESMExports();
    t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

    const out = await runEdits(f.input(), {
      ...f.options,
      runner: async ({ editScope }) => {
        editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [], killUnverified: true }) };
        return { text: "Changed main.js", sessionID: "ses_ret" };
      },
    });
    assert.equal(out.status, "done");
    assert.equal(out.error, undefined);
    assert.ok(out.evidence.leaseErrors?.some(e => e.includes("injected retain EPERM")), JSON.stringify(out.evidence));
    assert.ok(out.warnings?.some(w => w.includes("injected retain EPERM")), JSON.stringify(out.warnings));
    stub.mock.restore();
    syncBuiltinESMExports();
  }

  // 2. release failure on a passing edit keeps status done and surfaces in leaseErrors/warnings.
  {
    const f = await editFixture(t);
    const realUnlink = fs.unlinkSync;
    const stub = t.mock.method(fs, "unlinkSync", target => {
      if (String(target).endsWith(".lock")) {
        throw Object.assign(new Error("injected release EPERM"), { code: "EPERM" });
      }
      return realUnlink(target);
    });
    syncBuiltinESMExports();
    t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

    const out = await runEdits(f.input(), {
      ...f.options,
      runner: async () => ({ text: "Changed main.js", sessionID: "ses_rel" }),
    });
    assert.equal(out.status, "done");
    assert.equal(out.error, undefined);
    assert.ok(out.evidence.leaseErrors?.some(e => e.includes("injected release EPERM")), JSON.stringify(out.evidence));
    assert.ok(out.warnings?.some(w => w.includes("injected release EPERM")), JSON.stringify(out.warnings));
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

test(".tmp unlink failure after link leaves no orphan; ticket and slot release retry once and stay best-effort", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let ticketAttempts = 0;
  let slotAttempts = 0;
  let failSlotAlways = false;
  const stub = t.mock.method(fs, "unlinkSync", target => {
    const file = String(target);
    if (file.endsWith(".tmp")) {
      throw Object.assign(new Error("injected tmp unlink EBUSY"), { code: "EBUSY" });
    }
    if (file.includes(`${path.sep}queue${path.sep}`) && ++ticketAttempts === 1) {
      throw Object.assign(new Error("injected transient ticket unlink EBUSY"), { code: "EBUSY" });
    }
    if (file.endsWith("slot-1.json")) {
      slotAttempts++;
      if (failSlotAlways || slotAttempts === 1) {
        throw Object.assign(new Error("injected slot unlink EBUSY"), { code: "EBUSY" });
      }
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  const injectedQueueError = new Error("injected onQueue failure");
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal, q => {
      if (q) throw injectedQueueError;
    }),
    err => err === injectedQueueError,
  );
  assert.equal(ticketAttempts, 2, "ticket release must retry once after transient EBUSY");
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), [], "no orphan ticket left behind");

  assert.equal(holder(), true);
  assert.equal(slotAttempts, 2, "slot release must retry once after transient EBUSY");
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);

  const next = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  failSlotAlways = true;
  slotAttempts = 0;
  assert.equal(next(), false);
  assert.equal(slotAttempts, 2, "persistent slot release failure must try at most twice");
  assert.match(next.lastError ?? "", /injected slot unlink EBUSY/);

  stub.mock.restore();
  syncBuiltinESMExports();
  assert.equal(next(), true);
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);
});

test("failed ticket unlink is retried under admission lock and never blocks later waiters", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let blockFailedTicket = true;
  let stuckTicketName = "";
  const stub = t.mock.method(fs, "unlinkSync", target => {
    const file = String(target);
    if (blockFailedTicket && file.includes(`${path.sep}queue${path.sep}`) && file.endsWith(".json") && (!stuckTicketName || file.endsWith(stuckTicketName))) {
      stuckTicketName = path.basename(file);
      throw Object.assign(new Error("injected persistent ticket EBUSY"), { code: "EBUSY" });
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  const abort1 = new AbortController();
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, abort1.signal, q => { if (q) abort1.abort(); }),
    { name: "AbortError" },
  );
  assert.ok(stuckTicketName && existsSync(path.join(dir(), "queue", stuckTicketName)));

  holder();
  const second = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => second());
  assert.equal(data("slot-1.json").pid, process.pid);
  second();

  blockFailedTicket = false;
  const third = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  third();
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), []);

  // Failure during slot-acquisition ticket removal also stays tracked and cleans up next time.
  const blocker = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => blocker());
  stuckTicketName = "";
  blockFailedTicket = true;
  const acquiredAfterQueue = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal, q => { if (q) blocker(); });
  assert.ok(stuckTicketName && existsSync(path.join(dir(), "queue", stuckTicketName)));
  acquiredAfterQueue();

  const fourth = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  fourth();
  blockFailedTicket = false;
  const fifth = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  fifth();
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), []);
});

test("failed-ticket background retry unlinks without further polling, unblocks another process, and stops when empty", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  setFailedTicketRetryIntervalMs(20);
  t.after(() => setFailedTicketRetryIntervalMs());

  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let failTicket = true;
  let stuckTicketName = "";
  let ticketUnlinkCalls = 0;
  const stub = t.mock.method(fs, "unlinkSync", target => {
    const file = String(target);
    if (file.includes(`${path.sep}queue${path.sep}`) && file.endsWith(".json") && (!stuckTicketName || file.endsWith(stuckTicketName))) {
      stuckTicketName = path.basename(file);
      ticketUnlinkCalls++;
      if (failTicket) throw Object.assign(new Error("injected ticket EBUSY"), { code: "EBUSY" });
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  const abort1 = new AbortController();
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, abort1.signal, q => { if (q) abort1.abort(); }),
    { name: "AbortError" },
  );
  const ticketPath = path.join(dir(), "queue", stuckTicketName);
  assert.ok(stuckTicketName && existsSync(ticketPath));

  const other = await worker(t);
  other.child.send("go");
  await other.wait("queued");
  holder();

  const callsBefore = ticketUnlinkCalls;
  await until(() => ticketUnlinkCalls >= callsBefore + 2);
  assert.ok(existsSync(ticketPath), "ticket stays on disk while unlink still fails");

  failTicket = false;
  await until(() => !existsSync(ticketPath));
  await other.wait("acquired");
  other.child.send("release");
  await other.exited;

  const callsAfterCleared = ticketUnlinkCalls;
  await delay(80);
  assert.equal(ticketUnlinkCalls, callsAfterCleared, "background retry interval must stop once failed-ticket set is empty");
});

test("stale reaper frees an own-pid retained checkout lock and heavy slot once all survivors exit", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const repo = path.join(dir(), "repo");
  const locks = path.join(dir(), "locks");
  mkdirSync(repo, { recursive: true });
  mkdirSync(locks, { recursive: true });

  const { proc: survivor, exited } = await spawnLiveChild(t);
  const slot = await acquireHeavySlot(repo, () => TEST_WAIT_MS, signal);
  const lock = await acquire(repo, { lockDirectory: locks });
  assert.equal(slot.retain([survivor.pid]), true);
  assert.equal(lock.retain([survivor.pid]), true);
  slot();
  lock();

  await assert.rejects(acquire(repo, { lockDirectory: locks }), CheckoutBusyError);
  await assert.rejects(acquireHeavySlot(repo, () => 0, signal), { kind: "machine_busy" });

  survivor.kill();
  await exited;

  // Another process still refuses to reap a lease whose owner PID is alive, while the owning bridge reaps both.
  const foreign = await worker(t);
  foreign.child.send("go");
  await foreign.wait("queued");
  foreign.child.kill();
  await foreign.exited;

  const reclaimedLock = await acquire(repo, { lockDirectory: locks });
  reclaimedLock();
  const reclaimedSlot = await acquireHeavySlot(repo, () => TEST_WAIT_MS, signal);
  assert.equal(data("slot-1.json").pid, process.pid);
  reclaimedSlot();
});

test("staleCandidates caches foreign process start-time lookups by (pid, time) for one wait",
  { skip: process.platform !== "win32" }, async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const time = new Date().toISOString();
  writeFileSync(path.join(dir(), "slot-1.json"), JSON.stringify({
    bridge: "cline", kind: "edit", checkout: "b".repeat(64),
    started_at: time, pid: process.ppid, time, token: "cache-test-token",
  }));

  let execCalls = 0;
  const stub = t.mock.method(childProcess, "execFile", (...args) => {
    execCalls++;
    const cb = args.find(arg => typeof arg === "function");
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    queueMicrotask(() => cb?.(null, earlier + "\n"));
    return Object.assign(new EventEmitter(), { kill: () => true });
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  const start = Date.now();
  await assert.rejects(
    acquireHeavySlot(dir(), () => 2_300 - (Date.now() - start), signal),
    { kind: "machine_busy" },
  );
  assert.equal(execCalls, 1, "start-time query should run once per (pid, time) across multiple 1 s polls");
});
