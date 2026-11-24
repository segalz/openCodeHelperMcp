import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as core from "../src/core.js";

test("childEnv adds no relative PATH entry when APPDATA is unset", () => {
  const exec = path.resolve("nodedir", "node");
  const env = core.childEnv({ PATH: path.resolve("p1") }, exec);
  const entries = env.PATH.split(path.delimiter);
  assert.ok(entries.every((entry) => path.isAbsolute(entry)), entries.join(" | "));
  assert.deepEqual(entries, [path.dirname(exec), path.resolve("p1")]);
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
});
test("childEnv keeps the APPDATA npm folder first when APPDATA is set", () => {
  const appdata = path.resolve("appdata-test");
  const exec = path.resolve("nodedir", "node");
  const env = core.childEnv({ APPDATA: appdata, PATH: path.resolve("p1") }, exec);
  assert.deepEqual(env.PATH.split(path.delimiter), [path.join(appdata, "npm"), path.dirname(exec), path.resolve("p1")]);
});
