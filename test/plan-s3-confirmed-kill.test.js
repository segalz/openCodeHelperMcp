import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBoundedProcess, defaultKillProcessTree } from "../src/core.js";

// Plan S3 (review items A2 + D2): a stopped OpenCode run must not settle (which lets the edit flow restore
// the snapshot) while any process of its tree is still alive. A child that survives the first kill and
// writes a tracked file 250 ms after the deadline must be dead before runBoundedProcess resolves.

const root = await mkdtemp(path.join(os.tmpdir(), "opencode-s3-test-"));
const spawnedPids = [];
after(async () => {
  for (const pid of spawnedPids) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function assertNoWriteAfter(file, settledAt, message) {
  if (!existsSync(file)) return;
  const writtenAt = Number(readFileSync(file, "utf8"));
  assert.ok(writtenAt <= settledAt, `${message} (written ${writtenAt - settledAt} ms after)`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fakeCli(dir, writeAfterMs, rootExitsAfterMs) {
  const pidsPath = path.join(dir, "pids.json");
  const trackedPath = path.join(dir, "tracked.txt");
  const childPath = path.join(dir, "child.cjs");
  const entryPath = path.join(dir, "cli.cjs");
  await writeFile(childPath, [
    `const fs = require("node:fs");`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(trackedPath)}, String(Date.now())), ${writeAfterMs});`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));
  await writeFile(entryPath, [
    `const { spawn } = require("node:child_process");`,
    `const fs = require("node:fs");`,
    // An early-exiting root leaves its child holding the output pipes, so no `close` arrives until it dies.
    `const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: ${rootExitsAfterMs === undefined ? `"ignore"` : `["ignore", "inherit", "inherit"]`}, windowsHide: true });`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ root: process.pid, child: child.pid }));`,
    rootExitsAfterMs === undefined ? `setInterval(() => {}, 1000);` : `setTimeout(() => process.exit(0), ${rootExitsAfterMs});`,
  ].join("\n"));
  return { entryPath, pidsPath, trackedPath };
}

async function readPids(pidsPath) {
  const pids = JSON.parse(await readFile(pidsPath, "utf8"));
  spawnedPids.push(pids.root, pids.child);
  return pids;
}

test("S3: a timed-out run resolves only after the whole tree is dead, even when the first kill is ignored", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const timeoutMs = 1_500;
  const { entryPath, pidsPath, trackedPath } = await fakeCli(dir, timeoutMs + 250);
  let killCalls = 0;
  const result = await runBoundedProcess({
    executable: process.execPath, args: [entryPath], cwd: dir, env: process.env, timeoutMs,
    // A short exit grace must not be what ends the wait for a live tree.
    graceMs: 100,
    // The first kill attempt does nothing (a child that survives it); later attempts are real.
    terminate: child => { if (killCalls++ === 0) return; defaultKillProcessTree(child); },
  });
  const settledAt = Date.now();
  assert.equal(result.timedOut, true);

  const pids = await readPids(pidsPath);
  assert.equal(alive(pids.root), false, "the root process must be dead when the run resolves");
  assert.equal(alive(pids.child), false, "the child process must be dead when the run resolves");
  assert.ok(killCalls >= 2, "an ignored kill must be retried until the tree is confirmed dead");

  // The edit flow would restore now. Nothing of the old tree may write after this point.
  await sleep(timeoutMs);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run resolved");
});

test("S3: a run stopped by the caller also waits for the tree to die", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const { entryPath, pidsPath, trackedPath } = await fakeCli(dir, 1_750);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_500);
  const result = await runBoundedProcess({
    executable: process.execPath, args: [entryPath], cwd: dir, env: process.env, timeoutMs: 60_000,
    graceMs: 100, signal: controller.signal,
    terminate: child => defaultKillProcessTree(child),
  });
  const settledAt = Date.now();
  assert.equal(result.stoppedReason, "cancelled");

  const pids = await readPids(pidsPath);
  assert.equal(alive(pids.root), false, "the root process must be dead when the run resolves");
  assert.equal(alive(pids.child), false, "the child process must be dead when the run resolves");
  await sleep(1_500);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run resolved");
});

test("S3 review: a child left behind by an exited root is found and killed; the exited root's PID is never killed", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const timeoutMs = 1_500;
  const { entryPath, pidsPath, trackedPath } = await fakeCli(dir, timeoutMs + 250, 300);
  let killCalls = 0;
  const result = await runBoundedProcess({
    // A deadline that passes during the reap must not turn a run that ended by itself into a timeout
    // (whether it passes depends on how fast the process list is read; this does not force it).
    executable: process.execPath, args: [entryPath], cwd: dir, env: process.env, timeoutMs: 900, graceMs: 100,
    terminate: child => { killCalls++; defaultKillProcessTree(child); },
  });
  const settledAt = Date.now();
  assert.equal(result.exitCode, 0, "the root exited by itself; the run resolves only after its child is dead");
  assert.equal(result.timedOut, false);
  assert.equal(result.stoppedReason, undefined);

  const pids = await readPids(pidsPath);
  assert.equal(alive(pids.child), false, "the orphaned child must be dead when the run resolves");
  if (process.platform === "win32") assert.equal(killCalls, 0, "the root had exited: its PID may belong to another process now");
  await sleep(timeoutMs);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run resolved");
});
