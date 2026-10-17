# OpenCode Helper MCP

Read-only MCP server for code analysis through [OpenCode](https://opencode.ai). Nothing hard-codes a model: the server discovers which **free** models OpenCode can use right now, and the client (Claude Code, Codex, …) picks one.

## Tools

### `list_free_models`

Returns JSON with the currently available free models (`id`, `provider`, `name`, `free_basis`, `context`).

| Input | Default | Meaning |
|---|---|---|
| `probe` | `false` | Send a tiny read-only health prompt to each listed model in parallel (4 at a time, 30 s cap each). Adds `probe: { status: ok\|failed\|timeout, latency_ms, error }`. |
| `refresh` | `false` | Ignore the 10-minute cache and re-read the list (and re-probe). |
| `models` | all | Only return/probe these ids. |
| `provider` | all | Only return models of one provider, e.g. `opencode` or `nvidia`. |

**Free rule:** the list comes from `opencode models --verbose`. A model is free when its `cost.input` and `cost.output` are both `0`. If OpenCode gives no cost metadata (or `--verbose` fails and the plain `opencode models` list is used), ids ending in `-free` / `:free`, or `opencode/big-pickle`, count as free. Models without tool-call support (embeddings, TTS, image) and deprecated models are excluded. Only providers that OpenCode has credentials for appear in the list.

### `analyze_code`

Inputs: `directory`, `prompt`, optional `maxWords`, `budgetMs`, `model`, `models`.

- Recommended: call `list_free_models` first (`probe: true` when unsure), then pass the chosen `model` and optionally an ordered fallback list in `models`.
- Only ids in the current free list are accepted; others are rejected with the list of valid ids.
- Without `model`/`models` the helper auto-orders: `opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free`, `opencode/mimo-v2.6-flash-free` (each only if currently listed), then other free models (recently probed-OK first, fastest first, `opencode/*` before others). Models that failed or timed out in a recent probe are skipped. At most 4 automatic attempts.
- Each model is called at most once. `budgetMs` (30 000–600 000, default 300 000) is the total wall-clock budget; each attempt gets up to 120 s while 30 s per remaining attempt is reserved, a single attempt may use the whole budget, and time left by a fast failure goes to the next attempt.
- `--variant low` is passed only for models that offer a `low` variant.

The result starts with a header:

```
## CodeHelper
- Model: opencode/glm-5.3-flash-free (23874 ms)
- Selection: auto (opencode/deepseek-v4.1-flash-free → opencode/glm-5.3-flash-free → …)
- Attempts:
  1. opencode/deepseek-v4.1-flash-free — failed 812 ms (cap 120000 ms): OpenCode exited with code 1 after 812 ms.
      Error: <NDJSON error message>
      stderr (tail): <last ~1500 chars>
  2. opencode/glm-5.3-flash-free — ok 23874 ms (cap 120000 ms)
```

## Errors

Failures report the exit code, the error message from OpenCode's NDJSON output when present, and the last ~1500 characters of stderr. Timeouts report the elapsed milliseconds. Everything is passed through secret redaction first (bearer/Authorization values, `sk-`/`nvapi-`/`gsk_`/`ghp_`-style keys, `api_key=…`/`token: …` pairs, JWTs, long key-like strings, and any `auth.json`-style credential object). Model metadata such as `headers`/`options` is never stored or returned.

## Safety

- OpenCode runs as `opencode run --dir <dir> --model <id> [--variant low] --agent plan --format json <prompt>` with `shell: false`; the prompt forbids edits, state-changing commands, hidden/credential files and `node_modules`/`.git`/build output.
- Target folders must resolve canonically (junctions and symlinks resolved) under `C:\Develop`; set `OPENCODE_HELPER_ALLOWED_ROOTS` to a semicolon-separated list to change that.
- Child stdout (1 MiB, 8 MiB for model listing) and stderr (64 KiB) are bounded; timeouts and overflows kill only the known child process tree (`taskkill /t /f` on Windows).

## Configuration

| Env var | Meaning |
|---|---|
| `OPENCODE_BIN` | Path to `opencode` (default: `opencode` on PATH). |
| `OPENCODE_HELPER_ALLOWED_ROOTS` | Allowed workspace roots (default `C:\Develop`). |
| `OPENCODE_HELPER_ATTEMPT_TIMEOUT_MS` | Fallback per-attempt timeout when no budget is given (default 120 000; `OPENCODE_HELPER_TIMEOUT_MS` is still read for compatibility). |

## Run locally

```powershell
npm install
npm start
```

## Tests

```powershell
npm test
```

## Add to Codex

```powershell
codex mcp add opencodeHelper -- node C:\Develop\openCodeHelperMcp\src\index.js
```

Open a new Codex task (or restart Claude Code) after updating the server. OpenCode uses its own stored credentials; the helper never stores or reads API keys.
