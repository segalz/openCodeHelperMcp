import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveVerificationCommand, VerificationError } from "../src/verify.js";
import { subfolderOf } from "../src/edits.js";
import { redactSecrets } from "../src/safety.js";
import { parseRetryAfterMs } from "../src/core.js";

// Plan S19: the small findings of the S17 final audit (OpenCode side).

const base = await mkdtemp(path.join(os.tmpdir(), "oc-s19-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
const windowsOnly = { skip: process.platform !== "win32" ? "Windows shim resolution" : false };
const nodeShim = (target) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%` + "\\" + target + `" %*`, "",
].join("\r\n");

test("S19 A3: an explicit node_modules/.bin path to a shim resolves like the bare name", windowsOnly, async () => {
  const root = await mkdtemp(path.join(base, "shim-"));
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
  const entry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  await writeFile(entry, "process.exit(0)");
  await writeFile(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim(String.raw`..\vitest\vitest.mjs`));
  for (const command of [String.raw`node_modules\.bin\vitest`, String.raw`.\node_modules\.bin\vitest`, "node_modules/.bin/vitest",
    path.join(root, "node_modules", ".bin", "vitest")]) {
    const resolved = await resolveVerificationCommand(command, ["run"], root);
    assert.equal(resolved.command, process.execPath, command);
    assert.equal(path.resolve(resolved.args[0]), entry, command);
    assert.equal(resolved.args.at(-1), "run");
  }
});

test("S19 A3: a directory named like the check command is refused up front", async () => {
  const root = await mkdtemp(path.join(base, "dir-"));
  await mkdir(path.join(root, "check.exe"));
  await assert.rejects(resolveVerificationCommand(path.join(root, "check.exe"), [], root), VerificationError);
});

test("S19 A6: a folder whose name starts with '..' is inside the checkout", async () => {
  const root = await mkdtemp(path.join(base, "root-"));
  await mkdir(path.join(root, "..tools"));
  assert.equal(await subfolderOf(root, path.join(root, "..tools")), path.join(root, "..tools"));
  assert.equal(await subfolderOf(root, path.join(root, "..")), undefined);
  assert.equal(await subfolderOf(root, path.join(root, "..", "elsewhere")), undefined);
});

test("S19 C5: parameter type annotations are not redacted", () => {
  for (const text of ["function f(key: string) {}", "f(token: string, password: number)", "type T = { secret: boolean }"]) {
    assert.equal(redactSecrets(text), text);
  }
  assert.ok(!redactSecrets("token: abc123def456ghi").includes("abc123def456ghi"));
});

test("S19 D3: an HTTP-date Retry-After gives the delay until that time", () => {
  const at = new Date(Date.now() + 3_600_000);
  const ms = parseRetryAfterMs(`Retry-After: ${at.toUTCString()}`);
  assert.ok(ms !== undefined && Math.abs(ms - 3_600_000) < 5_000, String(ms));
  assert.equal(parseRetryAfterMs("Retry-After: 120"), 120_000);
  const past = parseRetryAfterMs(`Retry-After: ${new Date(Date.now() - 60_000).toUTCString()}`);
  assert.ok(past === undefined || past === 0, String(past));
});
