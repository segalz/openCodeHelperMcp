import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../src/safety.js";
import { createdFiles, discardSnapshot, restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { runVerification } from "../src/verify.js";

// Plan S14 (review items C4, C5, C6).
// C4: a repository with a tracked symlink or a submodule is accepted when the run does not touch them; a run
//     that changes one is reported (never silently "restored"), and the bridge never rewrites it.
// C5: redaction keeps ordinary identifiers (`key: string`, Git SHAs) in check output sent to the fix prompt.
// C6: a passing check that prints more than 1 MiB is not killed; only a rolling tail is kept.

function git(root, args, input) {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, input });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const commit = (root, message) =>
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message]);

/**
 * A repository with `a.txt`, a tracked symlink `link` (target `a.txt`), an initialized submodule `module`
 * and an uninitialized submodule `empty`. `realLink` asks for a real file symlink on disk; otherwise the
 * link is a plain file holding the target, as Git writes it with core.symlinks=false (the Windows default).
 */
async function fixture(t, realLink = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), "opencode-s14-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), storage = path.join(base, "snapshots");
  await mkdir(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.symlinks", String(realLink)]);
  await writeFile(path.join(root, "a.txt"), "baseline\n");
  git(root, ["add", "a.txt"]);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "a.txt");
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},link`]);
  if (realLink) await symlink("a.txt", path.join(root, "link"), "file");
  else await writeFile(path.join(root, "link"), "a.txt");
  const module = path.join(root, "module");
  await mkdir(module);
  git(module, ["init", "--quiet"]);
  await writeFile(path.join(module, "inner.txt"), "inner\n");
  git(module, ["add", "."]);
  commit(module, "inner");
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${git(module, ["rev-parse", "HEAD"])},module`]);
  await mkdir(path.join(root, "empty"));
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${git(module, ["rev-parse", "HEAD"])},empty`]);
  commit(root, "fixture");
  return { root, storage, module };
}

test("S14 C4: an untouched tracked symlink and submodules do not block snapshot and restore", async t => {
  const { root, storage, module } = await fixture(t);
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  try {
    assert.ok(snapshot.manifest.some(entry => entry.path === "a.txt"));
    for (const special of ["link", "module", "empty"]) {
      assert.ok(!snapshot.manifest.some(entry => entry.path === special || entry.path.startsWith(special + "/")), special);
    }
    await writeFile(path.join(root, "a.txt"), "model edit\n");
    await writeFile(path.join(root, "new.txt"), "created by the model\n");
    assert.deepEqual(await createdFiles(snapshot), ["new.txt"]);
    const report = await restoreSnapshot(snapshot);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.restored, ["a.txt"]);
    assert.deepEqual(report.removed, ["new.txt"]);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "baseline\n");
    assert.equal(await readFile(path.join(root, "link"), "utf8"), "a.txt");
    assert.equal(await readFile(path.join(module, "inner.txt"), "utf8"), "inner\n");
  } finally { await discardSnapshot(snapshot); }
});

test("S14 C4: a real file symlink that stays untouched is accepted (skipped without symlink privilege)", async t => {
  let f;
  try { f = await fixture(t, true); }
  catch (err) { if (err.code === "EPERM") { t.skip("File symlinks need Windows developer mode or privilege"); return; } throw err; }
  const { root, storage } = f;
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  try {
    await writeFile(path.join(root, "b.txt"), "created\n");
    const report = await restoreSnapshot(snapshot);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.removed, ["b.txt"]);
    assert.ok((await lstat(path.join(root, "link"))).isSymbolicLink());
    assert.equal(await readlink(path.join(root, "link")), "a.txt");
  } finally { await discardSnapshot(snapshot); }
});

test("S14 C4: a changed symlink or submodule is reported as a restore failure and left as it is", async t => {
  const { root, storage, module } = await fixture(t);
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  try {
    await writeFile(path.join(root, "a.txt"), "model edit\n");
    await writeFile(path.join(root, "link"), "elsewhere.txt");
    await writeFile(path.join(module, "inner.txt"), "changed inside the submodule\n");
    await writeFile(path.join(root, "empty", "planted.txt"), "planted\n");
    const report = await restoreSnapshot(snapshot);
    const failed = report.failed.map(entry => entry.path).sort();
    assert.deepEqual(failed, ["empty", "link", "module"]);
    assert.deepEqual(report.restored, ["a.txt"]);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "baseline\n");
    // Never rewritten by the bridge: the owner decides.
    assert.equal(await readFile(path.join(root, "link"), "utf8"), "elsewhere.txt");
    assert.equal(await readFile(path.join(module, "inner.txt"), "utf8"), "changed inside the submodule\n");
    assert.equal(await readFile(path.join(root, "empty", "planted.txt"), "utf8"), "planted\n");
  } finally { await discardSnapshot(snapshot); }
});

test("S14 C4: untracked links and untracked nested repositories are still refused", async t => {
  const { root, storage } = await fixture(t);
  await mkdir(path.join(root, "nested"));
  git(path.join(root, "nested"), ["init", "--quiet"]);
  await writeFile(path.join(root, "nested", "file"), "nested");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
});

test("S14 C5: redaction keeps type annotations and Git SHAs, and still hides real values", () => {
  const sha1 = "3f68133a1b2c3d4e5f60718293a4b5c6d7e8f901";
  const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const output = [
    "src/config.ts(12,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    "  key: string;",
    "  token: string | undefined;",
    "  password: boolean,",
    "  secret: unknown",
    `HEAD is now at ${sha1}`,
    `sha256 ${sha256}`,
  ].join("\n");
  const redacted = redactSecrets(output);
  for (const kept of ["key: string", "token: string", "password: boolean", "secret: unknown", sha1, sha256]) {
    assert.ok(redacted.includes(kept), `${kept} was hidden: ${redacted}`);
  }
  for (const secret of ["key: hunter2xyz", "token: abc12345", "password: string-but-longer9", "API_KEY=string",
    `session_id=${sha256}`, `session_id: ${sha256}`, `SESSION=${sha1}`]) {
    const value = secret.split(/[:=]\s*/).pop();
    assert.ok(!redactSecrets(secret).includes(value), `${secret} leaked`);
  }
});

test("S14 C6: a passing check that prints 2 MiB passes, with a bounded, redacted rolling tail", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-s14-verify-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const source = 'const line = "progress ".repeat(127) + "\\n"; let n = 0;' +
    'function more() { while (n < 2200) { n++; if (!process.stdout.write(line)) { process.stdout.once("drain", more); return; } }' +
    ' process.stdout.write("API_TOKEN=private-value\\nEND-OF-OUTPUT\\n"); process.stderr.write("e".repeat(1100000) + "\\nSTDERR-END\\n"); }' +
    "more();";
  const result = await runVerification({ command: process.execPath, args: ["-e", source], timeoutSeconds: 60 }, root);
  assert.equal(result.killedForOutput, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, true);
  assert.ok(Buffer.byteLength(result.stdoutTail) <= 8192 && Buffer.byteLength(result.stderrTail) <= 8192);
  assert.match(result.stdoutTail, /END-OF-OUTPUT\n$/);
  assert.match(result.stderrTail, /STDERR-END\n$/);
  assert.doesNotMatch(result.stdoutTail, /private-value/);
});

// Review round (Codex GPT-6.2-Astra high): baselines whose later changes could not be detected are refused.
test("S14 review: a dirty or non-empty submodule baseline is refused, so any later change is detectable", async t => {
  const { root, storage, module } = await fixture(t);
  await writeFile(path.join(module, "inner.txt"), "already dirty\n");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
  git(module, ["checkout", "--", "inner.txt"]);
  await writeFile(path.join(module, "untracked.txt"), "untracked\n");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
  await rm(path.join(module, "untracked.txt"));
  await writeFile(path.join(root, "empty", "stray.txt"), "stray\n");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
  await rm(path.join(root, "empty", "stray.txt"));
  await discardSnapshot(await takeSnapshot(root, { snapshotBase: storage }));
});

test("S14 review: a regular path that differs from a special path only by letter case is refused", async t => {
  const { root, storage } = await fixture(t);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "other\n");
  git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},LINK`]);
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
});

test("S14 review: a conflicted (non-zero stage) symlink or submodule entry is refused", async t => {
  const { root, storage } = await fixture(t);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "a.txt");
  const regular = git(root, ["hash-object", "-w", "--stdin"], "regular\n");
  git(root, ["update-index", "--index-info"], `0 ${"0".repeat(40)}\tconflict\n120000 ${blob} 2\tconflict\n100644 ${regular} 3\tconflict\n`);
  await writeFile(path.join(root, "conflict"), "regular\n");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
});

test("S14 review: a real tracked symlink whose target leaves the checkout is refused (skipped without symlink privilege)", async t => {
  const { root, storage } = await fixture(t);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "../outside.txt");
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},escape`]);
  try { await symlink("../outside.txt", path.join(root, "escape"), "file"); }
  catch (err) { if (err.code === "EPERM") { t.skip("File symlinks need Windows developer mode or privilege"); return; } throw err; }
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), err => err?.kind === "snapshot_unsupported");
});
