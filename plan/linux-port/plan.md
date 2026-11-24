# openCodeHelperMcp — Linux port plan (branch `linux-support`)

Version 2, 2026-11-24. Written by Claude Opus 5.5 after reading the source. Grok 4.6 reviewed it against the source (6 findings), and all of them are folded in. This file is public: it names no people or private infrastructure.

## 0. Roles

| Role | Who | Does |
|------|-----|------|
| Owner | repository owner | Approves pushes, keys and merges. Only the owner merges to `main`. |
| Supervisor | **Grok Bot**, a cloud agent on its own Linux VM | Installs tools on its VM, applies TEST steps, dispatches executors, runs the Linux check, commits and pushes on `linux-support`, watches CI, follows the retry and escalation rules, updates `progress.md`, and reports each stage. |
| Executors | **Cline CLI** and **OpenCode CLI** with free models, on the supervisor's VM | Do the CODE steps only. They are weak models, so every step is small and self-contained. |
| CI | GitHub Actions, free for this public repo | Runs on every push to `linux-support`: `windows-latest`, `ubuntu-24.04`, `ubuntu-24.04-arm`. |
| Planner / last resort | Claude, through the owner | Wrote this plan. Fixes steps the free executors could not finish. Does the final review. |

## 1. Context

- Stack: plain ESM JavaScript (`src/*.js`), tests in `test/*.test.js`. Run all with `node --test`, or one file with `node --test test/<file>`.
- Targets: Windows (unchanged, all tests green), Linux x86_64 and Linux aarch64. On Linux the server drives a Linux `opencode` (npm `opencode-ai`) with config in `~/.config/opencode`.
- **Key finding:** the code is already largely POSIX-aware:
  - process groups (`detached` + `kill(-pid)`) in `runBoundedProcess`, `defaultKillProcessTree` and `process-utils.js`;
  - the POSIX branch of `confirmTreeDead`;
  - `/proc` start times in `checkoutlock.js`;
  - POSIX verify resolution;
  - `resolveOpenCodeExecutable` falls back to `opencode` on PATH, with an `OPENCODE_BIN` override.
- Windows Job Objects (`jobobject.js`) are Windows-only by design. Process groups replace them on Linux.

## 2. Rules for every step

1. One step changes one function, or adds one new file. The executor changes only the "Files allowed".
2. **Locked files.** Executors never edit:
   - `test/**`, `scripts/**`, `.github/**`;
   - `package.json`, `package-lock.json`, `.gitattributes`;
   - `plan/linux-port/plan.md`.

   `scripts/check-locked.sh` runs inside the Linux check and fails if any of them changed. The supervisor may update `plan/linux-port/progress.md`, `baseline.md` and `discovery.md`.
3. **Test first.**
   1. The supervisor applies the TEST step exactly as written.
   2. It commits it as `linux-port: <id> test (red)`.
   3. It confirms the test is RED with the step's Linux check. If the test is unexpectedly green, stop and report.
4. **Checks.**
   - Linux check on the supervisor's VM: `bash scripts/linux-check.sh <test files>`.
   - Windows and arm64: CI after the push.
5. **No Windows regressions.** Linux behaviour goes behind a platform branch. The Windows branch stays byte-for-byte unchanged.
6. **Restore after a failed attempt:** `git reset --hard HEAD && git clean -fd`.
7. **Accept.** When the Linux check is green, the supervisor reviews the diff:
   - only "Files allowed" changed;
   - Windows code is untouched;
   - no new shell use.

   Then it commits `linux-port: <id> <summary>` and pushes. If CI is red on Windows or arm64:
   1. run `git revert --no-edit HEAD && git push`;
   2. count it as a failed attempt;
   3. put the CI log tail into the next attempt.

   Never force-push.

   **Flaky first** (added 2026-11-25). Before any revert, compare the CI failures with the known-flaky list in `baseline.md` (for example `codeindex.test.js:142` "remaining attempt time bounds the adapter..."). If every new failure is a known-flaky test, run `gh run rerun <run id> --failed` once. Only a failure that repeats on the rerun, or one that is not on the list, leads to a revert. A revert caused by a flake does not count as a failed attempt for the executor.
8. **Retries.** At most 3 attempts per CODE step, then escalate (section 6). Never weaken, skip or edit a test to get green.
9. **Executors** use no git, no installs and no network, and never touch `main`.
10. **Secrets** stay only in the supervisor VM's environment: never in the repo, CI, logs or reports.

