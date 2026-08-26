# OpenCode Helper MCP

Local, read-only MCP server for code analysis. Normal callers use a single orchestrated tool; provider selection stays inside the server.

## Tools

- `analyze_code`: deterministic chain — **native Mac Ollama `qwen3.8:27b-mlx`**, then NVIDIA GPT-OSS, then MiMo, then Cloudflare. After all fail, returns a sanitized all-providers-failed status so a direct Grok fallback is permitted.
- `analyze_code_ollama`: native Ollama only (diagnostic)
- `analyze_code_nvidia`: NVIDIA `openai/gpt-oss-20b` via OpenCode `plan` / `low`
- `analyze_code_mimo`: OpenCode `mimo-v2.5-free`
- `analyze_code_cloudflare`: Cloudflare Workers AI `@cf/zai-org/glm-4.7-flash`

MCP input is only `directory`, `prompt`, and optional `maxWords` / `budgetMs`. Clients never pass endpoint, model, options, tools, or test mode.

## Native Ollama bridge

- `POST http://Zvis-MacBook-Pro.local:11434/api/chat`
- IPv4 fallback `http://10.100.102.8:11434/api/chat` only on connection or address-family errors
- Fixed payload fields: `think: false`, `keep_alive: "30m"`, `stream: false`
- Bounded read-only tool loop (no shell): `list_files`, `search_text`, `read_file`
- Canonical path checks under the allowed workspace; rejects traversal and symlink/reparse escapes
- Skips `node_modules`, `.git`, `build`, `vendor`, binaries, and similar junk trees
- Caps rounds, files, bytes, context, output, and wall time; malformed, empty, unsafe, tool, and timeout errors fail the provider

OpenCode providers still launch `opencode run` with fixed arguments. NDJSON is accepted only with a valid final text event.

## Scope

By default, target folders must be under `C:\Develop`. Set `OPENCODE_HELPER_ALLOWED_ROOTS` to a semicolon-separated list of additional allowed absolute paths if needed.

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

Open a new Codex task after adding the server. Remote OpenCode providers use credentials already stored by OpenCode; the helper does not store an API key. Native Ollama talks to the fixed Mac host above.
