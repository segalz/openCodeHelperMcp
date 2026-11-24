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
| S2.3 | TEST | low | pending | — | — | — | — | — | — | linux-index-roots.test.js |
| S2.4 | CODE | low | pending | | | | | | | index.js uses roots.js |
| S3.1 | TEST | low | pending | — | — | — | — | — | — | linux-childenv.test.js |
| S3.2 | CODE | low | pending | | | | | | | childEnv: no relative PATH (security) |
| S4.1 | TEST | low | pending | — | — | — | — | — | — | linux-verify-bin.test.js |
| S4.2 | CODE | low | pending | | | | | | | node_modules/.bin on POSIX |
| S5.x | TEST/CODE | ? | pending | | | | | | | from baseline class (b) / discovery |
| S6.1 | SUP | med | pending | — | — | — | — | — | — | full green x2 + CI |
| S6.2 | SUP | low | pending | — | — | — | — | — | — | self-review → Claude |
| S7.1 | SUP | high | pending | — | — | — | — | — | — | linux-smoke.mjs (OPENCODE_HELPER_SERVE=0) |
| S7.2 | SUP | high | pending | — | — | — | — | — | — | smoke green x2 |
| S8 | OWNER | med | pending | — | — | — | — | — | — | real arm64 server smoke |
| S9 | OWNER | — | pending | — | — | — | — | — | — | merge decision |

## Experiment summary (fill at the end)
- CODE steps: — · alone 1st try: — · alone within 3: — · after supervisor rewrite: — · needed Claude: —
- Failure patterns:
