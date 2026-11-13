import { z } from "zod";
import path from "node:path";
import { acquire } from "./checkoutlock.js";
import { takeSnapshot, restoreSnapshot, discardSnapshot, headAndIndexIdentity, resolveCheckoutRoot, ignoredCheckoutPaths } from "./snapshot.js";
import { runVerification, VerificationError } from "./verify.js";
import { createGuard, guardSchema } from "./guard.js";
import { emptyUsage } from "./events.js";
import { redactSecrets } from "./safety.js";
import { analysisInputSchema, DEFAULT_BUDGET_MS, resolveRequestedModels, variantFor } from "./core.js";

export const verificationSchema = z.union([
  z.object({ command: z.string().min(1).refine(s => s.trim().length > 0 && !s.includes("\0")),
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
  guard: analysisInputSchema.guard,
  budgetMs: analysisInputSchema.budgetMs,
});
const inputSchema = z.object(editsInputSchema).strict().refine(input => Buffer.byteLength(JSON.stringify(input), "utf8") <= 64 * 1024, "Edit input exceeds 64 KiB.");
const failure = (kind, message) => Object.assign(new Error(message), { kind });

export function buildFixPrompt(objective, spec, attempt, root) {
  const mandatory = `Objective:\n${objective}\n\nVerification cwd: ${root}\nExact verification command and literal args:\n${JSON.stringify(spec)}\nFix only what the check reports. Fix the code; never weaken or bypass the check. Retain existing partial edits.\nPrevious check: exit=${attempt.exitCode}; signal=${attempt.signal}; timedOut=${attempt.timedOut}; killedForOutput=${attempt.killedForOutput}\n`;
  if (mandatory.length > 18000) throw failure("prompt_limit", "Objective and exact verification specification exceed repair prompt limits.");
  let stdout = redactSecrets(attempt.stdoutTail ?? ""), stderr = redactSecrets(attempt.stderrTail ?? "");
  const render = () => mandatory + `stdout tail:\n${stdout}\nstderr tail:\n${stderr}`;
  while (render().length > 18000 && (stdout || stderr)) { stdout = stdout.slice(-Math.floor(stdout.length / 2)); stderr = stderr.slice(-Math.floor(stderr.length / 2)); if (stdout.length === 1) stdout = ""; if (stderr.length === 1) stderr = ""; }
  return render();
}

/** A single synchronous transaction over working-tree bytes, never Git history. */
export async function runEdits(rawInput, {
  runner, verifyImpl = runVerification, resolveRoot = resolveCheckoutRoot,
  takeSnapshotImpl = takeSnapshot, restoreSnapshotImpl = restoreSnapshot,
  discardSnapshotImpl = discardSnapshot, identityImpl = headAndIndexIdentity,
  ignoredPathsImpl = ignoredCheckoutPaths, lockDirectory, snapshotOptions,
  signal, deadline: outerDeadline, nowImpl = Date.now, variant,
} = {}) {
  const input = inputSchema.parse(rawInput);
  const started = nowImpl(), deadline = outerDeadline ?? started + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, deadline - nowImpl()));
  const limits = guardSchema.parse(input.guard ?? {}), guardState = createGuard(limits), usage = emptyUsage();
  const verification = { required: !("none" in input.verify), passed: null, command: "none" in input.verify ? null : input.verify,
    ...("none" in input.verify ? { reason: input.verify.reason } : {}), attempts: [], fixRuns: 0, restored: false, kept: false };
  const result = { status: "failed", model: input.model, verification, usage, evidence: {} };
  let root, release, snapshot, identity, identityRefused = false, completed = false, sessionID;
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
    identityRefused = true;
    throw failure("identity_changed", "HEAD/index changed or could not be inspected; restoration refused and recovery snapshot retained.");
  };
  const discard = async () => {
    try { await discardSnapshotImpl(snapshot); snapshot = undefined; delete result.evidence.snapshotDirectory; }
    catch (error) { result.evidence.cleanupError = redactSecrets(String(error)); }
  };
  try {
    check(); root = await resolveRoot(input.directory, controller.signal); check();
    release = acquire(root, { lockDirectory });
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
      if (counters.totalToolCalls >= limits.maxToolCalls || counters.totalInputTokens >= limits.maxInputTokens) {
        result.guard = { ...counters, kind: "budget_exceeded" };
        throw failure("budget_exceeded", "Cumulative edit guard budget exhausted before launch.");
      }
      if (run) verification.fixRuns++;
      let response;
      try { response = await runner({ directory: root, prompt, model: input.model, variant, mode: "edits", codeMap: input.codeMap ?? true,
        guardState, sessionID, ignoredPaths, signal: controller.signal, timeoutMs: Math.max(1, deadline - nowImpl()) }); }
      catch (error) { response = { error: redactSecrets(String(error)), usage: error?.usage, guard: error?.guard }; }
      if (response?.usage) for (const key of Object.keys(usage)) usage[key] += Number.isFinite(response.usage[key]) ? response.usage[key] : 0;
      if (response?.guard?.kind) result.guard = response.guard;
      const returnedSession = response?.sessionID;
      await unchanged(false); check();
      if (sessionID && returnedSession !== sessionID && (returnedSession || !response?.error)) throw failure("session_mismatch", "OpenCode repair did not continue the expected session.");
      sessionID = returnedSession ?? sessionID; result.sessionID = sessionID;
      if (response?.error || response?.guard?.kind || guardState.snapshot().kind) throw failure(response?.guard?.kind ?? guardState.snapshot().kind ?? "opencode_error", response?.error ?? "Guard stopped edits.");
      if (!response?.text || /^\s*(?:QUESTION|Question):/m.test(response.text)) throw failure("input_required", "OpenCode returned no final answer or requested caller input.");
      result.text = response.text;
      if (!verification.required) break;
      let attempt;
      try { attempt = await verifyImpl(input.verify, root, controller.signal); }
      catch (error) {
        if (!(error instanceof VerificationError)) throw error;
        attempt = { passed: false, exitCode: null, signal: null, timedOut: false, killedForOutput: false, durationMs: 0, stdoutTail: "", stderrTail: redactSecrets(error.message), error: error.kind };
      }
      attempt = { ...attempt, run: run + 1, stdoutTail: redactSecrets(attempt.stdoutTail ?? ""), stderrTail: redactSecrets(attempt.stderrTail ?? "") };
      verification.attempts.push(attempt); verification.passed = attempt.passed;
      await unchanged(false); check();
      if (attempt.passed) break;
      if (attempt.error || run >= (input.maxFixRuns ?? 2)) throw failure("verify_failed", "Final verification failed; no further automatic repairs are allowed.");
      prompt = buildFixPrompt(input.prompt, input.verify, attempt, root);
    }
    await unchanged(false); check(); completed = true;
    await discard(); result.status = "done";
  } catch (error) {
    result.error = error?.kind ?? "edits_failed"; result.message = redactSecrets(error?.message ?? String(error));
    if (snapshot && !completed) {
      try {
        await unchanged(false);
        if (input.keepOnFailure) { verification.kept = true; await discard(); }
        else {
          const report = await restoreSnapshotImpl(snapshot); result.evidence.restore = report;
          if (report.failed.length) throw failure("restore_failed", "Restoration incomplete; recovery bytes retained.");
          verification.restored = true; await discard();
        }
      } catch (recoveryError) { result.evidence.recoveryError = redactSecrets(String(recoveryError)); }
    }
    if (identityRefused && input.keepOnFailure) verification.kept = true;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    release?.(); result.guard ??= guardState.snapshot(); result.elapsedMs = nowImpl() - started;
  }
  return result;
}

