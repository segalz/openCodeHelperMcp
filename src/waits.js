/**
 * Internal wait caps and budget helpers (mirrors ClineMcp `src/waits.ts`).
 *
 * Invariant:
 * - A timed-out or cancelled analysis, edit, or check settles within its budget + `SETTLE_MARGIN_MS`,
 *   or + `KILL_CONFIRM_MARGIN_MS` when process-table kill confirmation runs (including without a Job Object).
 * - Every internal wait is bounded by `min(its cap, the owning operation's remaining budget)`.
 * - A cancellation stops waiting promptly and shortens even a settlement wait already in progress.
 *   Edit baseline restoration has its own `RESTORE_BUDGET_MS` cap (below the 120 s shutdown cap).
 *   So do the post-run and post-check identity checks in `edits.js` (`unchanged(boundedSignal(RESTORE_BUDGET_MS,
 *   signal))`): they guard the snapshot, so a run that ended at its deadline may spend up to one snapshot Git
 *   call (`SNAPSHOT_GIT_TIMEOUT_MS`) more before the budget error is reported.
 * - An unconfirmed kill never triggers an automatic restore: the recovery snapshot is retained and
 *   no repair runs.
 */

/** Per-call cap for read-only snapshot Git work; bounded earlier by the owning operation's signal. */
export const SNAPSHOT_GIT_TIMEOUT_MS = 60_000;

/** Includes the identity guard, restoration, and final inventory. Below the 120 s `shutdownEdits` cap. */
export const RESTORE_BUDGET_MS = 90_000;

/** One PowerShell process-start / job-helper-build / job-owner wait cap; bounded by the caller's budget. */
export const PROCESS_QUERY_TIMEOUT_MS = 20_000;

/** One PowerShell read of the Windows process table. Two reads fit inside `TREE_KILL_CONFIRM_MS`. */
export const PROCESS_TABLE_TIMEOUT_MS = 15_000;

/** Two complete Windows process-table reads plus 2 s of slack to poll and reap. */
export const TREE_KILL_CONFIRM_MS = 2 * PROCESS_TABLE_TIMEOUT_MS + 2_000;

/** Margin used for process-table kill confirmation after timeout/cancel (one full 15 s read + 1 s polling). */
export const KILL_CONFIRM_MARGIN_MS = PROCESS_TABLE_TIMEOUT_MS + 1_000;

/** Short settle cap after a kill (also exceeds the Windows job owner's 2 s drain). */
export const KILL_SETTLE_MS = 5_000;

/** Runs/checks share one grace window after budget exhaustion or cancellation. */
export const SETTLE_MARGIN_MS = 4_000;

const MAX_TIMER_MS = 2_147_483_647;

export function boundedSignal(ms, parent) {
  if (parent?.aborted) return parent;
  if (ms === Infinity) return parent ?? new AbortController().signal;
  const timeout = new AbortController();
  const fire = () => timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  if (!(ms > 0)) fire();
  else {
    const timer = setTimeout(fire, Math.min(ms, MAX_TIMER_MS));
    timer.unref?.();
  }
  return parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
}

/**
 * One clock for confirmation and job drain. Cancellation shortens even a wait already in progress.
 * Exposes `remaining()`/`signal` (`SETTLE_MARGIN_MS`) for normal settlement and `confirmRemaining()`/`confirmSignal`
 * (`KILL_CONFIRM_MARGIN_MS`) for process-table kill confirmation.
 */
export function settlementBudget(workMs, cancel, now = () => performance.now()) {
  const safeWorkMs = workMs === Infinity ? Infinity : Math.max(0, Number.isFinite(workMs) ? workMs : 0);
  const workDeadline = safeWorkMs === Infinity ? Infinity : now() + safeWorkMs;
  let deadline = workDeadline === Infinity ? Infinity : workDeadline + SETTLE_MARGIN_MS;
  let confirmDeadline = workDeadline === Infinity ? Infinity : workDeadline + KILL_CONFIRM_MARGIN_MS;
  const controller = new AbortController();
  const confirmController = new AbortController();
  const remaining = () => deadline === Infinity ? Infinity : Math.max(0, deadline - now());
  const confirmRemaining = () => confirmDeadline === Infinity ? Infinity : Math.max(0, confirmDeadline - now());
  const expire = () => controller.abort();
  const expireConfirm = () => confirmController.abort();
  let timer;
  let confirmTimer;
  const arm = () => {
    clearTimeout(timer);
    const ms = remaining();
    if (ms <= 0) expire();
    else if (Number.isFinite(ms)) {
      timer = setTimeout(expire, Math.min(ms, MAX_TIMER_MS));
      timer.unref?.();
    }
    clearTimeout(confirmTimer);
    const confirmMs = confirmRemaining();
    if (confirmMs <= 0) expireConfirm();
    else if (Number.isFinite(confirmMs)) {
      confirmTimer = setTimeout(expireConfirm, Math.min(confirmMs, MAX_TIMER_MS));
      confirmTimer.unref?.();
    }
  };
  const onCancel = () => {
    const current = now();
    deadline = Math.min(deadline, current + SETTLE_MARGIN_MS);
    confirmDeadline = Math.min(confirmDeadline, current + KILL_CONFIRM_MARGIN_MS);
    arm();
  };
  if (cancel?.aborted) onCancel();
  else {
    arm();
    cancel?.addEventListener("abort", onCancel, { once: true });
  }
  return {
    now,
    workDeadline,
    remaining,
    signal: controller.signal,
    confirmRemaining,
    confirmSignal: confirmController.signal,
    dispose() {
      clearTimeout(timer);
      clearTimeout(confirmTimer);
      cancel?.removeEventListener("abort", onCancel);
    },
  };
}

/** Stop waiting even if a dependency cannot acknowledge cancellation. Its owner still initiates cleanup. */
export function untilAborted(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
