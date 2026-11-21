import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SNAPSHOT_RETENTION_MS, defaultSnapshotBase, sweepOldSnapshots } from "../src/snapshot.js";

// after-bridges D1: kept recovery snapshots must not pile up forever; same rule as ClineMcp.
const DAY = 86_400_000;
const OLD = "0bdf2f6a-2b0b-4768-a700-8b169f4e8c49";
const FRESH = "3d758bf8-3bb6-4058-9888-5ca87f37d0cf";

async function folder(base, name, ageDays, now) {
  await mkdir(path.join(base, name));
  await writeFile(path.join(base, name, "manifest.json"), "{}");
  const when = new Date(now - ageDays * DAY);
  await utimes(path.join(base, name), when, when);
}

test("D1: only snapshot folders older than the retention are removed", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-sweep-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const now = Date.now();
  await folder(base, OLD, 15, now);
  await folder(base, FRESH, 3, now);
  await folder(base, "not-a-snapshot", 30, now);
  await writeFile(path.join(base, "loose-file.txt"), "kept");
  assert.equal(SNAPSHOT_RETENTION_MS, 14 * DAY);
  const removed = await sweepOldSnapshots(base, { now: () => now });
  assert.deepEqual(removed, [OLD]);
  assert.deepEqual((await readdir(base)).sort(), [FRESH, "loose-file.txt", "not-a-snapshot"].sort());
});

test("D1: a missing base or a custom retention is handled", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-sweep-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.deepEqual(await sweepOldSnapshots(path.join(base, "missing")), []);
  const now = Date.now();
  await folder(base, FRESH, 3, now);
  assert.deepEqual(await sweepOldSnapshots(base, { now: () => now, maxAgeMs: 2 * DAY }), [FRESH]);
});

test("D1: the default snapshot base honours CLINE_MCP_SNAPSHOT_DIR, like ClineMcp", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-sweep-"));
  const previous = process.env.CLINE_MCP_SNAPSHOT_DIR;
  process.env.CLINE_MCP_SNAPSHOT_DIR = base;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = previous;
    await rm(base, { recursive: true, force: true });
  });
  assert.equal(defaultSnapshotBase(), path.resolve(base));
  const now = Date.now();
  await folder(base, OLD, 20, now);
  assert.deepEqual(await sweepOldSnapshots(undefined, { now: () => now }), [OLD]);
  delete process.env.CLINE_MCP_SNAPSHOT_DIR;
  assert.equal(defaultSnapshotBase(), path.resolve(path.join(os.tmpdir(), "cline-mcp-snapshots")));
});
