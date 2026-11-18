import assert from "node:assert/strict";
import test from "node:test";
import { confirmTreeDead, treeDescendants, CREATION_SLACK_MS } from "../src/proctree.js";

// Plan S3 review fixes: the confirmed tree kill must never reach an unrelated process through a reused PID,
// must not call "unknown descendants" confirmed, and must report what is still alive at the cap.
// Mirrors ClineMcp src/test/plan-s3-proctree.test.ts.

const ROOT = 5000;
const START = 1_000_000;

test("S3 review: a process whose parent PID matches the root but predates our spawn is not ours", () => {
  const table = [
    { pid: ROOT, parentPid: 1, createdMs: START + 5 },
    { pid: 6001, parentPid: ROOT, createdMs: START - 3_600_000 }, // e.g. explorer.exe, child of a long-dead userinit
    { pid: 6002, parentPid: 6001, createdMs: START + 10 },        // its child: unrelated as well
    { pid: 7001, parentPid: ROOT, createdMs: START + 50 },         // our real child
    { pid: 7002, parentPid: 7001, createdMs: START + 60 },         // our grandchild
    { pid: 7003, parentPid: 7001, createdMs: START + 40 },         // created before its "parent": a reused PID's child
  ];
  assert.deepEqual(treeDescendants(ROOT, table, { rootStartedMs: START, selfPid: 1 }).sort(), [7001, 7002]);
});

test("S3 review: after the root exited, children created later belong to whoever reused its PID", () => {
  const exited = START + 1_000;
  const table = [
    { pid: ROOT, parentPid: 1, createdMs: exited + 5_000 },
    { pid: 7001, parentPid: ROOT, createdMs: START + 100 },
    { pid: 8001, parentPid: ROOT, createdMs: exited + CREATION_SLACK_MS + 6_000 },
  ];
  assert.deepEqual(treeDescendants(ROOT, table, { rootStartedMs: START, rootExitedMs: exited, selfPid: 1 }), [7001]);
});

test("S3 review: an unreadable process list is reported as unverified, never as confirmed", async () => {
  let reads = 0;
  const result = await confirmTreeDead(ROOT, {
    platform: "win32", killRoot: () => {}, isRootAlive: () => false, rootStartedMs: START,
    listTable: async () => { reads++; return null; }, isAlive: () => false, killPid: () => {}, pollMs: 5, capMs: 2_000,
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.unverified, true);
  assert.equal(reads, 2, "the list is read once more before giving up");
});

test("S3 review: at the cap the still-living descendants are reported", async () => {
  const killed = [];
  const result = await confirmTreeDead(ROOT, {
    platform: "win32", killRoot: () => {}, isRootAlive: () => false, rootStartedMs: START,
    listTable: async () => [{ pid: 7001, parentPid: ROOT, createdMs: START + 10 }],
    isAlive: pid => pid === 7001, killPid: pid => { killed.push(pid); }, pollMs: 5, capMs: 100,
  });
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.alive, [7001]);
  assert.ok(killed.length > 0 && killed.every(pid => pid === 7001));
});

test("S3 review: a descendant seen dead once is never killed again, and an exited root is never killed by PID", async () => {
  const aliveAnswers = new Map([[7001, [true, false, true, true, true]]]);
  const killed = [];
  let rootKills = 0;
  const result = await confirmTreeDead(ROOT, {
    platform: "win32", killRoot: () => { rootKills++; }, isRootAlive: () => false, rootStartedMs: START,
    listTable: async () => [{ pid: 7001, parentPid: ROOT, createdMs: START + 10 }],
    isAlive: pid => aliveAnswers.get(pid)?.shift() ?? false, killPid: pid => { killed.push(pid); }, pollMs: 5, capMs: 1_000,
  });
  assert.equal(result.confirmed, true);
  assert.deepEqual(killed, [7001], "killed while alive, then forgotten once seen dead (its PID may be reused)");
  assert.equal(rootKills, 0, "the root already exited: its PID must not be killed");
});