Executor command lines, model order, executor alternation and the `/tmp/step.md` template are the same as in the ClineMcp plan (`segalz/ClineMcp`, branch `linux-support`, `plan/linux-port/plan.md` section 2):
- Cline: `cline --json --auto-approve true --thinking high --timeout 1500 -P <provider> -m <model> --cwd "$PWD" "$(cat /tmp/step.md)"`
- OpenCode: `opencode run -m <provider>/<model> "$(cat /tmp/step.md)"`
- Alternate executors by CODE step order. Attempts 2-3 use the same executor. Record the model used.

## 3. Gaps found in the source

| # | Gap | Where | Effect on Linux today |
|---|-----|-------|-----------------------|
| O1 | The default allowed root is `C:\Develop`, and the list is split on `;` | `src/index.js` ~9-14 | Without the env var, every directory is refused (`path.resolve("C:\\Develop")` is a junk relative path on Linux). A `:`-separated list is read as a single path. |
| O2 | `childEnv` puts `path.join(env.APPDATA ?? "", "npm")` on PATH, which is the RELATIVE entry `npm` when APPDATA is unset | `src/core.js` ~170-177 | **Security:** `opencode` is first looked up in `./npm/` of the analysed checkout. A repo containing `npm/opencode` could run code. The same happens on Windows if APPDATA is ever unset. |
| O3 | POSIX verify ignores the project-local `node_modules/.bin` | `src/verify.js` ~32-38 | `verify: {command:"vitest"}` fails unless vitest is on PATH; Windows finds it |
| O4 | Unknown until the baseline run | tests | Real Linux bugs the reading missed |

**Known limitations (recorded, not fixed):**
- `snapshot.js` ~144 and ~169 compare `realpath` with `.toLowerCase()` on every OS. This is a weaker reparse check on case-sensitive file systems, and symlinks are refused earlier anyway.
- `codemap.js` ~20 spawns `git ls-files` without `detached`. Its stop kills only the root, and `git ls-files` has no children.
- A child that calls `setsid()` escapes the process-group kill. S0.5 records whether `opencode` does this.

Out of scope by design:
- `jobobject.js`;
- the Windows command-line limits;
- `.cmd` shim parsing;
- `windowsHide`;
- `rules.js`, whose Linux text is already fine.

## 4. Stages and steps

### Stage 0 — Setup and baseline

**S0.1 · OWNER · Approve** pushing `linux-support` to GitHub (a public repo) and Grok Bot working on it. Done 2026-11-24.

**S0.2 · Claude (one time, before handing over) · Check scripts and CI.** Risk low. Locked afterwards.
- `.gitattributes`:
  ```
  *.sh text eol=lf
  ```
- `scripts/check-locked.sh`:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")/.."
  [ "$(git rev-parse --abbrev-ref HEAD)" = "linux-support" ] || { echo "check-locked: not on linux-support" >&2; exit 2; }
  bad=$(git status --porcelain --untracked-files=all | cut -c4- \
    | grep -E '^(test/|scripts/|\.github/|package\.json$|package-lock\.json$|\.gitattributes$|plan/linux-port/plan\.md$)' || true)
  if [ -n "$bad" ]; then echo "check-locked: locked files changed:" >&2; echo "$bad" >&2; exit 3; fi
  ```
- `scripts/linux-check.sh`:
  ```bash
  #!/usr/bin/env bash
  # Usage: bash scripts/linux-check.sh [test/<file>.test.js ...]   (no args = whole suite)
  set -euo pipefail
  cd "$(dirname "$0")/.."
  bash scripts/check-locked.sh
  if [ "$#" -gt 0 ]; then node --test "$@"; else node --test; fi
  ```
- `.github/workflows/linux-port.yml`: the same as ClineMcp S0.2, without the two "Install Cline CLI" steps. It has the matrix `windows-latest`, `ubuntu-24.04` and `ubuntu-24.04-arm`; Node 22; the `git config` user; `npm ci`; and `npm test`. On Windows the test step runs with `TEMP` and `TMP` set to `${{ runner.temp }}`.
  CI revision 2 (2026-11-24): the first run failed on `windows-latest` before any code change, because the runner's 8.3 short `%TEMP%` (`C:\Users\RUNNER~1`) did not match the long path the code resolves. Known latent Windows issue, out of scope here: path identity can differ between an 8.3 short path and the long path.

Done when it is committed and pushed (after S0.1) and the first CI run has finished.

**S0.3 · SUP · VM and free-model access (the supervisor does this itself).**
- If the ClineMcp plan's S0.3 is already done on this VM, reuse it: Node 22, the CLIs and the working free models. Otherwise do that S0.3 first, following the same text.
- Clone this repo, `git checkout linux-support`, `npm ci`.

Done when `node -v` shows v22 and at least one free model answers through `opencode` and one through `cline`.

**S0.4 · SUP · Baseline.**
- Run `bash scripts/linux-check.sh` (whole suite) and read the first CI run.
- Write `plan/linux-port/baseline.md`: every failing test with its file, name, first error line and class:
  - (a) Windows-only, needs a skip;
  - (b) a real Linux bug, goes to Stage 5;
  - (c) environment.
- GATE: CI `windows-latest` is green, except for explained class (c) items.

**S0.5 · SUP · Discovery** → `plan/linux-port/discovery.md`. Record:
- `readlink -f "$(command -v opencode)"` and its first 200 bytes (JS wrapper or native binary);
- `opencode --version`;
- the first lines `opencode serve --port <p>` prints (the server pool parses its banner: `src/server-pool.js` ~88-99);
- a sample of `opencode models --verbose`, which the catalog parses (`src/core.js` ~833-849);
- `ps -eo pid,ppid,pgid,sid,args` while `opencode serve` and `opencode run` are running. Note any child with its own SID.

GATE: a banner or model-list format that differs from what the parsers expect becomes a Stage 5 pair.

### Stage 1 — Test hygiene

**S1.1 · SUP.** Add `{ skip: process.platform !== "win32" && "Windows-only: <reason>" }` to the class (a) tests. Never skip class (b) tests. Commit and push.

### Stage 2 — Allowed roots on Linux (O1)

**S2.1 · TEST.** Risk low. New file `test/linux-roots.test.js`:
```js
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
```
RED: `src/roots.js` does not exist. Linux check: `bash scripts/linux-check.sh test/linux-roots.test.js`.

**S2.2 · CODE · Create `src/roots.js`.** Risk low. Files allowed: `src/roots.js` (new file only). Exact content:
```js
import os from "node:os";
import path from "node:path";

