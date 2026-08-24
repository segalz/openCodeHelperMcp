# OpenCode Helper MCP

Local, read-only MCP server for code analysis through the installed OpenCode CLI.

It always uses:

- NVIDIA `nemotron-3-nano-omni-30b-a3b-reasoning`
- `low` reasoning effort
- OpenCode's `plan` agent
- a 120-second timeout

The server offers one tool: `analyze_code`. It starts `opencode run` with fixed arguments and does not expose model, effort, command, or write controls to MCP clients.

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

Open a new Codex task after adding the server. The helper uses the NVIDIA credentials already stored by OpenCode; it does not store an API key.
