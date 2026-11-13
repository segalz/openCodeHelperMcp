# OpenCode Helper MCP

A local stdio MCP server for read-only code analysis and checked edits through the installed OpenCode CLI. It discovers models advertised as free, runs bounded tool-enabled requests, and reports model usage, guard counters and session IDs. Edit requests add verification and recovery of the checkout's pre-run files.

The three tools are synchronous: each call returns its final result. There are no asynchronous task-management tools. Analysis uses the OpenCode `plan` agent; edits use `build`. Both run with explicit permission profiles and without `--auto`.

## Typical use

1. `list_free_models` with `probe:true` to pick a responsive free model.
2. `analyze_code` for a focused question about the current directory, including uncommitted changes. Write, shell and web tools are unavailable to the model.
3. `apply_opencode_edits` for a scoped change with an executable `verify` check. A failed check starts up to two repairs in the same OpenCode session; if it still fails, the pre-run files are restored unless `keepOnFailure:true`.
4. Review the resulting diff yourself. A passing check shows that your check passed, not that the change is correct.

Use a clean work branch for edits so the diff is attributable to the call. The helper never commits, and it holds the same checkout lock as the Cline bridge, so the two never edit one checkout at the same time.

Measured on one local 7-check Python task (`opencode/glm-5.3-flash-free`, November 2026), four edit calls all ended 7/7 in 63-87 seconds and 45-74k input tokens. In one run a requirement left out of the prompt was added by a single repair after the check failed. Results depend on the model, task and current free-tier capacity.

## Setup

Install Node.js, Git and OpenCode, and configure the provider access you intend OpenCode to use. From this repository:

```powershell
npm install
npm start
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. Register the server with an MCP client, for example:

```powershell
codex mcp add opencodeHelper -- node C:\Develop\openCodeHelperMcp\src\index.js
```

Restart or reconnect the MCP client after server changes so it reloads the tool schemas. OpenCode manages provider credentials; the helper does not implement a separate credential store.

## `list_free_models`

Returns JSON in MCP text content with model IDs, providers, names, `free_basis`, available context limits, and available probe results. Use the returned IDs for the other tools.

| Input | Default | Meaning |
|---|---|---|
| `probe` | `false` | Send a small read-only health prompt to the selected models; concurrency 4, timeout 30 seconds per model. |
| `refresh` | `false` | Bypass the 10-minute catalog cache and re-probe selected models when `probe:true`. |
| `models` | All | Filter to an explicit list of current free IDs, up to 50 entries. |
| `provider` | All | Filter to one provider. |

Probe records contain `status` (`ok`, `failed` or `timeout`), `latency_ms`, and an error when available. Probe results are also cached for 10 minutes; `probe:true` reuses recent results unless `refresh:true`.

The catalog comes from `opencode models --verbose`, with a plain `opencode models` fallback. A model is counted as free when its reported input and output prices are both zero. If those prices are unavailable, IDs ending in `-free` or `:free`, plus `opencode/big-pickle`, count as free. Explicitly unsupported tool calling and deprecated models are excluded; missing metadata cannot establish tool support.

Catalog membership does not establish credentials, remaining quota or a usable answer. Probe `ok` means the runner received text; it is not a correctness test, and a refusal can also contain text. A slow working model can time out. Verify a substantive analysis result before relying on a model.

Typical call to `list_free_models`:

```json
{
  "provider": "opencode",
  "probe": true
}
```

## `analyze_code`

Analyzes the current directory using read/search tools. The helper validates a deny-by-default `OPENCODE_PERMISSION` object and supplies an explicit inline `plan` agent profile. The profile allows `read`, `glob`, `grep` and `list`, denies edits, Bash, delegated tasks, web tools and external-directory access, and adds hidden-path, credential and generated-directory read restrictions. This is CLI permission enforcement, not just an instruction in the prompt.

The prompt includes the actual cwd and OS, working rules, and an optional code map. The rules request combined searches, batched independent reads, relevant line ranges, no repeated reads, a changed approach after two failures, and a concise English answer with evidence and unresolved points.

| Input | Default | Meaning |
|---|---|---|
| `directory` | Required | Absolute directory resolving under an allowed root. Analysis does not require a Git repository. |
| `prompt` | Required | Focused analysis request, 1-12,000 characters. |
| `model` | Automatic | One current free model ID, tried first. |
| `models` | None | Ordered fallback IDs, up to 8 entries, following `model`; duplicate IDs are removed. |
| `maxWords` | `120` | Requested answer budget, 40-600 words. This is a prompt instruction. |
| `budgetMs` | `300000` | Shared work deadline, 30,000-600,000 ms; see Budgets and limits. |
| `codeMap` | `true` | Add a bounded map of current tracked source files when available. |
| `guard` | Shared defaults | Loop/tool/input-token limits described below. |

When IDs are supplied, every ID must be in the current free catalog; models are attempted in the supplied order, at most once each, stopping at the first successful answer. Without IDs, automatic selection makes at most four attempts. It prefers `opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free` and `opencode/mimo-v2.6-flash-free` when listed, then sorts other models by recent probe success, latency, provider and ID. Recent failed/timed-out probes are filtered out; if that removes every candidate, listed preferred models are tried again despite their probe failures.

Ordinary run failures can advance to the next model. A guard trip or local preparation refusal stops the chain immediately. Fatal CLI events, nonzero exits, timeouts and output overflows cannot succeed on partial answer text. A recovered tool error can remain in the guard's diagnostic history without making the final answer fail. A `low` model variant is used only when the catalog advertises it.

Typical call to `analyze_code` (replace the directory and sample model with your project and a current catalog ID):

```json
{
  "directory": "C:\\Develop\\my-project",
  "prompt": "Trace input validation in src/parser.js. Cite the relevant functions and explain the failure path.",
  "model": "opencode/glm-5.3-flash-free",
  "budgetMs": 180000,
  "maxWords": 200,
  "codeMap": true,
  "guard": { "maxToolCalls": 60, "maxInputTokens": 300000 }
}
```

The response is Markdown headed `## CodeHelper`: selected model, selection mode, guard report, usage, last captured session ID when available, and the attempted models with timing and redacted error details. The final assistant message follows the header. Usage and guard counters include earlier failed attempts in the same call. Analysis does not expose a session-continuation parameter.

