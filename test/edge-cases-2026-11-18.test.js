import assert from "node:assert/strict";

import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createdFiles, discardSnapshot, restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { holderIsDead, processStartMs } from "../src/checkoutlock.js";

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {}); });

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-edge-test-"));
  roots.push(root);
  const git = (...args) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  git("init", "-q");
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  await writeFile(path.join(root, "notes.txt"), "untracked baseline\n");
  return root;
}
const snapshotBase = () => path.join(os.tmpdir(), "opencode-edge-snapshots");

test("restore undoes a .gitignore edit that hid a new file and a changed baseline file", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await writeFile(path.join(root, ".gitignore"), "dist/\nsecret.txt\nnotes.txt\n");
  await writeFile(path.join(root, "secret.txt"), "new file the model hid\n");
  await writeFile(path.join(root, "notes.txt"), "changed by the model\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "secret.txt")), false);
  assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "untracked baseline\n");
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "dist/\n");
});

test("restore removes a self-ignoring .gitignore the model created, and the files it hid", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await mkdir(path.join(root, "scratch"));
  await writeFile(path.join(root, "scratch", ".gitignore"), "*\n");
  await writeFile(path.join(root, "scratch", "debug_test.py"), "print(1)\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "scratch")), false);
});

test("restore keeps .gitignore files that were already present inside ignored folders", async () => {
  const root = await repo();
  await mkdir(path.join(root, "dist", "pkg"), { recursive: true });
  await writeFile(path.join(root, "dist", "pkg", ".gitignore"), "*.log\n");
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "dist", "pkg", ".gitignore")), true);
});

test("restore undoes an info/exclude edit and removes the file it hid", async () => {
  const root = await repo();
  const exclude = path.join(root, ".git", "info", "exclude");
  const before = existsSync(exclude) ? await readFile(exclude, "utf8") : null;
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await mkdir(path.dirname(exclude), { recursive: true });
  await writeFile(exclude, "hidden.txt\n");
  await writeFile(path.join(root, "hidden.txt"), "x\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "hidden.txt")), false);
  assert.equal(existsSync(exclude) ? await readFile(exclude, "utf8") : null, before);
});

test("createdFiles lists new files and skips ignored build output", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await writeFile(path.join(root, "debug_test.py"), "print(1)\n");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "out.js"), "1\n");
  await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  assert.deepEqual(await createdFiles(handle), ["debug_test.py"]);
  await discardSnapshot(handle);
});

test("a lock whose PID now belongs to a newer process is dead; unknown start time stays busy", async () => {
  const pid = process.ppid;
  const written = new Date(Date.now() - 60_000).toISOString();
  assert.equal(await holderIsDead({ pid, time: written }, () => Date.now()), true);
  assert.equal(await holderIsDead({ pid, time: written }, () => Date.now() - 3_600_000), false);
  assert.equal(await holderIsDead({ pid, time: written }, () => undefined), false);
  assert.equal(await holderIsDead({ pid }, () => Date.now()), false);
  assert.equal(await holderIsDead({ pid: process.pid, time: written }, () => Date.now()), false);
});

test("processStartMs reads this process's real start time", { skip: !["win32", "linux"].includes(process.platform) }, async () => {
  const started = await processStartMs(process.pid);
  assert.ok(started !== undefined);
  assert.ok(Math.abs(started - (Date.now() - process.uptime() * 1000)) < 10_000, String(started));
});

