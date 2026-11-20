import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../src/safety.js";
import { resolveVerificationCommand, VerificationError } from "../src/verify.js";

// Plan S20: the Gate 5 re-audit findings (OpenCode side). More S20 tests live in plan-s20-extra.test.js.

const base = await mkdtemp(path.join(os.tmpdir(), "oc-s20-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
const mixedHex = "0f3a9c41b2d7e85f6a1c0b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f";
const digits = "1234567890".repeat(6) + "1234";

test("S20 (1): a quoted value after a secret key is redacted, whatever its characters", () => {
  for (const [text, secret] of [
    ['token = "hunter2hunter2"', "hunter2hunter2"],
    ["password: 'hunter2hunter2'", "hunter2hunter2"],
    [`api_key: "${digits}"`, digits.slice(0, 20)],
    [`token = "${digits}"`, digits.slice(0, 20)],
    [`session_id = rb"${mixedHex}"`, mixedHex.slice(0, 20)],
    [`secret="short1"`, "short1"],
  ]) {
    assert.ok(!redactSecrets(text).includes(secret), `${text} -> ${redactSecrets(text)}`);
  }
  for (const text of ["function f(key: string) {}", "const token: string = read()", `commit ${mixedHex.slice(0, 40)}`]) {
    assert.equal(redactSecrets(text), text);
  }
});

test("S20 review: ordinary code with quoted 'key' values and quoted type literals is not redacted", () => {
  for (const text of ['<li key="row-1">', ':key="item.id"', 'type T = { key: "asc" | "desc" }', 'token: "string"', 'sort key: "name"']) {
    assert.equal(redactSecrets(text), text);
  }
  // A long, secret-looking value after a bare `key` is still hidden.
  assert.ok(!redactSecrets(`key: "${mixedHex}"`).includes(mixedHex.slice(0, 16)));
});

test("S20 review: triple-quoted, .env-prefixed, JSON-prefixed and => / := secrets are redacted", () => {
  for (const [text, secret] of [
    ['password = """hunter2hunter2"""', "hunter2hunter2"],
    ['DB_PASSWORD="hunter2hunter2"', "hunter2hunter2"],
    ["MY_API_TOKEN=hunter2hunter2", "hunter2hunter2"],
    ['{"db_password": "hunter2hunter2"}', "hunter2hunter2"],
    ['password => "hunter2hunter2"', "hunter2hunter2"],
    ['password := "hunter2hunter2"', "hunter2hunter2"],
  ]) {
    assert.ok(!redactSecrets(text).includes(secret), `${text} -> ${redactSecrets(text)}`);
  }
});

test("S20 review: an explicit path to the installed npm still resolves", { skip: process.platform !== "win32" ? "Windows npm layout" : false }, async () => {
  const nodeDir = path.dirname(process.execPath);
  for (const command of [path.join(nodeDir, "npm.cmd"), path.join(nodeDir, "npm"), path.join(nodeDir, "npx.cmd")]) {
    const resolved = await resolveVerificationCommand(command, ["--version"], base);
    assert.equal(resolved.command, process.execPath, command);
    assert.match(resolved.args[0], /(?:npm|npx)-cli\.js$/, command);
  }
});

test("Gate 6: prefixed *_KEY secrets, Basic/Bearer after assignments and unquoted session ids are redacted", () => {
  for (const [text, secret] of [
    ['PRIVATE_KEY="hunter2hunter2"', "hunter2hunter2"],
    ['{"private_key": "hunter2hunter2"}', "hunter2hunter2"],
    ['{"private-key": "hunter2hunter2"}', "hunter2hunter2"],
    ["OPENAI_KEY=hunter2hunter2", "hunter2hunter2"],
    ["token = Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['token = Bearer "hunter2hunter2"', "hunter2hunter2"],
    ['Authorization: Bearer "hunter2hunter2"', "hunter2hunter2"],
    ["session_id = hunter2hunter2", "hunter2hunter2"],
  ]) {
    assert.ok(!redactSecrets(text).includes(secret), `${text} -> ${redactSecrets(text)}`);
  }
  for (const text of ['sort_key: "name"', "primary_key=id", 'cache_key = "user:1"']) {
    assert.equal(redactSecrets(text), text);
  }
});

test("S20 (5): an explicit path to a missing npm is refused, not replaced by the installed npm", async () => {
  const missing = path.join(base, "missing", "path", "npm");
  await assert.rejects(resolveVerificationCommand(missing, ["test"], base), VerificationError);
  await assert.rejects(resolveVerificationCommand(missing.replaceAll("\\", "/"), ["test"], base), VerificationError);
});