## `apply_opencode_edits`

Edits a Git checkout using one explicitly selected current free model. A Git repository with a readable HEAD is required; the checkout root must also be inside the allowed roots. Work runs at the checkout root, including when `directory` names a subdirectory.

The `build` permission profile allows file edits with read/edit path restrictions, including enumerated ignored paths. Bash, delegated tasks, web tools and external-directory access remain denied. The bridge executes the caller's verification command separately. There is no model fallback and no blanket permission approval.

| Input | Default | Meaning |
|---|---|---|
| `directory`, `prompt` | Required | Same path and prompt constraints as analysis. |
| `model` | Required | One current free catalog ID, retained for all launches. |
| `verify` | Required | Exactly one command specification or an explicit exemption described below. |
| `maxFixRuns` | `2` | Maximum automatic repairs after the initial run, integer 0-2. |
| `keepOnFailure` | `false` | Keep failed changes instead of restoring them, reported with `kept:true`. |
| `budgetMs` | `300000` | One shared work deadline, 30,000-600,000 ms, including setup, model launches and checks. |
| `codeMap` | `true` | Rebuild the optional current-content map for each launch. |
| `guard` | Shared defaults | Cumulative counters and failure window across the initial run and repairs. |

A verification command is `{command, args?, timeoutSeconds?}`. Arguments are literal strings; command and args cannot contain NUL. The command runs from the checkout root with closed stdin and `shell:false`. The default timeout is 60 seconds, integer range 1-300. On Windows, `npm`, `npx`, `npm.cmd` and `npx.cmd` resolve through Node and installed npm CLI scripts; other `.cmd`/`.bat` commands are refused. A pass requires exit zero without a signal, timeout, cancellation or output-limit kill.

Typical call to `apply_opencode_edits`:

```json
{
  "directory": "C:\\Develop\\my-project",
  "prompt": "Fix the input validation bug in src/parser.js while preserving behavior for valid input.",
  "model": "opencode/glm-5.3-flash-free",
  "verify": { "command": "npm", "args": ["test"], "timeoutSeconds": 60 },
  "maxFixRuns": 2,
  "keepOnFailure": false,
  "budgetMs": 300000
}
```

When no executable check is appropriate, replace `verify` with the explicit alternative below. The trimmed reason must contain 10-500 characters. Both alternatives reject additional properties and cannot be combined.

```json
{
  "none": true,
  "reason": "No executable check exists for this documentation-only change."
}
```

