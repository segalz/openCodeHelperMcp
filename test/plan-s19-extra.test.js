import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test, { after } from "node:test";
import {
  createModelCatalog,
  parseRetryAfterMs,
  resolvePathWithinAllowedRoots,
  shutdownAnalysis,
} from "../src/core.js";
import { runEdits } from "../src/edits.js";
import { permissionEnvironment } from "../src/permissions.js";
import { redactSecrets } from "../src/safety.js";
import { discardSnapshot, restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { resolveVerificationCommand, VerificationError } from "../src/verify.js";

const base = await mkdtemp(path.join(os.tmpdir(), "oc-s19x-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
const windowsOnly = { skip: process.platform !== "win32" ? "Windows shim resolution" : false };

const nodeShim = (target) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, "",
].join("\r\n");

function git(root, args, input) {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, input });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function fakeChild(onSpawn) {
  const child = new EventEmitter();
  child.pid = 6100;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  setImmediate(() => onSpawn?.(child));
  return child;
}

// ---- Item 1: A3 (explicit node_modules/.bin path & non-runnable files) ----

test("S19 extra A3: explicit node_modules/.bin paths resolve via .cmd shim and non-runnable files are refused", windowsOnly, async () => {
  const root = await mkdtemp(path.join(base, "a3-"));
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
  const entry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  await writeFile(entry, "process.exit(0)");
  await writeFile(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim("..\\vitest\\vitest.mjs"));
  await writeFile(path.join(root, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
  for (const command of [
    "node_modules\\.bin\\vitest",
    ".\\node_modules\\.bin\\vitest",
    "node_modules/.bin/vitest",
    path.join(root, "node_modules", ".bin", "vitest"),
  ]) {
    const resolved = await resolveVerificationCommand(command, ["run"], root);
    assert.equal(resolved.command, process.execPath, command);
    assert.equal(path.resolve(resolved.args[0]), entry, command);
    assert.equal(resolved.args.at(-1), "run");
  }
  const notRunnable = path.join(root, "notes.txt");
  await writeFile(notRunnable, "hello");
  await assert.rejects(resolveVerificationCommand(notRunnable, [], root), VerificationError);
});

// ---- Item 2: A6 (permissions.js and core.js ..tools subfolder checks) ----

test("S19 extra A6: permissionEnvironment and resolvePathWithinAllowedRoots treat ..tools as inside", async () => {
  const root = path.join(base, "a6-repo");
  const dotDotTools = path.join(root, "..tools");
  const env = permissionEnvironment({}, "edits", ["..tools/secret.txt"], root, dotDotTools);
  const profile = JSON.parse(env.OPENCODE_PERMISSION);
  assert.equal(profile.edit["secret.txt"], "deny", "ignored path inside ..tools must also be denied relative to workDir");

  const opts = { realpathImpl: async (p) => p, pathImpl: path.win32 };
  assert.equal(
    await resolvePathWithinAllowedRoots("C:\\Develop\\..tools", ["C:\\Develop"], opts),
    "C:\\Develop\\..tools",
  );
  assert.equal(await resolvePathWithinAllowedRoots("C:\\", ["C:\\Develop"], opts), null);
  assert.equal(await resolvePathWithinAllowedRoots("C:\\Other", ["C:\\Develop"], opts), null);
});

// ---- Item 3: C5 (safety.js closing delimiters after type annotations) ----

test("S19 extra C5: type annotations followed by }, >, ], ) are kept while suffixed secrets stay redacted", () => {
  for (const text of [
    "type T = { secret: boolean}",
    "type U = Array<{ key: string}>",
    "type V = [token: number]",
    "fn(password: string[])",
  ]) {
    assert.equal(redactSecrets(text), text);
  }
  assert.ok(!redactSecrets("key: string)realSecret99").includes("realSecret99"));
  assert.ok(!redactSecrets("API_KEY=string").includes("string"));
});

// ---- Item 4: D3 (parseRetryAfterMs HTTP-date in header/log form) ----

test("S19 extra D3: HTTP-date Retry-After parses quoted log headers and returns undefined for past dates", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const future = new Date(now + 90_000).toUTCString();
  const past = new Date(now - 90_000).toUTCString();
  assert.equal(parseRetryAfterMs(`error retry-after="${future}" status=429`, { now }), 90_000);
  assert.equal(parseRetryAfterMs(`Retry-After: ${past}`, { now }), undefined);
});

// ---- Item 6: S15 (caller cancel during Git snapshot reports cancelled, not snapshot_git_failed) ----

test("S19 extra S15: caller cancel during Git snapshot of an edit reports cancelled, not snapshot_git_failed", async () => {
  const dir = await mkdtemp(path.join(base, "s15-"));
  const root = path.join(dir, "repo");
  await mkdir(root);
  git(root, ["init", "--quiet"]);
  await writeFile(path.join(root, "main.js"), "export const x = 1;\n");
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"]);

  const controller = new AbortController();
  const out = await runEdits(
    { directory: root, prompt: "Fix main.js", model: "opencode/test-free", codeMap: false,
      verify: { none: true, reason: "cancel during snapshot test" } },
    {
      lockDirectory: path.join(dir, "locks"),
      snapshotOptions: { snapshotBase: path.join(dir, "snapshots") },
      signal: controller.signal,
      runner: () => assert.fail("runner must not launch when cancelled during snapshot"),
      takeSnapshotImpl: (r, opts) => {
        const pending = takeSnapshot(r, opts);
        controller.abort();
        return pending;
      },
    },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.error, "cancelled", `expected cancelled, got ${out.error}: ${out.message}`);
});

// ---- Item 7: C4 (symlink placeholder > 1 MiB compared by streamed hash) ----

test("S19 extra C4: same-length overwrite of a >1 MiB tracked symlink placeholder is reported as changed", async () => {
  const dir = await mkdtemp(path.join(base, "c4-"));
  const root = path.join(dir, "repo");
  const storage = path.join(dir, "snapshots");
  await mkdir(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.symlinks", "false"]);
  await writeFile(path.join(root, "a.txt"), "baseline\n");
  git(root, ["add", "a.txt"]);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "a.txt");
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},link`]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"]);

  const size = 1024 * 1024 + 64;
  const original = Buffer.alloc(size, 0x61); // 'a'
  await writeFile(path.join(root, "link"), original);

  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  try {
    // Untouched >1 MiB placeholder restores cleanly.
    const untouched = await restoreSnapshot(snapshot);
    assert.deepEqual(untouched.failed, []);

    // Same-length overwrite changing only the last byte must be detected by streamed hash.
    const modified = Buffer.alloc(size, 0x61);
    modified[size - 1] = 0x62; // 'b'
    await writeFile(path.join(root, "link"), modified);

    const changed = await restoreSnapshot(snapshot);
    assert.deepEqual(changed.failed.map(e => e.path), ["link"]);
    assert.equal((await readFile(path.join(root, "link")))[size - 1], 0x62, "special entry is left untouched");
  } finally {
    await discardSnapshot(snapshot);
  }
});

// ---- Item 5: C6 (shutdownAnalysis stops & waits for model-discovery children, blocks new ones) ----
// Runs last because shutdownAnalysis() sets module-wide shutdown state in src/core.js.

test("S19 extra C6: shutdownAnalysis stops and waits for running --verbose and plain discovery children and blocks new ones", async () => {
  const events = [];
  let verboseChild = null;
  let plainChild = null;
  let verboseCatalogSpawns = 0;

  const catalogVerbose = createModelCatalog({
    env: {},
    platform: "win32",
    listTimeoutMs: 5_000,
    spawnImpl: (_exe, args) => {
      verboseCatalogSpawns++;
      events.push(`spawn:v:${args.join(" ")}`);
      return fakeChild(child => { verboseChild = child; });
    },
    killProcessTreeImpl: (target) => {
      events.push("kill:v");
      setTimeout(() => { events.push("closed:v"); target.emit("close", null); }, 25);
    },
  });

  const catalogPlain = createModelCatalog({
    env: {},
    platform: "win32",
    listTimeoutMs: 5_000,
    spawnImpl: (_exe, args) => {
      events.push(`spawn:p:${args.join(" ")}`);
      if (args.includes("--verbose")) {
        return fakeChild(child => child.emit("close", 1));
      }
      return fakeChild(child => { plainChild = child; });
    },
    killProcessTreeImpl: (target) => {
      events.push("kill:p");
      setTimeout(() => { events.push("closed:p"); target.emit("close", null); }, 25);
    },
  });

  const pVerbose = catalogVerbose.list({ refresh: true });
  const pPlain = catalogPlain.list({ refresh: true });

  const deadline = Date.now() + 2_000;
  while ((!verboseChild || !plainChild) && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(verboseChild, "--verbose discovery child should be running");
  assert.ok(plainChild, "plain fallback discovery child should be running");

  await shutdownAnalysis(2_000);

  // shutdownAnalysis must have stopped BOTH children and waited for BOTH to close.
  assert.ok(events.includes("kill:v"), `expected kill:v in ${JSON.stringify(events)}`);
  assert.ok(events.includes("closed:v"), `expected closed:v before shutdown resolved: ${JSON.stringify(events)}`);
  assert.ok(events.includes("kill:p"), `expected kill:p in ${JSON.stringify(events)}`);
  assert.ok(events.includes("closed:p"), `expected closed:p before shutdown resolved: ${JSON.stringify(events)}`);

  const [resV, resP] = await Promise.all([pVerbose, pPlain]);
  assert.ok(resV.error, "verbose list should fail on shutdown");
  assert.ok(resP.error, "plain list should fail on shutdown");
  assert.equal(verboseCatalogSpawns, 1, "cancelled --verbose must not spawn plain fallback");

  let afterSpawns = 0;
  const catalogAfter = createModelCatalog({
    env: {},
    platform: "win32",
    spawnImpl: () => { afterSpawns++; return fakeChild(c => c.emit("close", 0)); },
  });
  const resAfter = await catalogAfter.list({ refresh: true });
  assert.equal(afterSpawns, 0, "no discovery child may start after shutdown");
  assert.ok(resAfter.error);
});
