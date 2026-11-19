import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquire, checkoutLockPath } from "../src/checkoutlock.js";

// Plan S11 (review item C1). A checkout lock whose holder PID now belongs to a process we may not inspect
// (a system process: "access denied") is not ours, so it is reclaimed at once instead of staying busy forever.
// The PID-reuse check for a process we can inspect must not block the server while it reads the start time.

async function lockFixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "opencode-s11-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), locks = path.join(base, "locks");
  await mkdir(root); await mkdir(locks);
  const holder = (pid, time) => writeFile(checkoutLockPath(root, locks), JSON.stringify({ pid, time, token: "old-holder" }));
  return { root, locks, holder };
}

/** A PID that exists but this user may not open: System on Windows, init on POSIX (when not root). */
const protectedPid = process.platform === "win32" ? 4 : 1;
const canTestProtected = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() !== 0);

test("S11: a lock held by a system PID (access denied) is reclaimed in under 50 ms", { skip: !canTestProtected }, async t => {
  const f = await lockFixture(t);
  await f.holder(protectedPid, new Date().toISOString());
  const started = performance.now();
  const release = await acquire(f.root, { lockDirectory: f.locks });
  const elapsed = performance.now() - started;
  release();
  assert.ok(elapsed < 50, `reclaiming took ${Math.round(elapsed)} ms`);
});

test("S11: a lock whose PID was reused by a newer process of ours is reclaimed without blocking the server",
  { skip: !["win32", "linux"].includes(process.platform), timeout: 60_000 }, async t => {
  const f = await lockFixture(t);
  // A live process of this user whose start is well after the lock was written: PID reuse.
  const reused = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { try { reused.kill(); } catch { /* gone */ } });
  await new Promise(resolve => reused.once("spawn", resolve));
  await f.holder(reused.pid, new Date(Date.now() - 3_600_000).toISOString());

  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 10);
  try {
    const pending = acquire(f.root, { lockDirectory: f.locks });
    assert.ok(pending instanceof Promise, "acquire must be asynchronous");
    const release = await pending;
    release();
  } finally { clearInterval(ticker); }
  // Reading a start time on Windows takes a process launch; the event loop must keep running meanwhile.
  if (process.platform === "win32") assert.ok(ticks >= 3, `the event loop ran ${ticks} times during the check`);
});

test("S11: a lock held by a live process of ours that started before the lock stays busy", { timeout: 60_000 }, async t => {
  const f = await lockFixture(t);
  await f.holder(process.ppid, new Date().toISOString());
  await assert.rejects(acquire(f.root, { lockDirectory: f.locks }), { kind: "checkout_busy" });
});
