import { z } from "zod";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { acquire } from "./checkoutlock.js";
import { takeSnapshot, restoreSnapshot, discardSnapshot, createdFiles, headAndIndexIdentity, resolveCheckoutRoot, ignoredCheckoutPaths } from "./snapshot.js";
import { resolveVerificationCommand, runVerification, VerificationError } from "./verify.js";
import { createGuard, guardSchema } from "./guard.js";
import { emptyUsage } from "./events.js";
import { redactSecrets } from "./safety.js";
import { analysisInputSchema, DEFAULT_BUDGET_MS, resolveRequestedModels, variantFor } from "./core.js";
import { withProgressHeartbeat } from "./progress.js";
import { createEditServerScope } from "./server-pool.js";

const VERIFY_COMMAND_HELP = "Program for the final check, run without a shell. It must already be runnable before the edit "
  + "starts (it is checked up front; a tool the edit would install is refused). On Windows, npm/pnpm/yarn and "
  + "node_modules/.bin shims (vitest, tsc, eslint) are resolved to their program.";
export const verificationSchema = z.union([
  z.object({ command: z.string().min(1).refine(s => s.trim().length > 0 && !s.includes("\0")).describe(VERIFY_COMMAND_HELP),
    args: z.array(z.string().refine(s => !s.includes("\0"))).optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional() }).strict(),
  z.object({ none: z.literal(true), reason: z.string().trim().min(10).max(500) }).strict(),
]);
export const editsInputSchema = Object.freeze({
  directory: analysisInputSchema.directory,
  prompt: analysisInputSchema.prompt,
  model: analysisInputSchema.model.unwrap(),
  verify: verificationSchema,
  maxFixRuns: z.number().int().min(0).max(2).optional().describe("Automatic repairs after a failed check, default 2; same session and cumulative budgets."),
  keepOnFailure: z.boolean().optional().describe("Default false: restore pre-run bytes on failure. True keeps failed edits explicitly unverified."),
  codeMap: analysisInputSchema.codeMap,
  guard: guardSchema.optional().describe("Cumulative loop, tool-call, and input-token budgets across the edit and its repairs; any trip stops the edit without repair or fallback."),
  budgetMs: analysisInputSchema.budgetMs,
});
const inputSchema = z.object(editsInputSchema).strict().refine(input => Buffer.byteLength(JSON.stringify(input), "utf8") <= 64 * 1024, "Edit input exceeds 64 KiB.");
const failure = (kind, message) => Object.assign(new Error(message), { kind });
const QUESTION_LINE_RE = /^[-–—\s]*[*_`\[(]*(?:QUESTION|Question)[*_`\])]*:\s*(.*)$/;