/** Allowed workspace roots: OPENCODE_HELPER_ALLOWED_ROOTS (';' on Windows, ':' elsewhere) or the default Develop folder. */
export function configuredRoots({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const raw = env.OPENCODE_HELPER_ALLOWED_ROOTS ?? (platform === "win32" ? "C:\\Develop" : p.join(homedir, "Develop"));
  return raw.split(platform === "win32" ? ";" : ":").map((root) => root.trim()).filter(Boolean).map((root) => p.resolve(root));
}
```
Linux check: `bash scripts/linux-check.sh test/linux-roots.test.js`.

**S2.3 · TEST.** Risk low. New file `test/linux-index-roots.test.js`:
```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("index.js takes its roots from roots.js", async () => {
  const text = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(text, /import \{ configuredRoots \} from "\.\/roots\.js";/);
  assert.doesNotMatch(text, /DEFAULT_ALLOWED_ROOT/);
  assert.doesNotMatch(text, /\.split\(";"\)/);
});
```
(`src/index.js` connects stdio when loaded, so this test reads its source text instead of importing it.)

**S2.4 · CODE · Wire `index.js`.** Risk low. Files allowed: `src/index.js`.
Current code (~9-14):
```js
const DEFAULT_ALLOWED_ROOT = "C:\\Develop";

function configuredRoots() {
  return (process.env.OPENCODE_HELPER_ALLOWED_ROOTS ?? DEFAULT_ALLOWED_ROOT)
    .split(";").map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
}
```
Required change:
- delete these lines;
- add `import { configuredRoots } from "./roots.js";` after the other imports;
- delete `import path from "node:path";` (line 1, now unused).

`resolveAllowedPath` keeps calling `configuredRoots()` with no arguments. Nothing else changes.
Linux check: `bash scripts/linux-check.sh test/linux-index-roots.test.js test/linux-roots.test.js test/core.test.js`.

### Stage 3 — No relative PATH entry (O2, security)

**S3.1 · TEST.** Risk low. New file `test/linux-childenv.test.js`:
```js
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
```
RED: `childEnv` is not exported.

**S3.2 · CODE.** Risk low. Files allowed: `src/core.js`, the `childEnv` function only (~170-177).
Current code:
```js
function childEnv(env, execPath) {
  return {
    ...env,
    NO_COLOR: "1",
    GIT_OPTIONAL_LOCKS: "0",
    PATH: [path.join(env.APPDATA ?? "", "npm"), path.dirname(execPath), env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}
```
Required change:
- add `export ` before `function`;
- replace the PATH line with:
  ```js
      PATH: [...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), path.dirname(execPath), env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  ```

Nothing else changes.
Linux check: `bash scripts/linux-check.sh test/linux-childenv.test.js test/core.test.js test/plan-s13-launch.test.js`.

### Stage 4 — Verify finds project-local tools on Linux (O3)

**S4.1 · TEST.** Risk low. New file `test/linux-verify-bin.test.js`:
```js
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
```
It is RED on Linux, because `mytool` is not on PATH today. It is skipped on Windows.

**S4.2 · CODE.** Risk low. Files allowed: `src/verify.js`, inside the POSIX branch of `resolveVerificationCommand` only.
Current code (~32-38):
```js
  if (process.platform !== "win32") {
    // POSIX spawns resolve through PATH; check that the program is a runnable file so a missing/directory/non-executable one is refused up front.
    const found = hasDirectory ? await isRunnablePosix(path.resolve(cwd, command))
      : (await Promise.all(pathDirectories().map(dir => isRunnablePosix(path.join(dir, command))))).some(Boolean);
    if (!found) throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
    return { command, args };
  }
```
Required change: insert the following directly after the comment line, before `const found`:
```js
    if (bare) {
      for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const local = path.join(dir, "node_modules", ".bin", command);
        if (await isRunnablePosix(local)) return { command: local, args };
        if (path.dirname(dir) === dir || await exists(path.join(dir, ".git"))) break;
      }
    }
```
Do not add `.cmd`, and do not copy `nearestBinShim`. The PATH check below stays as it is, and the Windows code is untouched.
Linux check: `bash scripts/linux-check.sh test/linux-verify-bin.test.js test/plan-s4-verify-shims.test.js`.

### Stage 5 — Baseline leftovers

**S5.x · TEST/CODE pairs**, written by the supervisor from the class (b) items in S0.4 and the S0.5 gate. Use one failing test and one function per step. Items about process killing or timing are high risk: send them to Claude unless they are one-liners.

### Stage 6 — Full green

**S6.1 · SUP.** The whole suite is green twice on the VM, and CI is green on all three jobs.

**S6.2 · SUP.** Self-review of `git diff main...linux-support`:
- Windows behaviour unchanged;
- PATH safety;
- roots parsing;
- no new shell use.

Post the review to the owner, who forwards it to Claude for a second review.

### Stage 7 — End-to-end with a real Linux OpenCode on the VM (HIGH risk)

**S7.1 · SUP.** Write `scripts/linux-smoke.mjs`, an MCP SDK stdio client.
- It starts `node src/index.js` with:
  - `OPENCODE_HELPER_ALLOWED_ROOTS=<tmp smoke root>`;
  - `OPENCODE_HELPER_SERVE=0`, because the warm `opencode serve` pool would otherwise keep a server alive for 120 s (`src/server-pool.js` ~8, ~176-179) and break the process count.
- It calls, in order:
  1. `list_free_models` (probe);
  2. `analyze_code` on a temp git repo under the smoke root (a tiny question, `maxWords` 60);
  3. `apply_opencode_edits` with the prompt "add the word hello to README.md", using one free model and verify `{ command: "node", args: ["-e", "process.exit(require('fs').readFileSync('README.md','utf8').includes('hello')?0:1)"] }`;
  4. `analyze_code` on a directory outside the smoke root, which must be refused.
- After each call, the count of `opencode` processes must return to its value before the call.
- Never run it in CI: there are no secrets in CI.

**S7.2 · SUP.** Every failure becomes a Stage 5 pair. Done when the smoke passes twice in a row.

### Stage 8 — Real arm64 server (deferred)

CI already covers arm64 unit tests. This stage runs the S7 smoke once on the owner's ARM64 server, through the owner's own channel. The supervisor never gets direct access.

### Stage 9 — Merge decision (OWNER)

Show the owner:
- the diff summary;
- the experiment numbers;
- the reviews.

Merge to `main` only on the owner's explicit yes.

## 5. Order

S0.1 → S0.2 → S0.3 → S0.4 → S0.5 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9.

Stages 2, 3 and 4 are independent of each other, but run one at a time.

## 6. Escalation ladder

1. **Attempts 1-3:** the same executor and text, plus the failure tail.
2. **Supervisor rewrites or splits the step** (same tests), then up to 3 more attempts.
3. **Report to the owner**, who sends the step to Claude. Claude implements by hand.

Never edit a test to pass, and never change the Windows branch to make Linux pass.

## 7. Experiment log

For each CODE step, `progress.md` records:
- executor and model;
- attempts;
- first-try pass;
- escalation level;
- minutes;
- CI reverts;
- review fixes.

The final report gives the share of steps the free executors finished alone and the kinds of steps that failed.
