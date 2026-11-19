import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBoundedProcess, defaultKillProcessTree } from "../src/core.js";

// Plan S3b (review item D2): every spawned CLI runs inside a Windows Job Object (kill on close, no
// breakaway), so a stopped or finished run leaves no process behind, not even an orphan whose parent died
// before the process snapshot (the gap the S3 tree kill cannot close: the orphan has no living parent that
// links it to our root). taskkill /T and the S3 confirmed tree kill stay as the fallback.

const windowsOnly = { skip: process.platform !== "win32" ? "Job Objects are Windows-only" : false, timeout: 60_000 };
const root = await mkdtemp(path.join(os.tmpdir(), "opencode-s3b-test-"));
const leftovers = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const size = file => (existsSync(file) ? readFileSync(file).length : 0);

async function growing(beat) { const before = size(beat); await sleep(150); return size(beat) > before; }

after(async () => {
  for (const { pid, beat } of leftovers) {
    if (!await growing(beat)) continue;
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** A dead process writes no more heartbeats: sizes stay the same over a few hundred ms. */
async function assertSilent(files, message) {
  assert.ok(files.every(file => size(file) > 0), `${message}: the heartbeat never started`);
  const before = files.map(size);
  await sleep(400);
  assert.deepEqual(files.map(size), before, message);
}

/**
 * root -> middle -> grandchild. The middle process exits as soon as the grandchild runs, so the grandchild's
 * parent PID points at a dead process. The grandchild is detached: Node puts its non-detached children
 * in its own kill-on-close job, so only a detached (or non-Node) child truly outlives its parent.
 * `rootExits` makes the root exit 0 once that has happened.
 */
async function orphanCli(dir, rootExits) {
  const grandPath = path.join(dir, "grand.cjs"), middlePath = path.join(dir, "middle.cjs"), entryPath = path.join(dir, "cli.cjs");
  const pidsPath = path.join(dir, "pids.json");
  const rootBeat = path.join(dir, "root.beat"), grandBeat = path.join(dir, "grand.beat");
  await writeFile(grandPath, [
    `const fs = require("node:fs");`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(grandBeat)}, "."), 25);`,
  ].join("\n"));
  await writeFile(middlePath, [
    `const { spawn } = require("node:child_process");`,
    `const fs = require("node:fs");`,
    `const grand = spawn(process.execPath, [${JSON.stringify(grandPath)}], { stdio: "ignore", windowsHide: true, detached: true });`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ grand: grand.pid }));`,
    `const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(grandBeat)})) { clearInterval(wait); grand.unref(); process.exit(0); } }, 20);`,
  ].join("\n"));
  await writeFile(entryPath, [
    `const { spawn } = require("node:child_process");`,
    `const fs = require("node:fs");`,
    `spawn(process.execPath, [${JSON.stringify(middlePath)}], { stdio: "ignore", windowsHide: true }).unref();`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(rootBeat)}, "."), 25);`,
    rootExits
      ? `const done = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidsPath)}) && fs.existsSync(${JSON.stringify(grandBeat)})) { clearInterval(done); setTimeout(() => process.exit(0), 300); } }, 20);`
      : ``,
  ].join("\n"));
  return { entryPath, pidsPath, rootBeat, grandBeat };
}

async function remember(pidsPath, grandBeat) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidsPath) && Date.now() < deadline) await sleep(50);
  const pids = JSON.parse(await readFile(pidsPath, "utf8"));
  leftovers.push({ pid: pids.grand, beat: grandBeat });
}

test("S3b: a timed-out run leaves no orphan behind, even one whose parent died long before the kill", windowsOnly, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const { entryPath, pidsPath, rootBeat, grandBeat } = await orphanCli(dir, false);
  const result = await runBoundedProcess({
    executable: process.execPath, args: [entryPath], cwd: dir, env: process.env, timeoutMs: 6_000,
    terminate: child => defaultKillProcessTree(child),
  });
  assert.equal(result.timedOut, true);
  await remember(pidsPath, grandBeat);
  await assertSilent([rootBeat, grandBeat], "the root and the orphaned grandchild must be dead when the run resolves");
});

test("S3b: a run whose CLI exits by itself leaves no orphan behind", windowsOnly, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const { entryPath, pidsPath, rootBeat, grandBeat } = await orphanCli(dir, true);
  const result = await runBoundedProcess({
    executable: process.execPath, args: [entryPath], cwd: dir, env: process.env, timeoutMs: 30_000,
    terminate: child => defaultKillProcessTree(child),
  });
  assert.equal(result.exitCode, 0);
  await remember(pidsPath, grandBeat);
  await assertSilent([rootBeat, grandBeat], "the orphaned grandchild must be dead when the run resolves");
});
