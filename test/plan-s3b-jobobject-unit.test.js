import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createWindowsJob } from "../src/jobobject.js";
import { runVerification } from "../src/verify.js";

// 60 s like ClineMcp: with TEMP blocked, background process-table reads (PowerShell) wait out their
// PROCESS_TABLE_TIMEOUT_MS before the host process can exit, although the verification result is ready in ~1 s.
const windows = { skip: process.platform !== "win32", timeout: 60_000 };
const runNode = promisify(execFile);

async function until(predicate) {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the child");
    await sleep(15);
  }
}

test("aborted preparation and exhausted budgets fall back before starting an owner", async () => {
  assert.equal(await createWindowsJob(0), undefined);
  assert.equal(await createWindowsJob(10_000, AbortSignal.abort()), undefined);
});

test("an unavailable helper cache preserves the verification result", windows, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, "file");
  await writeFile(blocked, "");
  const moduleUrl = new URL("../src/verify.js", import.meta.url).href;
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runVerification } from ${JSON.stringify(moduleUrl)};
    process.env.TEMP = process.env.TMP = ${JSON.stringify(blocked)};
    const result = await runVerification({ command: process.execPath, args: ["-p", "42"] }, process.cwd());
    if (!result.passed || result.stdoutTail.trim() !== "42") process.exitCode = 1;
  `], { cwd: dir, stdio: "ignore" });
  t.after(() => { host.kill(); });
  const [code] = await once(host, "exit");
  assert.equal(code, 0);
});

test("a failed build can be retried once after cooldown and a fast owner failure keeps its spare", windows, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "blocked"), "");
  const moduleUrl = new URL("../src/jobobject.js", import.meta.url).href;
  await runNode(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    import { PassThrough } from "node:stream";
    import { createWindowsJob } from ${JSON.stringify(moduleUrl)};

    let now = 1_000_000;
    Date.now = () => now;
    const timers = new Map();
    let nextId = 1;
    globalThis.setTimeout = (fn, ms = 0, ...args) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn: () => fn(...args) });
      return { id, unref() { return this; } };
    };
    globalThis.clearTimeout = (handle) => { if (handle?.id) timers.delete(handle.id); };
    const tick = (ms) => {
      const target = now + ms;
      while (true) {
        let next;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.at)) next = { id, ...t };
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    };
    function fakeChild(start) {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      let exited = false;
      const exit = (code = 0) => {
        if (exited) return;
        exited = true;
        child.stdout.end();
        child.emit("exit", code, null);
      };
      child.kill = () => { exit(1); return true; };
      child.unref = () => child;
      start(child, exit);
      return child;
    }

    const realSpawn = childProcess.spawn;
    let builds = 0, owners = 0, onFirstOwnerFailed;
    const firstOwnerFailed = new Promise(resolve => { onFirstOwnerFailed = resolve; });
    childProcess.spawn = (file, args, options) => {
      if (path.basename(file) === "csc.exe") {
        builds++;
        const out = args.find(arg => arg.startsWith("/out:")).slice(5);
        return fakeChild((_child, exit) => {
          queueMicrotask(() => { writeFileSync(out, ""); exit(0); });
        });
      }
      if (path.basename(file) === "owner.exe") {
        const n = ++owners;
        return fakeChild((child, exit) => {
          if (n === 1) {
            queueMicrotask(() => { exit(1); queueMicrotask(onFirstOwnerFailed); });
          } else {
            child.stdin.on("finish", () => exit(0));
            queueMicrotask(() => child.stdout.write("ready\\n"));
          }
        });
      }
      return realSpawn(file, args, options);
    };
    syncBuiltinESMExports();
    process.env.TEMP = process.env.TMP = path.join(process.cwd(), "blocked");
    assert.equal(await createWindowsJob(15000), undefined);

    process.env.TEMP = process.env.TMP = process.cwd();
    tick(1000);
    assert.equal(await createWindowsJob(15000), undefined);
    assert.equal(builds, 0);
    tick(60_000);
    const pending = Promise.all([createWindowsJob(15000), createWindowsJob(15000)]);
    await firstOwnerFailed;
    tick(175);
    const jobs = await pending;
    try {
      assert.ok(jobs.every(job => job?.alive));
      assert.equal(builds, 1, "concurrent requests share the build");
      assert.ok(owners >= 3, "both requests still acquire an owner after the first exits");
    } finally { await Promise.all(jobs.map(job => job?.close())); }
  `], { cwd: dir, timeout: 20_000, windowsHide: true });
});