export function registerEditTools(server, { runner, catalog, resolveAllowedPath, isAbsolute = path.isAbsolute, nowImpl = Date.now, lifecycleOptions = {} }) {
  server.registerTool("apply_opencode_edits", {
    title: "Apply verified OpenCode edits", inputSchema: editsInputSchema,
    description: "Edit one Git checkout using one explicit free model and build agent; shell/delegates/web denied. Required final check, up to two same-session repairs, shared Cline writer lock, one recovery snapshot, cumulative guard/deadline. Restores failed edits unless keepOnFailure=true; identity changes retain recovery evidence. Synchronous; no fallback.",
  }, async (raw, extra = {}) => {
    const deadline = nowImpl() + (raw?.budgetMs ?? DEFAULT_BUDGET_MS);
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, Math.max(1, deadline - nowImpl()));
    extra.signal?.addEventListener("abort", abort, { once: true }); if (extra.signal?.aborted) abort();
    const active = operation => new Promise((resolve, reject) => {
      const cancelled = () => { cleanup(); reject(new Error("Edit preparation cancelled or deadline exhausted.")); };
      const cleanup = () => controller.signal.removeEventListener("abort", cancelled);
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    const respond = result => ({ ...(result.error ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
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
      return respond(await runEdits({ ...input, directory }, { ...lifecycleOptions, runner, resolveRoot, nowImpl, deadline, signal: controller.signal, variant: variantFor(selected.models[0]) }));
    } catch (error) { return respond({ error: "edits_refused", message: redactSecrets(error?.message ?? String(error)) }); }
    finally { clearTimeout(timer); extra.signal?.removeEventListener("abort", abort); }
  });
}
