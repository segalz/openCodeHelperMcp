import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createOpenCodeRunner, shutdownAnalysis } from "../src/core.js";
import { runEdits } from "../src/edits.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
const directory = process.cwd();
const answer = '{"type":"text","sessionID":"ses_s16","text":"answer"}\n';

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

function fixture({ listen = true, onRun, env = {}, onTerminate, getFreePort } = {}) {
  const clock = fakeClock();
  const servers = [], runs = [];
  let nextPort = 24000, peak = 0;
  function spawn(executable, args, options) {
    const child = Object.assign(new EventEmitter(), {
      executable, args, options, stdout: new PassThrough(), stderr: new PassThrough(), input: "", closed: false,
    });
    child.stdin = new Writable({ write(bytes, _encoding, done) { child.input += bytes.toString(); done(); } });
    child.finish = (code = 0) => {
      if (child.closed) return;
      child.closed = true;
      child.emit("exit", code);
      child.emit("close", code);
    };
    if (args[0] === "serve") {
      servers.push(child);
      peak = Math.max(peak, servers.filter(server => !server.closed).length);
      const port = Number(args[args.indexOf("--port") + 1]);
      child.url = `http://127.0.0.1:${port}`;
      if (listen) queueMicrotask(() => {
        child.stdout.write("opencode server listen");
        child.stdout.write(`ing on ${child.url}\n`);
      });
    } else {
      assert.equal(args[0], "run");
      runs.push(child);
      child.url = args.includes("--attach") ? args[args.indexOf("--attach") + 1] : undefined;
      queueMicrotask(() => {
        if (onRun && onRun(child, servers) === false) return;
        child.stdout.write(answer);
        child.finish();
      });
    }
    return child;
  }
  const runner = createOpenCodeRunner({
    spawnImpl: spawn, getFreePort: getFreePort ?? (async () => ++nextPort),
    setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear, nowImpl: clock.now,
    killProcessTreeImpl: child => {
      if (onTerminate) onTerminate(child);
      else child.finish(null);
    },
    env, graceMs: 1,
  });
  const run = (overrides = {}) => runner({ directory, prompt: "first prompt", model: "test/free",
    codeMap: false, timeoutMs: 100_000, ...overrides });
  return { runner, run, clock, servers, runs, peak: () => peak };
}

test("S16 reuses a matching analysis server and sends each prompt only on stdin", async () => {
  const h = fixture();
  assert.equal((await h.run()).text, "answer");
  assert.equal((await h.run({ prompt: "second prompt", model: "other/free", variant: "low" })).text, "answer");
  assert.equal(h.servers.length, 1);
  const [server] = h.servers;
  assert.deepEqual(server.args.slice(0, 5), ["serve", "--hostname", "127.0.0.1", "--port", "24001"]);
  assert.deepEqual(h.runs.map(run => run.url), [server.url, server.url]);
  for (const [index, prompt] of ["first prompt", "second prompt"].entries()) {
    assert.ok(h.runs[index].input.endsWith(prompt));
    assert.ok(!h.runs[index].args.some(arg => arg.includes(prompt)));
    assert.ok(h.runs[index].stdin.writableEnded);
  }
  assert.ok(h.runs[1].args.includes("--variant"));
});