An exemption reports `required:false`, `passed:null`, the reason, and no verification attempts or check-driven repairs. Model errors, guard trips and interruptions still fail the edit request.

### Edit lifecycle and recovery

1. Resolve the checkout root, acquire its shared writer lock, record HEAD/index identity, and take one recovery snapshot outside the checkout.
2. Launch OpenCode, inspect identity again, and run the exact verification specification.
3. On a failed check, launch up to `maxFixRuns` repairs using `--session <captured-id>`, the same model/variant/profile and the remaining budgets. Each repair includes the original objective, exact check, exit/timeout/output-limit status and redacted tails, with instructions never to weaken the check. Verify again after each repair.
4. On success, dispose of the snapshot. On failure, restore the pre-run files by default; `keepOnFailure:true` keeps the current changes. Release the lock before returning.

A guard trip, deadline, cancellation, model error or request for caller input does not start an automatic repair. A missing/refused verification executable spends no repair runs. A repair requires the captured session ID; missing or mismatched continuation fails explicitly. The helper never uses `--continue` or `--fork`.

The snapshot contains tracked working-tree files and untracked non-ignored files, including dirty and binary bytes; tracked deletions remain absent in the baseline. Restoration returns to those bytes rather than HEAD, restores deleted baseline files, and removes newly created non-ignored files. Existing staging is protected by unchanged index identity; the index itself is not backed up or restored. Untracked ignored files and external files are outside snapshot recovery.

HEAD/index identity is checked around launches, after verification and before restoration. Changed or unreadable identity refuses restoration and retains the snapshot. Incomplete restoration also retains recovery bytes. Inspect `evidence` for identity details, restore failures and `snapshotDirectory`. A cleanup error can leave a snapshot even after successful verification. The writer lock is released on terminal paths, including recovery refusal.

The lock uses the same canonical-path SHA-256 filename and holder format as the Cline bridge, under `~/.cline-mcp/locks`. This excludes cooperating Cline and OpenCode writers on the same checkout. Dead-PID holders can be reclaimed; age alone does not make a lock stale. The lock does not block other editors or Git clients, so use the checkout exclusively during an edit call.

### Edit result

The response is JSON encoded in MCP text content. Failures set MCP `isError:true`. A normal lifecycle result has this shape (field notation, not a literal response):

```text
status: "done" | "failed"
model, text?, sessionID?, elapsedMs
verification: {
  required, passed: true | false | null,
  command: {command, args?, timeoutSeconds?} | null, reason?,
  attempts: [{run, passed, exitCode, signal, timedOut, killedForOutput,
              durationMs, stdoutTail, stderrTail, error?}],
  fixRuns, restored, kept
}
usage: {inputTokens, uncachedInputTokens, cacheReadTokens, cacheWriteTokens,
        outputTokens, reasoningTokens, cost, steps}
guard: {window, totalToolCalls, totalInputTokens, lastErrors, filesTouched,
        observation, kind?, tool?, target?, count?, lastAssistantText?}
evidence: {snapshotDirectory?, identity?, identityError?, restore?,
           recoveryError?, cleanupError?}
error?, message?
```

`fixRuns` counts attempted repair launches after the initial launch. `passed` describes the last verification, not a new check of restored bytes. Inspect `status`, `error`, `restored` and `kept` together; retained failed edits are not a successful edit result. Early validation/setup refusals may contain only `error` and `message`.

## Guard, usage and code map

Both work tools accept a partial `guard` object:

| Parameter | Default | Integer range |
|---|---|---|
| `maxRepeatedFailures` | 3 | 2-20 |
| `window` | 10 | 3-50; at least `maxRepeatedFailures` |
| `maxToolCalls` | 150 | 10-1,000 |
| `maxInputTokens` | 1,500,000 | 10,000-20,000,000 |

Repeated failures use tool name plus normalized target: file paths, patch paths, commands, or an input hash. The failure window includes successful and unrelated calls. Trips report `loop_detected` or `budget_exceeded`, counts, recent redacted errors, successfully touched edit paths and the latest observed assistant-text excerpt. A trip terminates the known child process tree and prevents fallback or repair.

Input-token budgets sum uncached input, cache reads and cache writes once per unique reported step. Usage also keeps output, reasoning, cost and step counts separately. These are CLI-reported observations, not estimates of unreported work; missing usage is unknown rather than proof of zero consumption.

