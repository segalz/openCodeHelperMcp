# Plan — Cline-bridge behaviour for the OpenCode helper (2026-11-13)

Owner's request: the behaviour that works well in the Cline bridge (`ClineMcp`, Stages 9, 10, 12) also in this
OpenCode MCP helper. Roles: Codex reviews the plan and implements, AGY reviews. Work on branch `final-check`; if a
regression appears, roll back.

## Research findings (Codex, static inspection of OpenCode 1.19.5)
- `opencode run --format json` emits JSON lines `{type, timestamp, sessionID, part}`: `step_start`, `tool_use`
  (after completion: `part.tool`, `part.callID`, `part.state.{input,status,output,error}`), `step_finish`
  (`part.tokens.{input,output,reasoning,cache.{read,write}}`, `part.cost`), `text` (`part.text`), `error`.
- Agents: `build`, `plan` (primary), `general`, `explore` (sub-agents). `plan` denies ordinary edits but allows Bash
  through base permissions: today's read-only rule is a prompt, not isolation. `OPENCODE_PERMISSION` (JSON) can set
  explicit permissions. Headless pending permission requests are rejected unless `--auto`.
- `--session`/`--continue` exist, so fix runs can continue the same session.
- The helper buffers stdout to the end, returns the last text part, ignores usage and `part.state.error`.

## Stages
| Step | Work | Done when |
|---|---|---|
| O.1 | Streaming NDJSON parser: tool calls, tool errors, usage per step, final text, session id; errors surfaced. | Tests with recorded event shapes. |
| O.2 | Guard (port of ClineMcp `guard.ts`): repeated failures of the same tool+target (3 in 10), tool-call and input-token budgets; stop the process and report. `guard` param. | Tests. |
| O.3 | `analyze_code`: enforced read-only permissions (`OPENCODE_PERMISSION`: edit/write/patch deny, bash deny, task deny), environment line, working rules (OpenCode tool names), code map (`codeMap`, default true). | Tests; read-only enforced, not only prompted. |
| O.4 | `apply_opencode_edits` (sync): `directory`, `prompt`, `model`, `verify` (required: command spec or `{none, reason}`), `maxFixRuns` (0-2, default 2), `keepOnFailure`, `codeMap`, `guard`, `budgetMs`. Lifecycle as ClineMcp Stage 12: shared checkout lock (same lock directory and naming as ClineMcp) → identity → one snapshot → `build` run → identity → verify → fix runs in the same session → restore on failure unless `keepOnFailure`. Ported `snapshot`, `checkoutlock`, `verify`. No automatic model fallback during edits. | Tests: pass first time, fix then pass, restore, keep, none, guard trip, HEAD change, refused executable. |
| O.5 | README and tool descriptions. | Docs match code. |
| O.R | AGY review. | No open findings. |
| O.L | Live: `analyze_code` on a real question (read-only proven: an attempted write is denied); `apply_opencode_edits` on the 7-check task (3 runs) and a missing-requirement run (fix path). | Same behaviour as Cline Stage 12. |

Async tasks for OpenCode are out of scope for now (sync first).
