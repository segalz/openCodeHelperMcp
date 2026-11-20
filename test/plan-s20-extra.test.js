import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { runEdits } from "../src/edits.js";
import { redactSecrets } from "../src/safety.js";
import { restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { runVerification } from "../src/verify.js";

const base = await mkdtemp(path.join(os.tmpdir(), "oc-s20x-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));

function mockBuiltin(t, module, name, fn) {
  const mock = t.mock.method(module, name, fn);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

const editInput = { directory: base, prompt: "Fix the fixture", model: "opencode/test-free",
  codeMap: false, verify: { command: process.execPath }, maxFixRuns: 2 };
const editOptions = { resolveRoot: async () => base, lockDirectory: path.join(base, "locks"),
  identityImpl: async () => ({ head: "same", indexHash: "same" }), ignoredPathsImpl: async () => [] };

test("S20 (1): prefixed and escaped quoted secrets are redacted through their closing quote", () => {
  for (const value of [`b'x'`, 'f"string"', String.raw`br"a\"b c"`, String.raw`rb'a\'b c'`]) {
    const redacted = redactSecrets(`password: ${value}, next`);
    assert.match(redacted, /\[REDACTED\]/);
    assert.doesNotMatch(redacted, /['"](?:x|string|a)|b c/);
    assert.ok(redacted.endsWith(", next"));
  }
});

test("S20 (2): a child error during a verification stop retains the snapshot and prevents repair", async () => {
  const child = Object.assign(new ChildProcess(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
  let timeout, runs = 0, discarded = false;
  const out = await runEdits(editInput, {
    ...editOptions,
    takeSnapshotImpl: async () => ({ directory: "recovery" }),
    restoreSnapshotImpl: async () => ({ failed: [] }),
    discardSnapshotImpl: async () => { discarded = true; },
    runner: async () => { runs++; return { text: "Changed fixture", sessionID: "ses_s20" }; },
    verifyImpl: (spec, cwd, signal) => runVerification(spec, cwd, signal, {
      spawnImpl: () => { queueMicrotask(() => timeout()); return child; },
      setTimeoutImpl: fn => { timeout ??= fn; },
      clearTimeoutImpl: () => {},
      killImpl: () => {
        child.emit("error", new Error("kill failed"));
        child.emit("close", null, null);
      },
      confirmTreeDead: async () => {
        await new Promise(resolve => setImmediate(resolve));
        return { confirmed: false, alive: [4243], unverified: true };
      },
    }),
  });
  const [attempt] = out.verification.attempts;
  assert.equal(attempt.killConfirmed, false);
  assert.equal(attempt.killUnverified, true);
  assert.equal(attempt.timedOut, true);
  assert.equal(out.verification.passed, false);
  assert.deepEqual(out.evidence.processesStillAlive, [4243]);
  assert.equal(out.evidence.snapshotDirectory, "recovery");
  assert.equal(discarded, false);
  assert.equal(runs, 1);
  assert.equal(out.verification.fixRuns, 0);
});

test("S20 (6): oversized placeholders use size-only recovery and a running hash honours cancellation", async t => {
  const root = path.join(base, "placeholder"), file = path.join(root, "link");
  await mkdir(root);
  await writeFile(file, "");
  const cap = 64 * 1024 * 1024;
  await truncate(file, cap + 1);
  // The index describes a tracked symlink even on hosts that only support its regular-file placeholder.
  mockBuiltin(t, childProcess, "spawn", (command, [, cwd, ...args]) => {
    assert.match(command, /^git(?:\.exe)?$/);
    assert.equal(cwd, root);
    let reply = "";
    if (args.includes("--show-toplevel")) reply = root;
    else if (args.includes("--git-path")) reply = "info/exclude";
    else if (args.includes("--stage")) reply = "120000 sha 0\tlink\0";
    else if (args.includes("--cached")) reply = "link\0";
    else assert.ok(args.includes("--ignored"));
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    queueMicrotask(() => { child.stdout.end(reply); child.emit("close", 0); });
    return child;
  });

  let reads = 0;
  const controller = new AbortController();
  const createStream = fs.createReadStream;
  mockBuiltin(t, fs, "createReadStream", (...args) => {
    const stream = createStream(...args);
    stream.once("data", () => { reads++; controller.abort(); });
    return stream;
  });
  const opts = { snapshotBase: path.join(base, "snapshots") };
  const snapshot = await takeSnapshot(root, opts);
  const manifest = JSON.parse(await readFile(path.join(snapshot.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.specialEntries[0].state, `file-size:${cap + 1}`);
  assert.deepEqual((await restoreSnapshot(snapshot)).failed, []);
  await truncate(file, cap + 2);
  assert.deepEqual((await restoreSnapshot(snapshot)).failed.map(entry => entry.path), ["link"]);
  assert.equal(reads, 0, "the over-cap file must not be streamed");

  await truncate(file, cap);
  await assert.rejects(takeSnapshot(root, { ...opts, signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 1, "cancel after the hash starts at the inclusive byte limit");
});

test("S20 (7), S15: caller cancellation of an in-flight snapshot Git child returns cancelled", async t => {
  const controller = new AbortController();
  const spawn = childProcess.spawn;
  let spawned = false, snapshotError, runs = 0;
  mockBuiltin(t, childProcess, "spawn", (command, args, options) => {
    const child = spawn(command, args, options);
    if (args.includes("--show-toplevel")) {
      child.once("spawn", () => {
        spawned = true;
        assert.equal(child.exitCode, null);
        controller.abort();
        child.emit("error", new Error("late process error"));
      });
    }
    return child;
  });
  const out = await runEdits(editInput, {
    ...editOptions, signal: controller.signal,
    verifyImpl: () => assert.fail("verification started"),
    runner: () => { runs++; },
    takeSnapshotImpl: async (root, options) => {
      try { return await takeSnapshot(root, options); }
      catch (err) { snapshotError = err.kind; throw err; }
    },
  });
  assert.equal(spawned, true);
  assert.equal(snapshotError, "cancelled");
  assert.equal(out.error, "cancelled");
  assert.equal(runs, 0);
});
