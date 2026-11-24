# openCodeHelperMcp Linux port — progress

Status: pending / red (test committed, failing as expected) / in-progress / done / escalated / skipped (reason).
Updated by the supervisor (Grok Bot) after every step.

| Step | Type | Risk | Status | Executor / model | Attempts | 1st try | Escalation | CI reverts | Minutes | Notes |
|------|------|------|--------|------------------|----------|---------|------------|------------|---------|-------|
| S0.1 | OWNER | low | done | — | — | — | — | — | — | push approved and pushed 2026-11-24 |
| S0.2 | Claude | low | in-progress | — | — | — | — | — | — | scripts + .gitattributes pushed 2026-11-24; CI workflow NOT pushed: owner token and supervisor token both lack the `workflow` scope (supervisor checked 2026-11-24). Needs the owner/Claude with `workflow` scope |
| S0.3 | SUP | low | in-progress | — | — | — | — | — | 5 | Reused ClineMcp S0.3 VM; `npm ci` OK. OpenCode free model works (`opencode/deepseek-v4.1-flash-free`); Cline BLOCKED on owner (Cline login or NVIDIA_API_KEY). See discovery.md |
| S0.4 | SUP | med | in-progress | — | — | — | — | — | 5 | Linux VM: 354 tests, 327 pass, 0 fail, 27 skipped. CI not run (no workflow) → windows GATE not evaluated. See baseline.md |
| S0.5 | SUP | med | done | — | — | — | — | — | 10 | native ELF `opencode.exe` 1.19.6; serve banner and `models --verbose` match the parsers; no own-SID children. GATE PASS |
| S1.1 | SUP | low | pending | — | — | — | — | — | — | skip class (a) tests |
| S2.1 | TEST | low | pending | — | — | — | — | — | — | linux-roots.test.js |
| S2.2 | CODE | low | pending | | | | | | | src/roots.js |
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
