# openCodeHelperMcp Linux port — baseline (S0.4)

Commit `042e153` (branch `linux-support`), 2026-11-24.

## Linux VM (supervisor)

`bash scripts/linux-check.sh` (whole suite), Node v22.23.5, Linux x86_64:
`tests 354 · pass 327 · fail 0 · cancelled 0 · skipped 27` (exit 0, ~25 s).

No failing tests on Linux. Class (a): 0, class (b): 0, class (c): 0.
Note: O1-O3 are not covered by existing tests (they get new tests in Stages 2-4), so a green baseline does not mean they are fixed.

## CI (GitHub Actions)

**No CI run exists.** `.github/workflows/linux-port.yml` is still not on `linux-support`: the supervisor's GitHub token also lacks the `workflow` scope, so it cannot push workflow files.

- CI ubuntu-24.04 / ubuntu-24.04-arm / windows-latest: not run.
- **GATE (CI `windows-latest` green): NOT EVALUATED → open.** Stage 0 stops here until the workflow is pushed and its first run is read.
