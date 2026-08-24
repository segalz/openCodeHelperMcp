# OpenCode Helper MCP

Local, read-only MCP server for code analysis through the installed OpenCode CLI.

It exposes two fixed, read-only analysis tools:

- `analyze_code_mimo`: OpenCode `mimo-v2.5-free`
- `analyze_code_nemotron`: NVIDIA `nemotron-3-nano-omni-30b-a3b-reasoning`
- `low` reasoning effort
- OpenCode's `plan` agent
- a 120-second timeout

Both tools start `opencode run` with fixed arguments and do not expose model, effort, command, or write controls to MCP clients. Call MiMo first, then Nemotron only when MiMo fails or is insufficient.

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
