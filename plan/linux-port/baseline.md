# openCodeHelperMcp Linux port — baseline (S0.4)

Commit `042e153` (branch `linux-support`), 2026-11-24.

## Linux VM (supervisor)

`bash scripts/linux-check.sh` (whole suite), Node v22.23.5, Linux x86_64:
`tests 354 · pass 327 · fail 0 · cancelled 0 · skipped 27` (exit 0, ~25 s).

No failing tests on Linux. Class (a): 0, class (b): 0, class (c): 0.
Note: O1-O3 are not covered by existing tests (they get new tests in Stages 2-4), so a green baseline does not mean they are fixed.

## CI (GitHub Actions) — first run

Workflow added by Claude in `a340fbe` (matches plan S0.2 byte for byte). Run: https://github.com/segalz/openCodeHelperMcp/actions/runs/45483816284

| Job | Result | tests / pass / fail / cancelled / skipped |
|-----|--------|--------------------------------------------|
| ubuntu-24.04 | success | green, same as the VM |
| ubuntu-24.04-arm | success | green |
| windows-latest | **failure** | 354 / 349 / 5 / 0 / 0 |

### windows-latest failures (first error line, suspected class)

The runner's `%TEMP%` is the 8.3 short path `C:\Users\RUNNER~1\...`, while the code resolves the long name `C:\Users\runneradmin\...` (E2). `linux-support` has no source change yet.

| # | File | Test | First error line | Suspected cause / class |
|---|------|------|------------------|--------------------------|
| W1 | `test/edits.test.js` | shared Cline-compatible lock refuses a second writer and existing foreign holder | expected `'checkout_busy'`, actual `'opencode_error'` | E2 (lock identity) or no `opencode` on the runner, unconfirmed |
| W2 | `test/edits.test.js` | MCP edits return structured verification and validate explicit model without fallback | expected `undefined`, actual `true` | unconfirmed |
| W3 | `test/edits.test.js` | structural map rebuilds at the checkout root for initial edits and repairs | `...\runneradmin\...\repo`, expected `...\RUNNER~1\...\repo` | E2 → (c) |
| W4 | `test/edits.test.js` | S8: an edit run's limit is remembered by the shared catalog, and a passing edit clears limits | expected `[['limit','opencode/test-free',...]]`, actual `[]` | unconfirmed |
| W5 | `test/plan-s20-extra.test.js` | S20 (6): oversized placeholders use size-only recovery and a running hash honours cancellation | `...\runneradmin\...\placeholder`, expected `...\RUNNER~1\...` | E2 → (c) |

**First-run GATE: failed (superseded by CI revision 2 below).** Stage 0 stops here and the owner decides.

## CI revision 2 (S0.2, Claude) — gate re-check

Workflow `1f1bad7` (Windows tests run with `TEMP`/`TMP` = the long runner temp folder). Run: https://github.com/segalz/openCodeHelperMcp/actions/runs/45488832658

| Job | Result |
|-----|--------|
| windows-latest | **success** |
| ubuntu-24.04-arm | success |
| ubuntu-24.04 | attempt 1 failed, 1 test: `test/codeindex.test.js:142` "remaining attempt time bounds the adapter and prevents late fallback" (timing). The supervisor re-ran the failed job once (attempt 2): **success** → recorded as **flaky** (timing-sensitive on a shared runner), not class (b). Watch it in S6.1 (green twice). |

All W1-W5 above were runner environment (class (c)), fixed by CI revision 2. **GATE (windows-latest green): PASS.** Stage 0 closed 2026-11-24.

## Known-flaky list (plan rule 7, "Flaky first")

| # | Where | Test | Signature | Status |
|---|-------|------|-----------|--------|
| F1 | ubuntu-24.04 | `test/codeindex.test.js:142` remaining attempt time bounds the adapter and prevents late fallback | timing; failed in run 45488832658 and again in run 45510938570 (docs-only commit 1f3e124), green on rerun both times | watch (2 sightings, timing-only, never on VM/arm/windows) |