function cleanQuestionRest(raw) {
  let s = String(raw ?? "").trim().replace(/[.\s]+$/, "");
  s = s.replace(/[*_`]/g, "").trim();
  s = s.replace(/^[-–—\s]+/, "").trim();
  while ((s.startsWith("(") && s.endsWith(")")) || (s.startsWith("[") && s.endsWith("]"))) {
    s = s.slice(1, -1).trim().replace(/[.\s]+$/, "");
    s = s.replace(/^[-–—\s]+/, "").trim();
  }
  return s;
}

function isNoQuestionRest(rest) {
  if (!rest) return true;
  // A question mark means a real question, even after "No ..." (plan S18, A4). Otherwise the S2 prefix rule
  // stays: models end with free text such as "None at this time." or "No, all done.".
  if (rest.includes("?")) return false;
  return /^(?:not applicable|none|nothing|n\/a|na|nil|no)(?!\w)/i.test(rest);
}

function parseQuestionLine(line) {
  const match = String(line ?? "").trim().match(QUESTION_LINE_RE);
  if (!match) return null;
  const rest = cleanQuestionRest(match[1]);
  return { isQuestion: !isNoQuestionRest(rest), rest };
}

const isInputRequired = text => {
  if (typeof text !== "string" || !text.trim()) return true;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const parsed = parseQuestionLine(lastLine);
  if (!parsed) return false;
  return parsed.isQuestion;
};
/** Exported for tests only. */
export const isInputRequiredForTest = isInputRequired;

function hasEarlierQuestion(text) {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return false;
  for (const line of lines.slice(0, -1)) {
    const parsed = parseQuestionLine(line);
    if (parsed?.isQuestion) return true;
  }
  return false;
}

/** Time kept after a run for the final check: the check timeout plus this margin. */
export const VERIFY_RESERVE_MARGIN_MS = 10_000;
/** A repair run shorter than this is not launched. */
export const MIN_FIX_RUN_MS = 30_000;

export function buildFixPrompt(objective, spec, attempt, root) {
  const mandatory = `Objective:\n${objective}\n\nVerification cwd: ${root}\nExact verification command and literal args:\n${JSON.stringify(spec)}\nFix only what the check reports. Fix the code; never weaken or bypass the check. Retain existing partial edits.\nPrevious check: exit=${attempt.exitCode}; signal=${attempt.signal}; timedOut=${attempt.timedOut}; killedForOutput=${attempt.killedForOutput}\n`;
  if (mandatory.length > 18000) throw failure("prompt_limit", "Objective and exact verification specification exceed repair prompt limits.");
  let stdout = redactSecrets(attempt.stdoutTail ?? ""), stderr = redactSecrets(attempt.stderrTail ?? "");
  const render = () => mandatory + `stdout tail:\n${stdout}\nstderr tail:\n${stderr}`;
  while (render().length > 18000 && (stdout || stderr)) { stdout = stdout.slice(-Math.floor(stdout.length / 2)); stderr = stderr.slice(-Math.floor(stderr.length / 2)); if (stdout.length === 1) stdout = ""; if (stderr.length === 1) stderr = ""; }
  return render();
}

/**
 * The requested folder spelled under `root`, or undefined when it is outside. Both sides are canonicalised first
 * (symlinks, junctions, macOS /tmp), as the checkout root itself comes from realpath. Mirrors ClineMcp finalcheck.ts.
 */
export async function subfolderOf(root, directory) {
  const [realRoot, realDirectory] = await Promise.all([realpath(root).catch(() => path.resolve(root)),
    realpath(directory).catch(() => path.resolve(directory))]);
  const inside = path.relative(realRoot, realDirectory);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  return inside ? path.join(root, inside) : root;
}

/** A single synchronous transaction over working-tree bytes, never Git history. */
export async function runEdits(rawInput, {
  runner, verifyImpl = runVerification, resolveRoot = resolveCheckoutRoot,
  // Up-front check that the verify command can start; skipped when only a custom verifyImpl is injected.
  resolveVerifyImpl = verifyImpl === runVerification ? resolveVerificationCommand : undefined,
  takeSnapshotImpl = takeSnapshot, restoreSnapshotImpl = restoreSnapshot,
  discardSnapshotImpl = discardSnapshot, identityImpl = headAndIndexIdentity, createdFilesImpl = createdFiles,
  ignoredPathsImpl = ignoredCheckoutPaths, lockDirectory, snapshotOptions,
  signal, deadline: outerDeadline, nowImpl = Date.now, variant,
} = {}) {
  const input = inputSchema.parse(rawInput);
  const started = nowImpl(), deadline = outerDeadline ?? started + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, deadline - nowImpl()));
  const limits = guardSchema.parse(input.guard ?? {}), guardState = createGuard(limits), usage = emptyUsage();
  const editScope = createEditServerScope();
  const verification = { required: !("none" in input.verify), passed: null, command: "none" in input.verify ? null : input.verify,
    ...("none" in input.verify ? { reason: input.verify.reason } : {}), attempts: [], fixRuns: 0, restored: false, kept: false };
  const result = { status: "failed", model: input.model, codeMapSource: "none", verification, usage, evidence: {} };
  let unconfirmedKill = false;
  // root: the checkout (lock, identity, snapshot). workDir: the requested folder, maybe a monorepo package, where
  // OpenCode and the final check run.
  let root, workDir, release, snapshot, identity, completed = false, sessionID;
  // A stopped run, verify, or server whose processes were not confirmed dead: retain the recovery snapshot.
  const warnIfStillRunning = (outcome) => {
    if (outcome?.killConfirmed !== false) return;
    unconfirmedKill = true;
    const warning = completed
      ? "A process from the stopped edit server may still be running; files may change."
      : "A process from the stopped run may still be running; files may change after the restore.";
    result.warnings ??= [];
    if (!result.warnings.includes(warning)) result.warnings.push(warning);
    const alive = Array.isArray(outcome.stillAlive) ? outcome.stillAlive : [];
    result.evidence.processesStillAlive = [...new Set([...(result.evidence.processesStillAlive ?? []), ...alive])];
  };
  const check = () => {
    if (signal?.aborted) throw failure("cancelled", "Edit lifecycle cancelled.");
    if (controller.signal.aborted || nowImpl() >= deadline) throw failure("budget_exceeded", "Overall edit deadline exhausted.");
  };
  // Recovery deliberately uses its own bounded Git calls after the active deadline.
  const unchanged = async (active = true) => {
    if (!identity) return;
    try {
      const current = await identityImpl(root, active ? controller.signal : undefined);
      if (current.head === identity.head && current.indexHash === identity.indexHash) return;
      result.evidence.identity = { before: identity, after: current };
    } catch (error) { result.evidence.identityError = redactSecrets(String(error)); }
    throw failure("identity_changed", "HEAD/index changed or could not be inspected; restoration refused and recovery snapshot retained.");
  };
  const discard = async (reportCreated = false) => {
    // Report every new file the kept edit left behind (a stray debug script, too); report-only.
    if (reportCreated && Array.isArray(snapshot?.manifest)) {
      try {
        const created = await createdFilesImpl(snapshot);
        if (created.length) {
          result.createdFiles = created;
          (result.warnings ??= []).push(`The edit created ${created.length} new file(s): ${created.slice(0, 20).join(", ")}${created.length > 20 ? ", ..." : ""}. Check each belongs to the task.`);
        }
      } catch { /* report-only */ }
    }
    if (unconfirmedKill) return;
    try { await discardSnapshotImpl(snapshot); snapshot = undefined; delete result.evidence.snapshotDirectory; }
    catch (error) { result.evidence.cleanupError = redactSecrets(String(error)); }
  };
  try {
    check(); root = await resolveRoot(input.directory, controller.signal); check();
    workDir = await subfolderOf(root, input.directory);
    if (workDir === undefined) throw failure("edits_refused", "The directory is not inside its Git checkout.");
    // A check that cannot even start makes the run pointless: refuse before the lock, the snapshot and any launch.
    if (verification.required && resolveVerifyImpl) {
      try { await resolveVerifyImpl(input.verify.command, input.verify.args ?? [], workDir); }
      catch (error) {
        if (error instanceof VerificationError) throw failure(error.kind, error.message);
        throw error;
      }
      check();
    }
    release = await acquire(root, { lockDirectory });
    identity = await identityImpl(root, controller.signal); check();
    snapshot = await takeSnapshotImpl(root, { ...snapshotOptions, signal: controller.signal });
    result.evidence.snapshotDirectory = snapshot.directory;
    check(); await unchanged();
    const ignoredPaths = await ignoredPathsImpl(root, controller.signal); check();
    let prompt = input.prompt;
    for (let run = 0; ; run++) {
      check(); await unchanged(); check();
      if (run && !sessionID) throw failure("session_unavailable", "Cannot repair: OpenCode did not return a continuation session ID.");
      if (guardState.snapshot().kind) throw failure(guardState.snapshot().kind, "Guard stopped edits; no repair launch is allowed.");
      const counters = guardState.snapshot();
      if (counters.totalToolCalls >= limits.maxToolCalls || counters.budgetInputTokens >= limits.maxInputTokens) {
        result.guard = { ...counters, kind: "budget_exceeded" };
        throw failure("budget_exceeded", "Cumulative edit guard budget exhausted before launch.");
      }
      // Keep time for the final check (and restore) so a run that finishes late is still verified.
      const reserveMs = verification.required ? (input.verify.timeoutSeconds ?? 60) * 1000 + VERIFY_RESERVE_MARGIN_MS : 0;
      const runMs = deadline - nowImpl() - reserveMs;
      if (!run && runMs < 1_000) throw failure("budget_exceeded", "Not enough budget for a run and its final check.");
      if (run && runMs < MIN_FIX_RUN_MS) throw failure("budget_exceeded", "Not enough budget left for another repair run and its check.");
      if (run) verification.fixRuns++;
      let response;
      try { response = await runner({ directory: workDir, checkoutRoot: root, prompt, model: input.model, variant, mode: "edits", codeMap: input.codeMap ?? true,
        guardState, sessionID, ignoredPaths, editScope, signal: controller.signal,
        timeoutMs: runMs }); }
      catch (error) {
        response = {
          error: redactSecrets(String(error)), usage: error?.usage, guard: error?.guard,
          ...(error?.killConfirmed === false ? { killConfirmed: false, stillAlive: error.stillAlive } : {}),
        };
      }
      result.codeMapSource = response?.codeMapSource ?? "none";
      if (response?.usage) for (const key of Object.keys(usage)) usage[key] += Number.isFinite(response.usage[key]) ? response.usage[key] : 0;
      if (response?.guard?.kind) result.guard = response.guard;
      if (response?.limitKind) result.limitKind = response.limitKind;
      warnIfStillRunning(response);
      const returnedSession = response?.sessionID;
      await unchanged(false); check();
      if (sessionID && returnedSession !== sessionID && (returnedSession || !response?.error)) throw failure("session_mismatch", "OpenCode repair did not continue the expected session.");
      sessionID = returnedSession ?? sessionID; result.sessionID = sessionID;
      if (response?.error || response?.guard?.kind || guardState.snapshot().kind) throw failure(response?.guard?.kind ?? guardState.snapshot().kind ?? "opencode_error", response?.error ?? "Guard stopped edits.");
      if (response?.killConfirmed === false) throw failure("process_still_running", "A process from the stopped edit run may still be running.");
      if (isInputRequired(response?.text)) throw failure("input_required", "OpenCode returned no final answer or requested caller input.");
      result.text = response.text;
      if (hasEarlierQuestion(response?.text)) {
        const warning = "The model asked a question on an earlier line; caller should read text.";
        result.warnings ??= [];
        if (!result.warnings.includes(warning)) result.warnings.push(warning);
      }
      if (!verification.required) break;
      let attempt;
      try { attempt = await verifyImpl(input.verify, workDir, controller.signal); }
      catch (error) {
        if (!(error instanceof VerificationError)) throw error;
        attempt = { passed: false, exitCode: null, signal: null, timedOut: false, killedForOutput: false, durationMs: 0, stdoutTail: "", stderrTail: redactSecrets(error.message), error: error.kind };
      }
      warnIfStillRunning(attempt);
      const passed = Boolean(attempt.passed) && attempt.killConfirmed !== false;
      attempt = { ...attempt, passed, run: run + 1, stdoutTail: redactSecrets(attempt.stdoutTail ?? ""), stderrTail: redactSecrets(attempt.stderrTail ?? "") };
      verification.attempts.push(attempt); verification.passed = attempt.passed;
      await unchanged(false); check();
      if (attempt.passed) break;
      if (attempt.error || attempt.killConfirmed === false || run >= (input.maxFixRuns ?? 2)) throw failure("verify_failed", "Final verification failed; no further automatic repairs are allowed.");
      prompt = buildFixPrompt(input.prompt, input.verify, attempt, workDir);
    }
    completed = true;
    try { await editScope.close(); } catch (closeError) {
      if (closeError?.kind === "server_stop_unconfirmed") warnIfStillRunning(closeError);
      else (result.warnings ??= []).push(`Could not stop the OpenCode edit server cleanly: ${redactSecrets(closeError?.message ?? String(closeError))}`);
    }
    await discard(true); result.status = "done";
  } catch (error) {
    result.error = error?.kind ?? "edits_failed"; result.message = redactSecrets(error?.message ?? String(error));
    if (snapshot && !completed) {
      try {
        try { await editScope.close(); } catch (closeError) {
          if (closeError?.kind !== "server_stop_unconfirmed") throw closeError;
          warnIfStillRunning(closeError);
        }
        await unchanged(false);
        if (input.keepOnFailure) { verification.kept = true; await discard(true); }
        else {
          const report = await restoreSnapshotImpl(snapshot); result.evidence.restore = report;
          if (report.failed.length) throw failure("restore_failed", "Restoration incomplete; recovery bytes retained.");
          verification.restored = true; await discard();
        }
      } catch (recoveryError) {
        result.evidence.recoveryError = redactSecrets(String(recoveryError));
        if (recoveryError?.kind === "identity_changed" && input.keepOnFailure) verification.kept = true;
      }
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    release?.(); result.guard ??= guardState.snapshot(); result.elapsedMs = nowImpl() - started;
  }
  return result;
}

/** Edit calls in flight: shutdown aborts them and waits for their restore and lock release. */
export const activeEditCalls = new Set();

/** Abort every in-flight edit (as a client cancel) and wait for each to finish its recovery. */
export async function shutdownEdits(waitMs = 120_000) {
  const calls = [...activeEditCalls];
  for (const call of calls) call.abort();
  let timer;
  await Promise.race([
    Promise.allSettled(calls.map((call) => call.done)),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
}

export function registerEditTools(server, { runner, catalog, resolveAllowedPath, isAbsolute = path.isAbsolute, nowImpl = Date.now, lifecycleOptions = {} }) {
  server.registerTool("apply_opencode_edits", {
    title: "Apply verified OpenCode edits", inputSchema: editsInputSchema,
    description: "Edit one Git checkout using one explicit free model and build agent; shell/delegates/web denied. Required final check, up to two same-session repairs, shared Cline writer lock, one recovery snapshot, cumulative guard/deadline. Restores failed edits unless keepOnFailure=true; identity changes retain recovery evidence. Synchronous; no fallback.",
  }, async (raw, extra = {}) => withProgressHeartbeat(extra, async () => {
    const deadline = nowImpl() + (raw?.budgetMs ?? DEFAULT_BUDGET_MS);
    // `controller` stops preparation on a client cancel or the deadline. Only a real client cancel
    // reaches runEdits as `signal`; runEdits owns the deadline, so an exhausted budget is reported as
    // budget_exceeded and never as cancelled (the 2026-11-17 "Edit lifecycle cancelled" report).
    const controller = new AbortController(), abort = () => controller.abort();
    const user = new AbortController(), userAbort = () => { user.abort(); abort(); };
    const timer = setTimeout(abort, Math.max(1, deadline - nowImpl()));
    extra.signal?.addEventListener("abort", userAbort, { once: true }); if (extra.signal?.aborted) userAbort();
    const active = operation => new Promise((resolve, reject) => {
      const cancelled = () => { cleanup(); reject(new Error("Edit preparation cancelled or deadline exhausted.")); };
      const cleanup = () => controller.signal.removeEventListener("abort", cancelled);
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    const respond = result => ({ ...(result.error ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify({ codeMapSource: "none", ...result }, null, 2) }] });
    try {
      const input = inputSchema.parse(raw);
      if (!isAbsolute(input.directory)) throw new Error("directory must be absolute.");
      const directory = await active(() => resolveAllowedPath(input.directory));
      if (!directory) throw new Error("The directory is outside the helper's allowed roots.");
      const listed = await active(() => catalog.list()); if (listed.error) throw new Error(listed.error);
      const selected = resolveRequestedModels({ model: input.model }, listed.models); if (selected.error) throw new Error(selected.error);
      const resolveRoot = async (dir, signal) => {
        const root = await resolveCheckoutRoot(dir, signal);
        if (!await active(() => resolveAllowedPath(root))) throw new Error("Git checkout root is outside the allowed roots.");
        return root;
      };
      const model = selected.models[0];
      const running = runEdits({ ...input, directory }, { ...lifecycleOptions, runner, resolveRoot, nowImpl, deadline, signal: user.signal, variant: variantFor(model) });
      const call = { abort: userAbort, done: running };
      activeEditCalls.add(call);
      try {
        const result = await running;
        if (result.limitKind) catalog.recordLimit?.(model, { kind: result.limitKind, message: result.message ?? result.error });
        else if (result.verification?.passed) catalog.recordSuccess?.(model);
        return respond(result);
      } finally { activeEditCalls.delete(call); }
    } catch (error) {
      // A stop during preparation is the caller cancel or the spent budget, not a refused request (plan S15 review).
      const kind = user.signal.aborted ? "cancelled" : controller.signal.aborted ? "budget_exceeded" : "edits_refused";
      return respond({ error: kind, message: redactSecrets(error?.message ?? String(error)) });
    }
    finally { clearTimeout(timer); extra.signal?.removeEventListener("abort", userAbort); }
  }));
}