test("S16 separates ignored paths and modes and starts serve with the exact cold environment and cwd", async () => {
  const env = { OPENCODE_BIN: "test-cli", GIT_OPTIONAL_LOCKS: "1", OPENCODE_CONFIG_CONTENT: '{"theme":"dark"}' };
  const h = fixture({ env });
  for (const options of [{ ignoredPaths: ["a.txt"] }, { ignoredPaths: ["b.txt"] }, { ignoredPaths: ["b.txt"], mode: "edits" }]) {
    await h.run(options);
    const cold = fixture({ env: { ...env }, listen: false });
    // A failed server start takes the cold path with precisely the same input environment.
    const pending = cold.run(options);
    await turn();
    cold.clock.advance(15_000);
    await pending;
    const server = h.servers.at(-1);
    assert.ok(server);
    assert.equal(cold.runs.length, 1);
    assert.equal(cold.runs[0].url, undefined);
    // The server adds only its own basic-auth secret (plan S16 review: an unsecured loopback server).
    const { OPENCODE_SERVER_PASSWORD: secret, ...serverEnv } = server.options.env;
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(serverEnv, cold.runs[0].options.env);
    assert.equal(server.options.cwd, cold.runs[0].options.cwd);
    assert.equal(server.executable, cold.runs[0].executable);
    assert.equal(server.options.env.GIT_OPTIONAL_LOCKS, "0");
    const agent = options.mode === "edits" ? "build" : "plan";
    assert.equal(JSON.parse(server.options.env.OPENCODE_CONFIG_CONTENT).agent[agent].permission.read[options.ignoredPaths[0]], "deny");
  }
  assert.equal(new Set(h.runs.map(run => run.url)).size, 3);
});

test("S16 executable, inherited environment, inline config and cwd all partition the pool", async () => {
  const env = { OPENCODE_BIN: "one", TOOL_SETTING: "first" };
  const h = fixture({ env });
  await h.run();
  env.OPENCODE_BIN = "two";
  await h.run();
  env.TOOL_SETTING = "second";
  await h.run();
  env.OPENCODE_CONFIG_CONTENT = '{"theme":"dark"}';
  await h.run();
  await h.run({ directory: path.join(directory, "src") });
  assert.equal(new Set(h.runs.map(run => run.url)).size, 5);
  assert.equal(h.servers.length, 5);
});

test("S16 resets the 120 second idle timeout on use", async () => {
  const h = fixture();
  await h.run();
  assert.equal(h.servers.length, 1);
  h.clock.advance(119_999);
  await h.run();
  h.clock.advance(119_999);
  assert.equal(h.servers[0].closed, false);
  h.clock.advance(1);
  await turn();
  assert.equal(h.servers[0].closed, true);
  await h.run();
  assert.equal(h.servers.length, 2);
});

test("S16 evicts the least recently used server before starting a third", async () => {
  const h = fixture({ onTerminate: child => setImmediate(() => child.finish(null)) });
  for (const name of ["a", "b", "a", "c"]) await h.run({ directory: path.join(directory, name) });
  assert.equal(h.servers.length, 3);
  assert.equal(h.peak(), 2);
  assert.deepEqual(h.servers.map(server => server.closed), [false, true, false]);
  assert.equal(h.runs[0].url, h.runs[2].url);
});

test("S16 active analysis runs keep their server and their individual quota logs under contention", async () => {
  const h = fixture({ onRun: child => child.url ? false : undefined });
  const runIn = name => h.run({ directory: path.join(directory, name) });
  const first = runIn("a"), second = runIn("b");
  await turn();
  assert.equal(h.servers.length, 2);
  assert.equal((await runIn("c")).text, "answer");
  assert.equal(h.peak(), 2);
  h.servers[0].stderr.write('level=ERROR error.error="quota exceeded"\n');
  assert.equal((await first).limitKind, "quota");
  assert.equal(h.servers[1].closed, false);
  h.runs[1].stdout.write(answer);
  h.runs[1].finish();
  assert.equal((await second).text, "answer");
});