The guard sees terminal tool results and per-step usage, not tool starts or every generated token. It can overshoot while a tool or model step is active. The wall-clock timeout is separate from those event-driven limits.

The optional map lists tracked paths, line counts and regex-detected symbols with 1-based positions in current checkout contents. It includes dirty tracked contents, excludes untracked files and common hidden/credential, vendor/generated, binary, non-UTF-8, minified and lock files, and prioritizes prompt-mentioned paths. It is not an AST or a guarantee against concurrent edits. Non-Git paths and map failures omit it without failing analysis.

Map scanning is limited to 3,000 candidate files, 512 KiB per file and 1.5 seconds; rendered output is at most 6,000 characters and shortened or omitted to fit the escaped Windows command line with a 1,000-unit margin below 32,000 UTF-16 units. Oversized mandatory prompts fail instead of being silently truncated. Set `codeMap:false` to omit map generation.

## Budgets and limits

- Analysis shares its deadline and guard across model attempts. Multiple-model attempts have a 120-second cap, reserving 30 seconds per remaining candidate when possible; a single-model chain can use the whole remaining budget. Catalog/validation time reduces the time left for analysis launches, but analysis catalog discovery has separate 60-second command limits and is not interrupted by that analysis deadline.
- Edits share one deadline across preparation, snapshots, launches, repairs and verification; a check also has its own timeout. Exhausted guard budgets prevent another repair launch. Process termination, identity inspection and recovery can extend elapsed time beyond the work deadline; recovery is completed or reported before returning.
- Model stdout is capped at 1 MiB, model-listing stdout at 8 MiB, and stderr at 64 KiB. A JSON event line is limited to 256 KiB. Verification stops above 1 MiB combined output and returns redacted stdout/stderr tails of at most 8 KiB each.
- Snapshots are limited to 20,000 files, 64 MiB per file and 512 MiB total. Unsupported paths, submodules, nested repositories, symlinks/reparse points and oversize snapshots are refused. Default storage is the OS temporary directory's `cline-mcp-snapshots` folder.
- Edit inputs are limited to 64 KiB of serialized JSON. Repair prompts preserve the objective and exact verification specification, shorten diagnostic tails first, and refuse mandatory content that exceeds their limit.

Permissions are not a filesystem sandbox. Allowed-root checks constrain the starting directory and edit checkout root; CLI permissions govern the agent's tools, not arbitrary host processes. The caller's verification command runs separately with host permissions. Read-path restrictions do not establish complete confidentiality across every search or third-party tool behavior.

Errors include available CLI exit/error details and bounded stderr tails, with common secret forms redacted. Redaction is best-effort; do not rely on it to make arbitrary model output or verification output safe to publish. Safe catalog fields are retained; provider metadata such as headers and options is not returned.

## Configuration

| Environment variable | Meaning |
|---|---|
| `OPENCODE_BIN` | Explicit executable path. Otherwise, on Windows use the existing native `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`, then fall back to `opencode` on PATH. Windows CLI shims cannot be launched with `shell:false`. |
| `OPENCODE_HELPER_ALLOWED_ROOTS` | Semicolon-separated allowed roots; default `C:\Develop`. Paths are checked after resolving junctions/symlinks. |
| `OPENCODE_HELPER_ATTEMPT_TIMEOUT_MS` | Runner fallback timeout when no request timeout is supplied; default 120,000 ms. The MCP tools supply their own timeouts, so this does not override their documented budgets. |
| `OPENCODE_HELPER_TIMEOUT_MS` | Legacy fallback, used only when `OPENCODE_HELPER_ATTEMPT_TIMEOUT_MS` is unset. |

The helper supplies `OPENCODE_PERMISSION` and an explicit selected-agent profile through `OPENCODE_CONFIG_CONTENT` for each model launch; these are not caller-controlled permission escape switches. Invalid inline configuration is refused before launch. Permission and JSON-event integration depends on the installed OpenCode CLI's behavior.

## Tests

```powershell
npm test
```

Use `npm.cmd test` on Windows when script execution policy blocks the PowerShell shim. Tests use injected processes, synthetic CLI events, fake model runners, temporary Git fixtures and local verification processes; they do not call live models. They cover streaming parsing, permission construction, cumulative guards, maps, same-session repairs, snapshots, identity refusal, restoration, keep/exemption paths, cancellation and shared-lock contention.
