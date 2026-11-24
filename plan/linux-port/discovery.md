# openCodeHelperMcp Linux port — discovery (S0.3 / S0.5)

Supervisor VM: Linux x86_64 (Debian 13), 2026-11-24. Names and ids only; no keys.

## S0.3 — VM and free-model access

Reused from ClineMcp S0.3 (same VM): Node `v22.23.5` (nvm), git, build-essential, `cline` 3.0.75, `opencode-ai` 1.19.6. This repo: `npm ci` OK.

| Executor | Model id | Status |
|----------|----------|--------|
| OpenCode | `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` | works (`opencode run` → `PONG`) |
| OpenCode | `nvidia/poolside/laguna-xs-2.1` | works (`opencode run` → `PONG`) |
| OpenCode | `opencode/deepseek-v4.1-flash-free` | works, no secret (`opencode run` → `PONG`) |
| Cline | `-P nvidia -m nvidia/nemotron-3.5-super-vl-120b-a12b` | works (plan's headless command line → `finishReason: completed`) |

NVIDIA access: `NVIDIA_API_KEY` is in the supervisor VM's secret store (owner, 2026-11-24) and read from the environment only; never stored in this repo. Details in ClineMcp `plan/linux-port/discovery.md`.

## S0.5 — Discovery of the Linux OpenCode install

- `readlink -f "$(command -v opencode)"` → `/home/box/.local/lib/node_modules/opencode-ai/bin/opencode.exe`
- First 200 bytes: `\x7fELF…` → **native ELF x86-64 binary** (no JS wrapper; on Linux the file is still named `opencode.exe`). `resolveOpenCodeExecutable`'s PATH fallback `opencode` reaches it through the npm symlink.
- `opencode --version` → `1.19.6`
- `opencode serve --hostname 127.0.0.1 --port <p> --print-logs --log-level ERROR` (the args `src/server-pool.js` ~108 uses), stdout:
  ```
  Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
  opencode server listening on http://127.0.0.1:<p>
  ```
  stderr empty. The second line equals the banner the pool expects (`opencode server listening on ${url}`, ~88-99). The warning line is ignored by the parser.
- `opencode models --verbose` sample (format: an id line, then a pretty-printed JSON object):
  ```
  opencode/beam-free
  {
    "id": "beam-free",
    "providerID": "opencode",
    "name": "Beam Free",
    "family": "beam-free",
    "api": { "id": "beam-free", "url": "https://opencode.ai/inference/openai/v1", "npm": "@ai-sdk/openai-compatible" },
    "status": "active",
    "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
    "limit": { "context": 1048576, "output": 131072 },
    "capabilities": { "temperature": true, "reasoning": true, "attachment": false, … }
  }
  ```
  `parseVerboseModels` (`src/core.js` ~648) on the real output: 10 of 10 ids parsed, all `free: true` (`freeBasis: cost`), `toolcall: true`. The free list itself varies between calls (12 ids in one `opencode models`, 10 in the next).
- `ps -eo pid,ppid,pgid,sid,args` while `opencode serve` and `opencode run` ran (shell SID 556185):
  ```
  PID     PPID    PGID    SID     ARGS
  556191  53      556185  556185  opencode serve --port <p> --hostname 127.0.0.1
  556257  53      556257  556185  timeout 120 opencode run -m opencode/deepseek-v4.1-flash-free …
  556259  556257  556257  556185  opencode run -m opencode/deepseek-v4.1-flash-free …
  ```
  No child with its own SID: neither `serve` nor `run` called `setsid()` (and no extra children were seen during this short run).

### Gate

Banner and model-list formats match the parsers → **PASS**, no Stage 5 pair from S0.5.