test("S16 edit and same-session repair share a private server that exits before restore or keep", async t => {
  const lockDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-s16-lock-"));
  t.after(() => rm(lockDirectory, { recursive: true, force: true }));
  const h = fixture({ onTerminate: child => setImmediate(() => child.finish(null)) });
  const input = { directory, prompt: "update", model: "test/free", codeMap: false,
    maxFixRuns: 1, verify: { command: "test", timeoutSeconds: 1 } };
  const lifecycle = {
    runner: h.runner, lockDirectory, resolveRoot: async () => directory,
    ignoredPathsImpl: async () => [], identityImpl: async () => ({ head: "same", indexHash: "same" }),
    takeSnapshotImpl: async () => ({ directory: "fixture" }),
  };
  for (const keepOnFailure of [false, true]) {
    const liveDuring = [], liveAtRecovery = [];
    const recordRecovery = () => liveAtRecovery.push(h.servers.some(server => !server.closed));
    const result = await runEdits({ ...input, keepOnFailure }, {
      ...lifecycle,
      verifyImpl: async () => { liveDuring.push(h.servers.filter(server => !server.closed).length); return { passed: false, exitCode: 1 }; },
      restoreSnapshotImpl: async () => { recordRecovery(); return { failed: [] }; },
      discardSnapshotImpl: async () => { recordRecovery(); },
    });
    assert.equal(result.error, "verify_failed");
    assert.deepEqual(liveDuring, [1, 1]);
    assert.deepEqual(liveAtRecovery, keepOnFailure ? [false] : [false, false]);
    assert.equal(result.verification.restored, !keepOnFailure);
    assert.equal(result.verification.kept, keepOnFailure);
  }
  assert.equal(h.servers.length, 2);
  assert.notEqual(h.servers[0].url, h.servers[1].url);
  for (const [index, run] of h.runs.entries()) {
    assert.equal(run.url, h.servers[Math.floor(index / 2)].url);
    if (index % 2) assert.equal(run.args[run.args.indexOf("--session") + 1], "ses_s16");
  }
  const kept = await runEdits(input, {
    ...lifecycle, verifyImpl: async () => ({ passed: true, exitCode: 0 }),
    discardSnapshotImpl: async () => { assert.ok(h.servers.at(-1).closed); },
  });
  assert.equal(kept.status, "done");
  assert.equal(kept.evidence.cleanupError, undefined);
  assert.equal(h.servers.length, 3);

  for (const identityChanges of [false, true]) {
    let head = "same";
    const recoveryCalls = [];
    const uncertainLockDir = await mkdtemp(path.join(lockDirectory, `uncertain-${identityChanges}-`));
    const uncertain = await runEdits({ ...input, keepOnFailure: true }, {
      ...lifecycle, lockDirectory: uncertainLockDir, identityImpl: async () => ({ head, indexHash: "same" }),
      runner: async ({ editScope }) => {
        if (identityChanges) head = "changed";
        editScope.server = { stop: async () => ({ killConfirmed: false, stillAlive: [], killUnverified: true }) };
        return { text: "answer", sessionID: "ses_s16" };
      },
      verifyImpl: async () => ({ passed: true, exitCode: 0 }),
      restoreSnapshotImpl: async () => { recoveryCalls.push("restore"); return { failed: [] }; },
      discardSnapshotImpl: async () => { recoveryCalls.push("discard"); },
    });
    if (identityChanges) {
      assert.equal(uncertain.error, "identity_changed");
      assert.equal(uncertain.verification.kept, true);
    } else {
      assert.equal(uncertain.status, "done");
      assert.equal(uncertain.error, undefined);
      assert.equal(uncertain.verification.passed, true);
      assert.equal(uncertain.verification.restored, false);
      assert.ok(uncertain.warnings?.some(w => /still be running/i.test(w)));
    }
    assert.deepEqual(uncertain.evidence.processesStillAlive, []);
    assert.equal(uncertain.evidence.snapshotDirectory, "fixture");
    assert.deepEqual(recoveryCalls, []);
  }
});

