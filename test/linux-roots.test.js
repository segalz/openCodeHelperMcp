import assert from "node:assert/strict";
import test from "node:test";
import { configuredRoots } from "../src/roots.js";

test("win32 default stays C:\\Develop", () => {
  assert.deepEqual(configuredRoots({ env: {}, platform: "win32", homedir: "C:\\Users\\u" }), ["C:\\Develop"]);
});
test("win32 list splits on ';', trims and resolves", () => {
  assert.deepEqual(configuredRoots({ env: { OPENCODE_HELPER_ALLOWED_ROOTS: "C:\\a; D:\\b\\ ;" }, platform: "win32", homedir: "C:\\Users\\u" }),
    ["C:\\a", "D:\\b"]);
});
test("linux default is ~/Develop", () => {
  assert.deepEqual(configuredRoots({ env: {}, platform: "linux", homedir: "/home/u" }), ["/home/u/Develop"]);
});
test("linux list splits on ':', trims and resolves", () => {
  assert.deepEqual(configuredRoots({ env: { OPENCODE_HELPER_ALLOWED_ROOTS: "/srv/a: /home/u/b/ :" }, platform: "linux", homedir: "/home/u" }),
    ["/srv/a", "/home/u/b"]);
});
test("an empty variable still means no roots (unchanged)", () => {
  assert.deepEqual(configuredRoots({ env: { OPENCODE_HELPER_ALLOWED_ROOTS: "" }, platform: "linux", homedir: "/home/u" }), []);
});
