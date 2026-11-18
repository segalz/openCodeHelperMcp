import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEdits, subfolderOf } from "../src/edits.js";
import { symlink } from "node:fs/promises";
import { permissionEnvironment } from "../src/permissions.js";

// Plan S5 (review item A6): when `directory` is a monorepo subfolder, the checkout lock, identity and snapshot
// stay at the repository root, but OpenCode and the final check run in the requested subfolder.
// Mirrors ClineMcp src/test/plan-s5-monorepo.test.ts.

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "opencode-s5-")));
after(async () => { await rm(base, { recursive: true, force: true }).catch(() => {}); });

async function monorepo() {
  const root = await mkdtemp(path.join(base, "repo-"));
  const app = path.join(root, "packages", "app");
  await mkdir(app, { recursive: true });
  return { root, app };
}

test("S5: lock, identity and snapshot use the repository root; the runner and the check use the subfolder", async () => {
  const { root, app } = await monorepo();
  const seen = { identity: [], snapshot: [], ignored: [], runner: [], verify: [], resolve: [] };
  const out = await runEdits({
    directory: app, prompt: "Fix it", model: "opencode/test-free", codeMap: false,
    verify: { command: process.execPath, args: ["-e", "process.exit(0)"] },
  }, {
    lockDirectory: path.join(base, "locks"),
    resolveRoot: async () => root,
    identityImpl: async dir => { seen.identity.push(dir); return { head: "h", indexHash: "i" }; },
    takeSnapshotImpl: async dir => { seen.snapshot.push(dir); return { directory: path.join(base, "snap"), manifest: [] }; },
    discardSnapshotImpl: async () => {},
    createdFilesImpl: async () => [],
    ignoredPathsImpl: async dir => { seen.ignored.push(dir); return []; },
    resolveVerifyImpl: async (command, args, cwd) => { seen.resolve.push(cwd); return { command, args }; },
    verifyImpl: async (_spec, cwd) => { seen.verify.push(cwd); return { passed: true, exitCode: 0, signal: null, timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }; },
    runner: async call => { seen.runner.push({ directory: call.directory, checkoutRoot: call.checkoutRoot }); return { text: "done", sessionID: "ses_x" }; },
  });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.ok(seen.identity.length > 0 && seen.identity.every(dir => dir === root), "identity is checked at the repository root");
  assert.deepEqual(seen.snapshot, [root], "the snapshot covers the whole repository");
  assert.deepEqual(seen.ignored, [root]);
  assert.deepEqual(seen.runner, [{ directory: app, checkoutRoot: root }], "OpenCode runs in the subfolder and knows the checkout root");
  assert.deepEqual(seen.verify, [app], "the check runs in the subfolder");
  assert.deepEqual(seen.resolve, [app], "the check is resolved where it will run");
});

test("S5: ignored-path denials are anchored at the checkout root, not at the subfolder", () => {
  const root = path.join(base, "anchored");
  const env = permissionEnvironment({}, "edits", ["packages/app/.env", "secrets/"], root);
  const profile = JSON.parse(env.OPENCODE_PERMISSION);
  const rootSlash = root.replaceAll("\\", "/");
  assert.equal(profile.edit[`${rootSlash}/packages/app/.env`], "deny");
  assert.equal(profile.read[`${rootSlash}/secrets/*`], "deny");
  assert.equal(profile.read[`${rootSlash}/packages/app/packages/app/.env`], undefined);
});

test("S5: the OpenCode runner works and maps in the subfolder, with denials anchored at the checkout root", async () => {
  const { createOpenCodeRunner } = await import("../src/core.js");
  const { EventEmitter } = await import("node:events");
  const { root, app } = await monorepo();
  const mapped = [], launches = [];
  const runner = createOpenCodeRunner({
    codeMapBuilder: async dir => { mapped.push(dir); return "MAP"; },
    spawnImpl: (exe, args, options) => {
      launches.push({ cwd: options.cwd, permission: JSON.parse(options.env.OPENCODE_PERMISSION) });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      setImmediate(() => { child.stdout.emit("data", JSON.stringify({ type: "text", sessionID: "ses_x", text: "done" }) + "\n"); child.emit("close", 0); });
      return child;
    },
  });
  const out = await runner({ directory: app, checkoutRoot: root, prompt: "Fix", model: "opencode/test-free", mode: "edits",
    ignoredPaths: ["packages/app/.env"], timeoutMs: 10_000 });
  assert.equal(out.text, "done", JSON.stringify(out));
  assert.deepEqual(mapped, [app], "the map describes the folder OpenCode works in");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, app);
  const rootSlash = root.replaceAll("\\", "/");
  assert.equal(launches[0].permission.edit[`${rootSlash}/packages/app/.env`], "deny");
  assert.equal(launches[0].permission.edit[".env"], "deny", "also denied relative to the subfolder OpenCode works in");
});

test("S5 review: a folder reached through a junction or symlink is inside its checkout", async () => {
  const { root, app } = await monorepo();
  const link = path.join(base, "link-" + path.basename(root));
  await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await subfolderOf(root, path.join(link, "packages", "app")), app);
  assert.equal(await subfolderOf(root, link), root);
  assert.equal(await subfolderOf(app, root), undefined, "a parent folder is outside");
});