test("S16 listen timeout kills serve at 15 seconds and uses the remaining budget once cold", async () => {
  const h = fixture({ listen: false });
  const pending = h.run();
  await turn();
  assert.equal(h.servers.length, 1);
  h.clock.advance(14_999);
  assert.equal(h.runs.length, 0);
  h.clock.advance(1);
  const result = await pending;
  assert.equal(result.text, "answer");
  assert.equal(result.elapsedMs, 15_000);
  assert.equal(h.servers[0].closed, true);
  assert.deepEqual(h.runs.map(run => run.url), [undefined]);

  const slowCold = fixture({ listen: false, onRun: () => false });
  const bounded = slowCold.run({ timeoutMs: 20_000 });
  await turn();
  slowCold.clock.advance(15_000);
  await turn();
  slowCold.clock.advance(4_999);
  assert.equal(slowCold.runs[0].closed, false);
  slowCold.clock.advance(1);
  assert.equal((await bounded).status, "timeout");
  assert.equal(slowCold.runs.length, 1);
});

test("S16 an unrelated listening port and an exhausted attempt budget cannot launch a run", async () => {
  const h = fixture({ listen: false });
  const pending = h.run({ timeoutMs: 2_000 });
  await turn();
  assert.equal(h.servers.length, 1);
  h.servers[0].stdout.write("opencode server listening on http://127.0.0.1:24002\n");
  h.clock.advance(2_000);
  assert.equal((await pending).status, "timeout");
  assert.ok(h.servers[0].closed);
  assert.equal(h.runs.length, 0);
  let finishAllocating;
  const stalled = fixture({ getFreePort: () => new Promise(resolve => { finishAllocating = resolve; }) });
  const waiting = stalled.run();
  await turn();
  stalled.clock.advance(15_000);
  assert.equal((await waiting).text, "answer");
  finishAllocating(24245);
  await turn();
  assert.equal(stalled.servers.length, 0);
  assert.deepEqual(stalled.runs.map(run => run.url), [undefined]);
});

test("S16 a server that dies before any event retires and the attempt retries exactly once cold", async () => {
  const h = fixture({ onRun(child, servers) {
    if (!child.url) return;
    child.stdout.write("connecting...\n");
    queueMicrotask(() => servers[0].finish(1)); // the server crashes; the client is reaped
    return false;
  } });
  const pending = h.run();
  await turn();
  assert.equal((await pending).text, "answer");
  assert.deepEqual(h.runs.map(run => run.url), [h.servers[0].url, undefined]);
  assert.ok(h.servers[0].closed && h.runs[0].closed);
  assert.equal(h.runs[0].input, h.runs[1].input);
});

test("S16 review: a client that exits by itself before any event is reported, never replayed", async () => {
  // The provider may already have the request (e.g. an error line OpenCode prints in a form the helper does not know).
  const h = fixture({ onRun(child) {
    if (!child.url) return;
    child.stderr.write("Error: request rejected by provider\n");
    child.finish(1);
    return false;
  } });
  const result = await h.run();
  assert.equal(result.status, "failed");
  assert.equal(h.runs.length, 1);
});

test("S16 review: a quiet attached run is not stopped by a no-event watchdog (provider retries are silent)", async () => {
  const h = fixture({ onRun: child => child.url ? false : undefined });
  const pending = h.run({ timeoutMs: 120_000 });
  await turn();
  h.clock.advance(60_000);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].closed, false);
  assert.equal(h.servers[0].closed, false);
  h.runs[0].stdout.write(answer);
  h.runs[0].finish();
  assert.equal((await pending).text, "answer");
  assert.equal(h.runs.length, 1);
});

test("S16 output is never replayed, even when the server dies after it", async () => {
  const h = fixture({ onRun(child) {
    if (!child.url) return;
    child.stdout.write('{"type":"step_start","sessionID":"ses_s16"}\n');
    return false;
  } });
  const pending = h.run();
  await turn();
  assert.ok(h.runs[0].url);
  h.clock.advance(31_000);
  assert.equal(h.runs[0].closed, false);
  h.runs[0].stdout.write(answer.trimEnd());
  h.runs[0].finish(1);
  assert.equal((await pending).status, "failed");
  assert.equal(h.runs.length, 1);

  // The server dies and the client is being reaped, but it flushes its unterminated last event before closing.
  const draining = fixture({ onRun: child => child.url ? false : undefined, onTerminate(child) {
    if (child.args[0] === "run") child.stdout.write(answer.trimEnd());
    child.finish(null);
  } });
  const stopped = draining.run();
  await turn();
  draining.servers[0].finish(1);
  assert.equal((await stopped).status, "failed");
  assert.equal(draining.runs.length, 1);
});

