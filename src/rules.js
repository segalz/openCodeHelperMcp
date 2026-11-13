export const WORKING_RULES = [
  "Working rules:",
  "1. Batch independent reads and searches; use glob/list to locate paths and grep for combined search patterns before reading.",
  "2. Use the code map's current-content names and 1-based line numbers directly; it may be partial. It is not an AST or a guarantee against concurrent changes.",
  "3. Use read for relevant files: under about 600 lines read whole; for longer files use offset/limit ranges of about 200 lines or more. Continue truncated output instead of re-reading it.",
  "4. Never repeat a failing call. After two failures on the same file or command, change approach or stop and report the failure.",
  "5. Use read/glob/grep/list only. Bash, edits, delegated tasks and web tools are unavailable in analysis.",
  "6. Stop when the request is answered. Within the requested format and word budget, identify evidence, unverified behavior and open questions.",
].join("\n");

export function buildEnvironmentLine(cwd, platform = process.platform) {
  return `Environment: working directory ${cwd} (current checkout); OS ${platform === "win32" ? "Windows" : platform}. Use paths under this directory. This is not a disposable worktree. Use the available read/search tools, not shell commands.`;
}
