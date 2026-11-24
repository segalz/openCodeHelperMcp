#!/usr/bin/env node
// Linux end-to-end smoke (plan S7.1). Runs on the supervisor VM only, never in CI.
// Starts `node src/index.js` over stdio and calls list_free_models, analyze_code,
// apply_opencode_edits and an out-of-root analyze_code. After each call the number
// of `opencode` processes must return to its value before the call.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFERRED = process.env.SMOKE_MODEL || "opencode/deepseek-v4.1-flash-free";

function countOpencode() {
  const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return out.split("\n").filter(l => /(^|\/|\s)opencode(\.exe)?(\s|$)/.test(l)).length;
}
async function settle(before, label) {
  for (let i = 0; i < 60; i++) {
    const now = countOpencode();
    if (now === before) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label}: opencode process count did not return to ${before} (now ${countOpencode()})`);
}
function text(result) { return (result.content ?? []).map(c => c.text ?? "").join("\n"); }
function check(cond, msg) { if (!cond) throw new Error(msg); console.log("ok -", msg); }

const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "oc-smoke-"));
const outside = await mkdtemp(path.join(os.tmpdir(), "oc-outside-"));
const repo = path.join(smokeRoot, "repo");
await mkdir(repo);
const git = (...args) => execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
git("init", "-q");
await writeFile(path.join(repo, "README.md"), "# smoke\n");
await writeFile(path.join(repo, "add.js"), "export function add(a, b) { return a + b; }\n");
git("add", "."); git("commit", "-qm", "init");

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(repoRoot, "src", "index.js")], cwd: repoRoot,
  env: { ...process.env, OPENCODE_HELPER_ALLOWED_ROOTS: smokeRoot, OPENCODE_HELPER_SERVE: "0" }, stderr: "inherit",
});
const client = new Client({ name: "linux-smoke", version: "1.0.0" });
let failed = false;
try {
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });

  let before = countOpencode();
  const listed = await call("list_free_models", { probe: true });
  await settle(before, "list_free_models");
  const listText = text(listed);
  check(!listed.isError && /free/i.test(listText), "list_free_models (probe) answered");
  const ids = [...listText.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
  const model = ids.includes(PREFERRED) ? PREFERRED : ids[0];
  check(!!model, `a free model is available (${model})`);

  before = countOpencode();
  const analyzed = await call("analyze_code", { directory: repo, prompt: "What does add.js export? Answer in one sentence.", maxWords: 60, model });
  await settle(before, "analyze_code");
  check(!analyzed.isError && text(analyzed).length > 0, "analyze_code answered inside the smoke root");

  before = countOpencode();
  const edited = await call("apply_opencode_edits", { directory: repo, prompt: "add the word hello to README.md", model,
    verify: { command: "node", args: ["-e", "process.exit(require('fs').readFileSync('README.md','utf8').includes('hello')?0:1)"] } });
  await settle(before, "apply_opencode_edits");
  const readme = await readFile(path.join(repo, "README.md"), "utf8");
  check(!edited.isError && readme.includes("hello"), "apply_opencode_edits added hello and the check passed");

  before = countOpencode();
  const refused = await call("analyze_code", { directory: outside, prompt: "List the files.", maxWords: 60, model });
  await settle(before, "analyze_code outside");
  check(refused.isError || /outside|allowed root/i.test(text(refused)), "analyze_code outside the smoke root was refused");
  console.log("SMOKE PASS");
} catch (error) {
  failed = true;
  console.error("SMOKE FAIL:", error?.message ?? error);
} finally {
  await client.close().catch(() => {});
  await rm(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(outside, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
