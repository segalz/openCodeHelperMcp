import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveVerificationCommand } from "../src/verify.js";

test("posix: bare npm/npx skip the project-local node_modules/.bin, as on Windows", { skip: process.platform === "win32" && "POSIX behaviour" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verify-npm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "node_modules", ".bin");
  const pathDir = path.join(root, "pathdir");
  await mkdir(path.join(root, ".git"));
  await mkdir(bin, { recursive: true });
  await mkdir(pathDir);
  for (const dir of [bin, pathDir]) {
    for (const name of ["npm", "npx", "mytool"]) {
      await writeFile(path.join(dir, name), "#!/bin/sh\nexit 0\n"); await chmod(path.join(dir, name), 0o755);
    }
  }
  const savedPath = process.env.PATH;
  process.env.PATH = pathDir;
  try {
    assert.deepEqual(await resolveVerificationCommand("npm", ["test"], root), { command: "npm", args: ["test"] });
    assert.deepEqual(await resolveVerificationCommand("npx", ["tsc"], root), { command: "npx", args: ["tsc"] });
    assert.deepEqual(await resolveVerificationCommand("mytool", [], root), { command: path.join(bin, "mytool"), args: [] });
  } finally { process.env.PATH = savedPath; }
});