test("closing a job twice kills queued children, ignores fabricated PIDs, and clears its state", windows, async t => {
  const job = await createWindowsJob(15_000);
  assert.ok(job);
  const start = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  const member = start(), queued = start(), outsider = start();
  t.after(async () => { member.kill(); queued.kill(); outsider.kill(); await job.close(); });
  assert.equal(job.alive, true);
  job.assign({ pid: outsider.pid });
  assert.equal(job.assigned, false);
  job.assign(member);
  job.assign(queued);
  await until(() => job.assigned);
  await Promise.all([job.close(), job.close()]);
  await until(() => [member, queued].every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal(job.alive, false);
  assert.equal(job.assigned, false);
  assert.equal(outsider.exitCode, null);
  assert.equal(outsider.signalCode, null);
});

const beatSize = (dir) => readFile(path.join(dir, "beat")).then(bytes => bytes.length, () => 0);
// Removing the directory also stops the fixture if an assertion fails, independently of its PID.
const ticker = `const fs = require("node:fs");
  const dir = process.argv[1];
  setInterval(() => { if (!fs.existsSync(dir)) process.exit(0); fs.appendFileSync(dir + "/beat", "."); }, 20);
  setTimeout(() => process.exit(0), 20000);`;

test("verification reaps inherited pipes after root exit and rejects unconfirmed cleanup", windows, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "verify-pipes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "blocked"), "");
  const moduleUrl = new URL("../src/verify.js", import.meta.url).href;
  const rootScript = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(ticker)}, process.cwd()],
      { cwd: require("node:path").dirname(process.cwd()), detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();
  `;
  await runNode(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    import { runVerification } from ${JSON.stringify(moduleUrl)};

    // Disable assignment and simulate a Windows process table that cannot be read.
    process.env.TEMP = process.env.TMP = path.join(process.cwd(), "blocked");
    const realSpawn = childProcess.spawn;
    let scans = 0;
    childProcess.spawn = (file, args, options) => {
      if (file === "powershell.exe") {
        scans++;
        return realSpawn(process.execPath, ["-e", "process.exit(1)"], options);
      }
      return realSpawn(file, args, options);
    };
    syncBuiltinESMExports();
    const spec = { command: process.execPath, args: ["-e", ${JSON.stringify(rootScript)}], timeoutSeconds: 25 };
    const result = await runVerification(spec, process.cwd());
    assert.ok(scans > 0, "run S3 confirmation while the detached child still holds the pipe");
    assert.ok(result.durationMs < 15000);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.killConfirmed, false);
    assert.equal(result.killUnverified, true);
    assert.equal(result.passed, false);
  `], { cwd: dir, timeout: 25_000, windowsHide: true });
});

test("an unreferenced owner lets its host exit and kills an assigned detached process on host death", windows, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/jobobject.js", import.meta.url).href;
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createWindowsJob } from ${JSON.stringify(moduleUrl)};
    import { spawn } from "node:child_process";
    import { existsSync } from "node:fs";
    import { setTimeout as sleep } from "node:timers/promises";
    const job = await createWindowsJob(15000);
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(ticker)}, process.argv[1]], { detached: true, stdio: "ignore" });
    job.assign(child); child.unref();
    const deadline = Date.now() + 5000;
    while (!job.assigned || !existsSync(process.argv[1] + "/beat")) {
      if (Date.now() >= deadline) process.exit(2);
      await sleep(15);
    }
    // No explicit shutdown: Node must be able to exit with an open job.
  `, dir], { stdio: "ignore" });
  t.after(() => { host.kill(); });
  const [code] = await once(host, "exit");
  assert.equal(code, 0);
  const size = await beatSize(dir);
  assert.ok(size > 0);
  await sleep(250);
  assert.equal(await beatSize(dir), size);
});

for (const cancel of [false, true]) {
  test(`verification reaps a detached writer on ${cancel ? "cancellation" : "successful exit"}`, windows, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "job-verify-"));
    const controller = new AbortController();
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      spawn(process.execPath, ["-e", ${JSON.stringify(ticker)}, process.cwd()], { detached: true, stdio: "ignore" }).unref();
      setInterval(() => { if (${!cancel} && fs.existsSync("beat")) process.exit(0); }, 15);
    `;
    const result = runVerification({ command: process.execPath, args: ["-e", script], timeoutSeconds: 20 }, dir, controller.signal);
    t.after(async () => {
      controller.abort();
      await result.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });
    if (cancel) {
      await until(async () => (await beatSize(dir)) > 0);
      controller.abort();
    }
    const evidence = await result;
    assert.equal(evidence.passed, !cancel);
    assert.equal(evidence.timedOut, false);
    assert.equal(evidence.exitCode, cancel ? null : 0);
    assert.equal(evidence.signal, cancel ? "SIGKILL" : null);
    const size = await beatSize(dir);
    assert.ok(size > 0);
    await sleep(250);
    assert.equal(await beatSize(dir), size);
  });
}
