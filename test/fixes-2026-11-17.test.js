// Regression tests for the 2026-11-17 production failures (real multi-file review and checked edit).
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGuard, guardSchema } from "../src/guard.js";
import { providerLimitError } from "../src/core.js";
import { headAndIndexIdentity } from "../src/snapshot.js";
import { runEdits } from "../src/edits.js";

async function gitRepo(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "opencode-fixes-test-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }).catch(() => {}); });
  const root = path.join(base, "repo");
  const git = (...args) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", root]);
  await writeFile(path.join(root, "main.js"), "export const a = 1;\n");
  git("add", "."); git("commit", "-qm", "init");
  return { base, root, git };
}

test("guard trips on a model looping on an unavailable tool even with different targets", () => {
  const guard = createGuard(guardSchema.parse({}));
  let verdict = null;
  for (const command of ["pytest -q", "dir", "echo test"]) {
    verdict = guard.observe({ type: "tool", tool: "bash", status: "error", input: { command },
      error: "Model tried to call unavailable tool 'invalid'. Available tools: edit, glob, grep, read, write." });
  }
  assert.equal(verdict?.kind, "loop_detected");
});

test("different failing commands that are not unavailable-tool errors do not trip the loop guard", () => {
  const guard = createGuard(guardSchema.parse({}));
  let verdict = null;
  for (const command of ["a", "b", "c"]) {
    verdict = guard.observe({ type: "tool", tool: "bash", status: "error", input: { command }, error: "Command exited with code 1" });
  }
  assert.equal(verdict, null);
});

test("provider 503 overload is classified as a rate limit", () => {
  const line = 'level=ERROR msg="stream error" error.error="AI_APICallError: [503] Service temporarily overloaded"';
  assert.equal(providerLimitError(line)?.kind, "rate_limit");
});

test("a stat-only index refresh keeps the checkout identity; staging a change does not", async (t) => {
  const r = await gitRepo(t);
  const before = await headAndIndexIdentity(r.root);
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(r.root, "main.js"), later, later);
  r.git("status", "--short");
  assert.deepEqual(await headAndIndexIdentity(r.root), before);
  await writeFile(path.join(r.root, "main.js"), "export const a = 2;\n");
  r.git("add", "main.js");
  assert.notEqual((await headAndIndexIdentity(r.root)).indexHash, before.indexHash);
});

test("an exhausted edit deadline is reported as budget_exceeded, never as cancelled", async (t) => {
  const r = await gitRepo(t);
  const result = await runEdits(
    { directory: r.root, prompt: "Fix", model: "opencode/test-free", verify: { none: true, reason: "deadline regression test" }, codeMap: false },
    {
      lockDirectory: path.join(r.base, "locks"), snapshotOptions: { snapshotBase: path.join(r.base, "snapshots") },
      deadline: Date.now() + 1500,
      runner: async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ error: "OpenCode run cancelled." }), { once: true });
      }),
    },
  );
  assert.equal(result.error, "budget_exceeded");
  assert.equal(result.verification.restored, true);
});

test("through the tool entry point, an exhausted budget is budget_exceeded, not cancelled", async (t) => {
  const { registerEditTools } = await import("../src/edits.js");
  const r = await gitRepo(t);
  let handler;
  const server = { registerTool: (_name, _meta, fn) => { handler = fn; } };
  const catalog = { list: async () => ({ models: [{ id: "opencode/test-free", provider: "opencode", name: "test" }] }) };
  registerEditTools(server, {
    catalog, resolveAllowedPath: async (p) => p,
    runner: async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ error: "OpenCode run cancelled." }), { once: true });
    }),
    lifecycleOptions: { lockDirectory: path.join(r.base, "locks"), snapshotOptions: { snapshotBase: path.join(r.base, "snapshots") } },
  });
  const response = await handler({ directory: r.root, prompt: "Fix", model: "opencode/test-free", budgetMs: 30000,
    verify: { none: true, reason: "deadline regression test" }, codeMap: false }, {});
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.error, "budget_exceeded", result.message);
});

