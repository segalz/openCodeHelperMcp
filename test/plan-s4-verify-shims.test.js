import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveVerificationCommand } from "../src/verify.js";

// Plan S4 (review item A3): on Windows, npm/pnpm/yarn shims (`node_modules/.bin/*.cmd`, global `*.cmd`) must
// resolve to a direct, shell-free launch instead of being refused, and an unknown batch file stays refused.
// Mirrors ClineMcp src/test/plan-s4-verify-shims.test.ts.

const windowsOnly = { skip: process.platform !== "win32" ? "Windows shim resolution" : false };
const base = await mkdtemp(path.join(os.tmpdir(), "opencode-s4-test-"));
after(async () => { await rm(base, { recursive: true, force: true }).catch(() => {}); });

/** The exact cmd-shim npm writes for a node script (`target` is relative to the .bin folder). */
const nodeShim = target => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\node.exe\" (", "  SET \"_prog=%dp0%\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, "",
].join("\r\n");
/** The cmd-shim npm writes for a native executable. */
const exeShim = target => ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  `"%dp0%\\${target}"   %*`, ""].join("\r\n");

async function project(name) {
  const root = await mkdtemp(path.join(base, `${name}-`));
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  return root;
}
async function file(target, content = "") { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return target; }

async function withPath(dirs, fn) {
  const saved = process.env.PATH;
  process.env.PATH = [...dirs, saved ?? ""].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test("S4: a local node_modules/.bin shim (vitest) resolves to node plus its JS entry", windowsOnly, async () => {
  const root = await project("vitest");
  const entry = await file(path.join(root, "node_modules", "vitest", "vitest.mjs"), "process.exit(0)");
  await file(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim("..\\vitest\\vitest.mjs"));
  await file(path.join(root, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexec node \"$basedir/../vitest/vitest.mjs\" \"$@\"\n");
  assert.deepEqual(await resolveVerificationCommand("vitest", ["run"], root), { command: process.execPath, args: [entry, "run"] });
});

test("S4: an extensionless JS entry (tsc) resolves to node plus that file", windowsOnly, async () => {
  const root = await project("tsc");
  const entry = await file(path.join(root, "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
  await file(path.join(root, "node_modules", ".bin", "tsc.cmd"), nodeShim("..\\typescript\\bin\\tsc"));
  assert.deepEqual(await resolveVerificationCommand("tsc", ["--noEmit"], root), { command: process.execPath, args: [entry, "--noEmit"] });
});

test("S4: a monorepo subfolder finds the nearest node_modules/.bin walking up", windowsOnly, async () => {
  const root = await project("mono");
  const entry = await file(path.join(root, "node_modules", "vitest", "vitest.mjs"), "");
  await file(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim("..\\vitest\\vitest.mjs"));
  const app = path.join(root, "packages", "app");
  await mkdir(app, { recursive: true });
  assert.deepEqual(await resolveVerificationCommand("vitest", [], app), { command: process.execPath, args: [entry] });
});

test("S4: a shim that wraps a native executable resolves to that executable", windowsOnly, async () => {
  const root = await project("exe");
  const exe = await file(path.join(root, "node_modules", "esbuild", "esbuild.exe"), "MZ");
  await file(path.join(root, "node_modules", ".bin", "esbuild.cmd"), exeShim("..\\esbuild\\esbuild.exe"));
  assert.deepEqual(await resolveVerificationCommand("esbuild", ["--version"], root), { command: exe, args: ["--version"] });
});

test("S4: a global corepack shim (pnpm) on PATH resolves through corepack's JS entry", windowsOnly, async () => {
  const globalDir = await mkdtemp(path.join(base, "global-"));
  const corepack = await file(path.join(globalDir, "node_modules", "corepack", "dist", "corepack.js"), "");
  await file(path.join(globalDir, "corepack.cmd"), nodeShim("node_modules\\corepack\\dist\\corepack.js"));
  await file(path.join(globalDir, "pnpm.cmd"), "@corepack pnpm %*\r\n");
  const cwd = await project("pnpm");
  await withPath([globalDir], async () => {
    assert.deepEqual(await resolveVerificationCommand("pnpm", ["test"], cwd), { command: process.execPath, args: [corepack, "pnpm", "test"] });
  });
});

test("S4: an arbitrary batch file on PATH stays refused", windowsOnly, async () => {
  const globalDir = await mkdtemp(path.join(base, "batch-"));
  await file(path.join(globalDir, "runtests.cmd"), "@echo off\r\ndel /q *.*\r\n");
  const cwd = await project("batch");
  await withPath([globalDir], async () => {
    await assert.rejects(resolveVerificationCommand("runtests", [], cwd), error => error?.kind === "verification_refused");
  });
});

test("S4: a shim whose target file is missing is not launched", windowsOnly, async () => {
  const root = await project("broken");
  await file(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim("..\\vitest\\vitest.mjs"));
  await assert.rejects(resolveVerificationCommand("vitest", [], root), error => error?.kind === "verification_refused" || error?.kind === "verification_launch_failed");
});

test("S4: a verify command that cannot be resolved is refused before the snapshot and the model run", async () => {
  const { runEdits } = await import("../src/edits.js");
  const root = await mkdtemp(path.join(base, "early-"));
  let runs = 0, snapshots = 0;
  const out = await runEdits({
    directory: root, prompt: "Fix it", model: "opencode/test-free", codeMap: false,
    verify: { command: "definitely-missing-verify-tool-s4", args: ["run"] },
  }, {
    lockDirectory: path.join(base, "locks"),
    resolveRoot: async directory => directory,
    identityImpl: async () => ({ head: "h", indexHash: "i" }),
    takeSnapshotImpl: async () => { snapshots++; return { directory: path.join(base, "snap"), manifest: [] }; },
    ignoredPathsImpl: async () => [],
    runner: async () => { runs++; return { text: "done", sessionID: "ses_x" }; },
  });
  assert.equal(out.status, "failed");
  assert.match(String(out.error), /^verification_(launch_failed|refused)$/);
  assert.equal(runs, 0, "the model must not run when the check cannot even start");
  assert.equal(snapshots, 0, "no snapshot is taken for a request that is refused up front");
});

test("S4 review: a shim written as %~dp0..\\target (no separator) still resolves", windowsOnly, async () => {
  const root = await project("nosep");
  const entry = await file(path.join(root, "node_modules", "x", "cli.js"), "");
  await file(path.join(root, "node_modules", ".bin", "xcli.cmd"), "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0..\\x\\cli.js\" %*\r\n) ELSE (\r\n  node  \"%~dp0..\\x\\cli.js\" %*\r\n)\r\n");
  assert.deepEqual(await resolveVerificationCommand("xcli", [], root), { command: process.execPath, args: [entry] });
});

test("S4 review: a batch line that only mentions an .exe is not run", windowsOnly, async () => {
  const root = await project("echo");
  await file(path.join(root, "node_modules", "h", "helper.exe"), "MZ");
  await file(path.join(root, "node_modules", ".bin", "helper.cmd"), "@echo off\r\necho \"%dp0%\\..\\h\\helper.exe\" %*\r\n");
  await assert.rejects(resolveVerificationCommand("helper", [], root), error => error?.kind === "verification_refused");
});

test("S4 review: an earlier PATH folder's .cmd shim wins over a later folder's .exe, as on Windows", windowsOnly, async () => {
  const early = await mkdtemp(path.join(base, "early-path-"));
  const late = await mkdtemp(path.join(base, "late-path-"));
  const entry = await file(path.join(early, "node_modules", "tool", "cli.js"), "");
  await file(path.join(early, "s4tool.cmd"), nodeShim("node_modules\\tool\\cli.js"));
  await file(path.join(late, "s4tool.exe"), "MZ");
  const cwd = await project("order");
  await withPath([early, late], async () => {
    assert.deepEqual(await resolveVerificationCommand("s4tool", [], cwd), { command: process.execPath, args: [entry] });
  });
});

test("S4 review: the node_modules/.bin search stops at the repository root", windowsOnly, async () => {
  const outer = await project("outer");
  await file(path.join(outer, "node_modules", "s4only", "cli.js"), "");
  await file(path.join(outer, "node_modules", ".bin", "s4only.cmd"), nodeShim("..\\s4only\\cli.js"));
  const repo = path.join(outer, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await assert.rejects(resolveVerificationCommand("s4only", [], repo), error => error?.kind === "verification_launch_failed");
});