test("S16 a server-side quota before stdout stops the attempt without a cold retry", async () => {
  const h = fixture({ onRun(child, servers) {
    if (!child.url) return;
    servers[0].stderr.write('level=ERROR error.error="free usage limit reached"\n');
    return false;
  } });
  const result = await h.run();
  assert.equal(result.limitKind, "quota");
  assert.equal(h.runs.length, 1);
  assert.ok(h.servers[0].closed);

  const lateQuota = fixture({
    onRun(child) { if (child.url) { child.finish(1); return false; } },
    onTerminate(child) {
      child.stderr.write('level=ERROR error.error="AI_RetryError: Too Many Requests"');
      child.finish(null);
    },
  });
  assert.equal((await lateQuota.run()).limitKind, "rate_limit");
  assert.equal(lateQuota.runs.length, 1);
});

test("S16 OPENCODE_HELPER_SERVE=0 switches the default attached run to the original cold args", async () => {
  const env = {};
  const h = fixture({ env });
  await h.run();
  env.OPENCODE_HELPER_SERVE = "0";
  assert.equal((await h.run()).text, "answer");
  assert.equal(h.servers.length, 1);
  assert.equal(h.runs[0].url, h.servers[0].url);
  assert.deepEqual(h.runs[0].args.filter(arg => arg !== "--attach" && arg !== h.servers[0].url), h.runs[1].args);
  assert.equal(h.runs[1].url, undefined);
  assert.equal(h.runs[1].input, h.runs[0].input);
});

// Shutdown is final for this test worker.
test("S16 review: every server requires its own random password and only its attached runs get it", async () => {
  const h = fixture();
  await h.run({ ignoredPaths: ["a.txt"] });
  await h.run({ ignoredPaths: ["a.txt"], prompt: "again" });
  await h.run({ ignoredPaths: ["b.txt"] });
  assert.equal(h.servers.length, 2);
  const [first, second] = h.servers.map(server => server.options.env.OPENCODE_SERVER_PASSWORD);
  assert.match(first, /^[0-9a-f]{64}$/); assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.deepEqual(h.runs.map(run => run.options.env.OPENCODE_SERVER_PASSWORD), [first, first, second]);
  for (const arg of [...h.servers, ...h.runs].flatMap(child => child.args)) {
    assert.ok(!arg.includes(first) && !arg.includes(second), "the secret never goes on a command line");
  }
  const cold = fixture({ env: { OPENCODE_HELPER_SERVE: "0" } });
  await cold.run();
  assert.equal(cold.runs[0].options.env.OPENCODE_SERVER_PASSWORD, undefined, "a cold run gets no server secret");
});

// Keep last: shutdown is final for this process.
test("S16 shutdown kills idle and starting servers and later calls spawn nothing", async () => {
  const idle = fixture(), starting = fixture({ listen: false });
  let finishAllocating;
  const allocating = fixture({ getFreePort: () => new Promise(resolve => { finishAllocating = resolve; }) });
  await idle.run();
  const pending = starting.run();
  const preparing = allocating.run();
  await turn();
  assert.equal(idle.servers.length, 1);
  assert.equal(starting.servers.length, 1);
  await shutdownAnalysis();
  assert.equal((await pending).cancelled, true);
  assert.equal((await preparing).cancelled, true);
  finishAllocating(24405);
  await turn();
  assert.equal(allocating.servers.length + allocating.runs.length, 0);
  assert.ok(idle.servers[0].closed && starting.servers[0].closed);
  const late = fixture();
  assert.equal((await late.run()).cancelled, true);
  assert.equal(late.servers.length + late.runs.length + starting.runs.length, 0);
});

