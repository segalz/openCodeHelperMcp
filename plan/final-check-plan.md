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

## Agreed after the Codex plan review (16 points)
- Read-only `analyze_code`: `OPENCODE_PERMISSION` = `{"*":"deny","read":"allow","glob":"allow","grep":"allow",
  "list":"allow","edit":"deny","bash":"deny","task":"deny","webfetch":"deny","websearch":"deny",
  "external_directory":"deny"}` (direct object; validated before launch). `edit` covers edit/write/apply_patch.
  Agent-level configuration can override: detect and refuse, or pass an explicit agent profile.
- Edits: `--agent build`, edit allowed, bash/task/web denied (the bridge runs the check); no `--auto` (unexpected
  approval requests stay rejected). Secret paths (`.git`, credentials, ignored files) excluded from reads, map and
  edits as far as permissions allow.
- Parser: incremental NDJSON across chunk boundaries, bounded lines, dedupe by tool/step id, final text = text parts
  of the last assistant message; partial text after a fatal error is not success.
- Guard adapted to OpenCode: `part.state.status/error`, `filePath`, `patchText`, bash command targets. Input budget =
  uncached input + cache read + cache write, once per step; output/reasoning/cost kept separately; overshoot by one
  step reported. Counters and one deadline cumulative across fallbacks and fix runs; a trip never triggers fallback or
  fixes.
- Fix runs: `--session <captured id>`, same directory/model/agent/permissions; never `--continue`/`--fork`; fail
  explicitly if continuation is unavailable. Fix prompt: objective, exact command/args, failure status, redacted
  tails, "never weaken the check"; optional context trimmed first.
- Recovery and verification exactly as ClineMcp Stage 12 (identity checks, retained snapshots on refusal, lock
  released on every terminal path, strict `verify` union, `none` → `passed: null`, refused executables spend no fix).
- Tests with injected spawn/timers and realistic synthetic events; temp-repo tests for restore/lock/identity.
- Order: O.1 + permission profiles → O.2 → O.3 → snapshot/lock/verify modules → O.4 → docs/review → live.

## Results (2026-11-13)
- Part A (1bdb4c6): streaming events, enforced read-only profile, guard, environment line, working rules, code map.
  Live: `analyze_code` on `opencode/glm-5.3-flash-free` answered correctly in 12 s; the model had no write or shell
  tool, and no file was created.
- Part B (c9f7c0a): `apply_opencode_edits` with the Stage 12 lifecycle. 54 tests. AGY review: approve, no findings.
- Live edits, same 7-check task as ClineMcp stage12-results.md, `opencode/glm-5.3-flash-free`, final check = all checks:

| Run | Instructions | Time | Input tokens | Checks per attempt | Fix runs | Final |
|---|---|---|---|---|---|---|
| P1 | full | 75 s | 57k | 7/7 | 0 | 7/7 |
| P2 | full | 87 s | 68k | 7/7 | 0 | 7/7 |
| P3 | full | 63 s | 45k | 7/7 | 0 | 7/7 |
| Q1 | one requirement left out | 83 s | 74k | 6/7 → 7/7 | 1 (same session) | 7/7 |

Same behaviour as the Cline bridge, at lower time and tokens on this task.
