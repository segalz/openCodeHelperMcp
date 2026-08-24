# OpenCode Helper MCP

Local, read-only MCP server for code analysis through the installed OpenCode CLI.

It exposes one fixed, read-only analysis tool for normal use plus three provider-specific diagnostic tools:

- `analyze_code`: deterministic fallback — Cloudflare, then MiMo, then NVIDIA GPT-OSS
- `analyze_code_cloudflare`: Cloudflare Workers AI `@cf/zai-org/glm-4.7-flash`
- `analyze_code_mimo`: OpenCode `mimo-v2.5-free`
- `analyze_code_nvidia`: NVIDIA `openai/gpt-oss-20b`
- `low` reasoning effort
- OpenCode's `plan` agent
- a 120-second timeout

All tools start `opencode run` with fixed arguments and expose only `directory` and `prompt` to MCP clients—never a model, executable, command, test mode, or write control. `analyze_code` performs the deterministic Cloudflare → MiMo → NVIDIA fallback and returns a sanitized all-providers-failed status only after all three providers fail or time out. At that point, a direct Grok fallback is permitted.

## Scope

By default, target folders must be under `C:\Develop`. Set `OPENCODE_HELPER_ALLOWED_ROOTS` to a semicolon-separated list of additional allowed absolute paths if needed.

## Run locally

```powershell
npm install
npm start
```

## Add to Codex

```powershell
codex mcp add opencodeHelper -- node C:\Develop\openCodeHelperMcp\src\index.js
```

Open a new Codex task after adding the server. The helper uses Cloudflare, OpenCode, and NVIDIA credentials already stored by OpenCode; it does not store an API key.
