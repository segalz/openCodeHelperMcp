import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildCodeMap } from "../src/codemap.js";

// Plan S9 (B7, B8): one deleted tracked file must not drop the whole map, and a structural map that fits
// its budget is kept even when its JSON envelope is longer than the budget.

function fakeChild(output = "", code = 0) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 12345; child.unref = () => {};
  setImmediate(() => { child.stdout.end(output); child.emit("close", code); });
  return child;
}

async function fixture(t, { tracked, script }) {
  const base = await mkdtemp(path.resolve(".s9-codemap-test-")), root = path.join(base, "repo"), cli = path.join(base, "fake cli.mjs");
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(root, "main.js"), "export function kept() {}\n");
  await writeFile(path.join(root, "other.js"), "export function alsoKept() {}\n");
  if (script) await writeFile(cli, script);
  const env = { ...process.env };
  if (script) env.CODEINDEX_CLI = cli; else delete env.CODEINDEX_CLI;
  const sources = [];
  const options = {
    env, onSource: (source) => sources.push(source),
    spawnImpl: (exe, args, opts) => args.includes("ls-files") ? fakeChild(tracked.map((file) => `${file}\0`).join("")) : spawn(exe, args, opts),
  };
  return { root, options, sources };
}

test("S9 B7: a tracked file deleted from the working tree is skipped; the rest of the map is built", async (t) => {
  const f = await fixture(t, { tracked: ["gone.js", "main.js", "other.js"] });
  const map = await buildCodeMap(f.root, f.options);
  assert.ok(map, "the map must not be dropped");
  assert.match(map, /main\.js/);
  assert.match(map, /other\.js/);
  assert.doesNotMatch(map, /gone\.js/);
  assert.deepEqual(f.sources, ["regex"]);
});

test("S9 B7: a tracked path that became a folder is skipped too", async (t) => {
  const f = await fixture(t, { tracked: ["main.js", "now-a-dir.js/inner.js"] });
  await writeFile(path.join(f.root, "now-a-dir.js"), "a file where Git expects a folder\n");
  const map = await buildCodeMap(f.root, f.options);
  assert.match(map ?? "", /main\.js/);
});

const envelope = (map) => ({ schemaVersion: 2, command: "map", referencesAreCandidates: true, truncated: false, anchors: [], map });

test("S9 B8: a 5,990-char structural map in a longer JSON envelope fits a 6,000 budget and is kept", async (t) => {
  const reply = JSON.stringify(envelope("x".repeat(5_990)));
  assert.ok(reply.length > 6_000, "the envelope itself is over the budget");
  const f = await fixture(t, { tracked: ["main.js"], script: `console.log(${JSON.stringify(reply)})` });
  const map = await buildCodeMap(f.root, f.options);
  assert.equal(map?.length, 5_990);
  assert.deepEqual(f.sources, ["codeindex"]);
});

test("S9 B8: a structural map longer than the budget is still refused (regex fallback)", async (t) => {
  const reply = JSON.stringify(envelope("x".repeat(6_001)));
  const f = await fixture(t, { tracked: ["main.js"], script: `console.log(${JSON.stringify(reply)})` });
  const map = await buildCodeMap(f.root, f.options);
  assert.deepEqual(f.sources, ["regex"]);
  assert.match(map ?? "", /main\.js/);
});
