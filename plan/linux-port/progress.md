# openCodeHelperMcp Linux port — progress

Status: pending / red (test committed, failing as expected) / in-progress / done / escalated / skipped (reason).
Updated by the supervisor (Grok Bot) after every step.

| Step | Type | Risk | Status | Executor / model | Attempts | 1st try | Escalation | CI reverts | Minutes | Notes |
|------|------|------|--------|------------------|----------|---------|------------|------------|---------|-------|
| S0.1 | OWNER | low | done | — | — | — | — | — | — | push approved and pushed 2026-11-24 |
| S0.2 | Claude | low | done | — | — | — | — | — | — | workflow `a340fbe` + CI revision 2 `1f1bad7` (long TEMP on Windows). Run 45488832658: windows success |
| S0.3 | SUP | low | done | — | — | — | — | — | 10 | Reused ClineMcp S0.3 VM; `npm ci` OK. Cline primary `cline-free/nemotron-3.5-super-vl` (Cline account login, owner-approved), fallback `nvidia` / `nvidia/nemotron-3.5-super-vl-120b-a12b`. OpenCode primary `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`, fallback `opencode/deepseek-v4.1-flash-free`. See discovery.md |
| S0.4 | SUP | med | done | — | — | — | — | — | 20 | VM + CI arm green; ubuntu codeindex.test.js:142 flaky (failed once, re-run green). First-run windows failures were runner env (c). **GATE PASS** |
| S0.5 | SUP | med | done | — | — | — | — | — | 10 | native ELF `opencode.exe` 1.19.6; serve banner and `models --verbose` match the parsers; no own-SID children. GATE PASS |
| S1.1 | SUP | low | done | — | — | — | — | — | 2 | no class (a) tests in the baseline → no change |
| S2.1 | TEST | low | done | — | — | — | — | — | 2 | `d50b2e8`; RED as expected (ERR_MODULE_NOT_FOUND src/roots.js) |
| S2.2 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 2 | `916a9eb`: src/roots.js exact content. Linux check 5/5. CI 45505996330: all 3 jobs green (windows 359/0 fail) |
| S2.3 | TEST | low | done | — | — | — | — | — | 2 | `abc848c`; RED as expected (index.js has no roots.js import) |
| S2.4 | CODE | low | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 1 | y | none | 0 | 2 | `507dc49`: diff per spec. Linux check 29/29; VM full 333 pass / 0 fail. CI 45508052054: all green (windows 360/0 fail) |
| S3.1 | TEST | low | done | — | — | — | — | — | 2 | `f24cddc`; RED as expected (core.childEnv is not a function) |
| S3.2 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 2 | `071f5cd`: export + APPDATA-guarded npm entry, per spec. Linux check 31/31. CI 45508653975: all green (windows 362/0 fail) |
| S4.1 | TEST | low | done | — | — | — | — | — | 2 | `b321141`; RED as expected ("Verification executable was not found on PATH.") |
| S4.2 | CODE | low | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 1 | y | none | 0 | 3 | `c75daaa`: node_modules/.bin walk-up in the POSIX branch only. Linux check 2 pass / 0 fail / 11 skip; VM full 336 pass / 0 fail. CI 45509090424: all green (windows 362/0 fail) |
| S5.x | TEST/CODE | ? | skipped (none) | — | — | — | — | — | 1 | S0.4 had no class (b) items, S0.5 gate passed, and S7.2 found no port defect → no pairs |
| S6.1 | SUP | med | done | — | — | — | — | — | 5 | VM full suite twice: 363 tests, 336 pass, 0 fail, 27 skip (both runs). CI 45509090424 green on windows/ubuntu/arm |
| S6.2 | SUP | low | done | — | — | — | — | — | 5 | self-review below → owner forwards to Claude |
| S7.1 | SUP | high | done | — | — | — | — | — | 10 | `39b4e92` + `2194fe9` (prints the tool result on failure). VM only, not in CI. `SMOKE_MODEL` env picks the model (default opencode/deepseek-v4.1-flash-free) |
| S7.2 | SUP | high | done | — | — | — | — | — | 15 | Runs 1–2 with opencode/deepseek-v4.1-flash-free failed on the OpenCode free quota ("Free usage limit reached"; environment, not a port defect → no Stage 5 pair). Runs 3–4 with nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b: SMOKE PASS twice in a row; opencode process count returned to baseline after every call |
| S8 | OWNER | med | pending | — | — | — | — | — | — | real arm64 server smoke |
| S9 | OWNER | — | pending | — | — | — | — | — | — | merge decision |

## Experiment summary (fill at the end)
- CODE steps: 4 (S2.2 Cline, S2.4 OpenCode, S3.2 Cline, S4.2 OpenCode) · alone 1st try: 4 · alone within 3: 4 · after supervisor rewrite: 0 · needed Claude: 0 (Claude only for the workflow S0.2 and plan rule 7)
- Failure patterns: none in CODE steps. Environment only: OpenCode free-tier quota during the S7.2 smoke; CI flake codeindex.test.js:142 seen once in S0.4 (no reruns needed after).

## S6.2 self-review of `git diff main...linux-support` (for Claude's second review)
Changed src: `src/roots.js` (new), `src/index.js`, `src/core.js`, `src/verify.js`. Plus tests (4 new linux-*.test.js), `scripts/` (check-locked, linux-check, linux-smoke), the workflow.
- **Windows behaviour unchanged.** `roots.js` keeps the win32 branch exactly (`;` split, default `C:\Develop`, same resolve); `index.js` only imports it. `childEnv`: with APPDATA set the PATH is byte-identical to before; only the APPDATA-unset case changes (no relative `npm` entry). `verify.js` change is inside the POSIX branch only. CI windows-latest 362 tests / 0 fail.
- **PATH safety.** The relative `npm` PATH entry (cwd-dependent lookup when APPDATA is unset) is gone. The new POSIX lookup (bare names only) checks `node_modules/.bin/<cmd>` from the verify cwd upward, stopping at the first directory with `.git` (the checkout root) or `/`, with absolute paths and the existing runnable-file check. Point for Claude: a checkout-local `.bin` tool now wins over the same name on PATH (e.g. a repo could ship `node_modules/.bin/node`); confirm that matches the Windows lookup order and is acceptable.
- **Roots parsing.** POSIX splits on `:`, drops empty entries, default `~/Develop`; Windows still splits on `;` with default `C:\Develop` and `path.win32.resolve` (same as the old `path.resolve` on Windows). Covered by linux-roots / linux-index-roots tests.
- **No new shell use.** No new spawn/exec/`shell: true`; the diff only touches `childEnv` and the existing executable check.

