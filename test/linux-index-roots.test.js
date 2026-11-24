import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("index.js takes its roots from roots.js", async () => {
  const text = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(text, /import \{ configuredRoots \} from "\.\/roots\.js";/);
  assert.doesNotMatch(text, /DEFAULT_ALLOWED_ROOT/);
  assert.doesNotMatch(text, /\.split\(";"\)/);
});
