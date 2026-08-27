# OpenCode Helper MCP

Read-only MCP server for code analysis. Normal callers use one orchestrated tool; provider selection stays inside the server.

## Tools

- `analyze_code`: deterministic chain — NVIDIA GPT-OSS, then MiMo, then Cloudflare.
- `analyze_code_nvidia`: NVIDIA `openai/gpt-oss-20b` via OpenCode `plan` / `low`
- `analyze_code_mimo`: OpenCode `mimo-v2.5-free`
- `analyze_code_cloudflare`: Cloudflare Workers AI `@cf/zai-org/glm-4.7-flash`

MCP input is only `directory`, `prompt`, and optional `maxWords` / `budgetMs`. Clients never pass provider, model, options, or test controls.

OpenCode providers run `opencode run` with fixed arguments. NDJSON is accepted only with a valid final text event. Child stdout and stderr are memory-bounded; MCP clients receive sanitized errors only. Timeouts and output limits terminate only the known child process tree.

## Scope

By default, target folders must resolve canonically under `C:\Develop`, including Windows junction and symlink resolution. Set `OPENCODE_HELPER_ALLOWED_ROOTS` to a semicolon-separated list of additional allowed absolute paths if needed.

Callers choose `budgetMs` from request complexity (roughly 90 seconds focused, 180 seconds multi-file, or 270 seconds deep). The helper redistributes its remaining time across the fixed provider chain without duplicate provider calls. The orchestrated MCP result reports the successful provider and sanitized statuses for any previous attempts before the analysis text. It never includes raw provider errors or credentials.

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

Open a new Codex task after adding the server. Remote OpenCode providers use credentials already stored by OpenCode; the helper does not store an API key.
