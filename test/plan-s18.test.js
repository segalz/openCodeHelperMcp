import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../src/safety.js";
import { runEdits } from "../src/edits.js";

// Plan S18: the serious findings of the S17 final audit (OpenCode side).

const hex = "0f3a9c41b2d7e85f6a1c0b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f";

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr);
}
async function repo(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-s18-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "r"); await mkdir(root); git(root, "init", "-q");
  await writeFile(path.join(root, "main.js"), "broken\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  const options = { lockDirectory: path.join(base, "locks"), snapshotOptions: { snapshotBase: path.join(base, "snapshots") } };
  return { base, root, options };
}
const input = (root, extra = {}) => ({ directory: root, prompt: "Fix main.js", model: "opencode/test-free", codeMap: false,
  verify: { command: process.execPath, args: ["-e", "0"] }, ...extra });
const response = (text = "Changed main.js") => ({ text, sessionID: "ses_s18", usage: { inputTokens: 10, steps: 1 } });

// ---- (1) S14 regression: a quoted hex secret after a key must be redacted ----

test("S18 (1): quoted hex secrets after a key are redacted; a bare commit SHA is kept", () => {
  for (const text of [`token = "${hex}"`, `token="${hex}"`, `api_key: "${hex}"`, `session_id="${hex}"`, `SECRET='${hex}'`,
    `password: '${hex}'`, `{"session": "${hex}"}`]) {
    assert.ok(!redactSecrets(text).includes(hex.slice(0, 16)), `${text} -> ${redactSecrets(text)}`);
  }
  for (const text of [`commit ${hex.slice(0, 40)}`, `HEAD is now at ${hex.slice(0, 40)} fix`, `(${hex.slice(0, 40)})`]) {
    assert.equal(redactSecrets(text), text);
  }
});

// ---- (2) a final check whose processes could not be confirmed dead stops the edit ----

test("S18 (2): an unconfirmed check kill launches no repair and keeps the recovery snapshot", async t => {
  const f = await repo(t);
  let runs = 0;
  const out = await runEdits(input(f.root, { maxFixRuns: 2 }), { ...f.options,
    runner: async () => { runs++; await writeFile(path.join(f.root, "main.js"), `edit ${runs}\n`); return response(); },
    verifyImpl: async () => ({ passed: false, exitCode: null, signal: "SIGKILL", timedOut: true, killedForOutput: false, durationMs: 1,
      stdoutTail: "", stderrTail: "", killConfirmed: false, stillAlive: [4242] }) });
  assert.equal(runs, 1, "no repair may run while the check's processes may still be alive");
  assert.equal(out.verification.passed, false);
  assert.deepEqual(out.evidence.processesStillAlive, [4242]);
  assert.ok(out.evidence.snapshotDirectory && existsSync(out.evidence.snapshotDirectory),
    `the recovery snapshot is kept: ${JSON.stringify(out.evidence)}`);
});

// ---- (6) A4: a real final question that starts with "No" is a question ----

test("S18 (6): 'Question: No tests exist. Should I add one?' stops for input; 'Question: No.' does not", async t => {
  const f = await repo(t);
  const asked = await runEdits(input(f.root), { ...f.options, verifyImpl: () => assert.fail("no check"),
    runner: async () => response("Partly done.\nQuestion: No tests exist. Should I add one?") });
  assert.equal(asked.error, "input_required", JSON.stringify(asked));
  const f2 = await repo(t);
  const none = await runEdits(input(f2.root), { ...f2.options, verifyImpl: async () => ({ passed: true, exitCode: 0, signal: null,
    timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }),
    runner: async () => { await writeFile(path.join(f2.root, "main.js"), "fixed\n"); return response("Changed main.js\nQuestion: No."); } });
  assert.equal(none.error, undefined, JSON.stringify(none));
});

// ---- Opus review of S18 (OpenCode) ----

test("S18 review: common 'no question' endings stay final answers; a question mark makes a real question", async () => {
  const { isInputRequiredForTest } = await import("../src/edits.js");
  for (const rest of ["None at this time.", "None so far", "Nothing further", "No, all done.", "None, the change is complete.",
    "N/A, all clear", "No open questions at this time.", "None; tests pass.", "None: all set.", "None needed", "No questions remain.",
    "No.", "none", "N/A (all clear)"]) {
    assert.equal(isInputRequiredForTest(`Changed main.js\nQuestion: ${rest}`), false, rest);
  }
  for (const rest of ["No tests exist. Should I add one?", "Should the old API stay?", "none of the options fit — which one?"]) {
    assert.equal(isInputRequiredForTest(`Partly done.\nQuestion: ${rest}`), true, rest);
  }
});

test("S18 review: hex secrets in code, markdown and CLI forms are redacted; prose SHAs stay", () => {
  const sha = hex.slice(0, 40);
  for (const text of [`session_id: \`${hex}\``, `'token' => '${hex}'`, `"token": ["${hex}"]`, `token=("${hex}")`,
    `SESSION = r"${hex}"`, `--token "${hex}"`, `token := "${hex}"`, `--api-key ${hex}`]) {
    assert.ok(!redactSecrets(text).includes(hex.slice(0, 16)), `${text} -> ${redactSecrets(text)}`);
  }
  for (const text of [`commit ${sha}`, `HEAD is now at ${sha} fix`, `(${sha})`, `merged ${sha} into main`]) {
    assert.equal(redactSecrets(text), text);
  }
});

test("S18 review: a check that ended by itself fails only on a real survivor, not on an unreadable process table", async t => {
  const { runVerification } = await import("../src/verify.js");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oc-s18-verify-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const noJob = async () => ({ alive: true, assigned: false, assign() {}, close: async () => {} });
  const spec = { command: process.execPath, args: ["-e", "0"] };
  const unreadable = await runVerification(spec, cwd, undefined, { createWindowsJob: noJob,
    confirmTreeDead: async () => ({ confirmed: false, alive: [], unverified: true }) });
  assert.equal(unreadable.passed, true, JSON.stringify(unreadable));
  const survivor = await runVerification(spec, cwd, undefined, { createWindowsJob: noJob,
    confirmTreeDead: async () => ({ confirmed: false, alive: [5151], unverified: false }) });
  assert.equal(survivor.passed, false);
  assert.equal(survivor.killConfirmed, false);
});
