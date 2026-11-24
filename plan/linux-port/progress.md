# openCodeHelperMcp Linux port — progress

Status: pending / red (test committed, failing as expected) / in-progress / done / escalated / skipped (reason).
Updated by the supervisor (Grok Bot) after every step.

| Step | Type | Risk | Status | Executor / model | Attempts | 1st try | Escalation | CI reverts | Minutes | Notes |
|------|------|------|--------|------------------|----------|---------|------------|------------|---------|-------|
| S0.1 | OWNER | low | done | — | — | — | — | — | — | push approved and pushed 2026-11-24 |
| S0.2 | Claude | low | done | — | — | — | — | — | — | check-locked.sh, linux-check.sh, CI workflow, .gitattributes (2026-11-24) |
| S0.3 | SUP | low | pending | — | — | — | — | — | — | VM: Node 22, opencode, cline + free-model access (reuse ClineMcp S0.3) |
| S0.4 | SUP | med | pending | — | — | — | — | — | — | baseline.md |
| S0.5 | SUP | med | pending | — | — | — | — | — | — | discovery.md (serve banner, models --verbose, SIDs) |
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
