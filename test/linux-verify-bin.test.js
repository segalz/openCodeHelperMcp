import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveVerificationCommand } from "../src/verify.js";

test("posix: a bare tool resolves to the nearest node_modules/.bin, PATH still works", { skip: process.platform === "win32" && "POSIX behaviour" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verify-bin-"));
  const bin = path.join(root, "node_modules", ".bin");
  const pathDir = path.join(root, "pathdir");
  await mkdir(path.join(root, ".git"));
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, "pkg", "sub"), { recursive: true });
  await mkdir(pathDir);
  await writeFile(path.join(bin, "mytool"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, "mytool"), 0o755);
  await writeFile(path.join(bin, "plain"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, "plain"), 0o644);
  await writeFile(path.join(pathDir, "pathtool"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(pathDir, "pathtool"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = pathDir;
  try {
    assert.deepEqual(await resolveVerificationCommand("mytool", ["a"], path.join(root, "pkg", "sub")),
      { command: path.join(bin, "mytool"), args: ["a"] });
    assert.deepEqual(await resolveVerificationCommand("pathtool", [], root), { command: "pathtool", args: [] });
    await assert.rejects(resolveVerificationCommand("plain", [], root), (e) => e?.kind === "verification_launch_failed");
    await assert.rejects(resolveVerificationCommand("nosuchtool-xyz", [], root), (e) => e?.kind === "verification_launch_failed");
  } finally { process.env.PATH = savedPath; }
});
