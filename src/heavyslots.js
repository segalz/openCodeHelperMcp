/**
 * Shared v1 heavy-run protocol (UTF-8 JSON). All bridges use the same BRIDGE_HEAVY_DIR
 * and BRIDGE_HEAVY_SLOTS (default 2, 1..8). Under admission.lock, publish tickets in
 * queue/<epoch-ms>-<pid>-<uuid>.json with ms >= newest ticket ms + 1. Sort by ms then
 * filename. Only the head may publish slot-<1..N>.json. All publications hard-link a
 * completely written unique sibling; .tmp files have no authority.
 *
 * Locks carry {pid,time,token}; slots and tickets also carry {bridge,kind:"edit",
 * checkout,started_at}. Times are UTC ISO strings, token is a UUID, checkout is SHA-256
 * of the UTF-8 canonical root (lowercase on Windows). Retained leases add survivors
 * (PID array) and survivor_time (observation time). Reclaim only when the owner AND all
 * survivors are gone or their PID was reused (5 s tolerance). Windows readers query
 * process existence/start time non-destructively. Unknown identities stay busy.
 * Admission lock recovery uses checkoutlock's .reap and .reap-claims protocol. Slot
 * and ticket reapers compare exact dead metadata again under admission.lock. Owners
 * remove only their own token. state.json {version:1,slots,active:[{bridge,kind,
 * started_at}],queued,updated_at} is an atomic best-effort hint; readers recount.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalCheckoutPath, CheckoutBusyError, claimFile, deadHolderText, fileLease, publishHolder } from "./checkoutlock.js";

export class MachineBusyError extends Error {
  constructor(message) {
    super(message);
    this.kind = "machine_busy";
    this.name = "MachineBusyError";
  }
}

/** How often this process retries unlinking tickets whose removal failed, even if no caller polls again. */
export const FAILED_TICKET_RETRY_INTERVAL_MS = 1_000;

/** Tickets owned by this process whose removal failed; retried both on an unref'd interval and under admission.lock. */
const failedTickets = new Map();
let failedTicketRetryMs = FAILED_TICKET_RETRY_INTERVAL_MS;
let failedTicketTimer;
let failedTicketExitListener;

/** Test seam for background failed-ticket retry cadence (call with no args to restore the default). */
export function setFailedTicketRetryIntervalMs(ms = FAILED_TICKET_RETRY_INTERVAL_MS) {
  failedTicketRetryMs = Math.max(1, ms);
}

function stopFailedTicketRetry() {
  if (failedTicketTimer) {
    clearInterval(failedTicketTimer);
    failedTicketTimer = undefined;
  }
  if (failedTicketExitListener) {
    process.off("exit", failedTicketExitListener);
    failedTicketExitListener = undefined;
  }
}

function retryFailedTickets(onlyDir) {
  let removed = false;
  const touchedDirs = new Map();
  for (const [file, entry] of [...failedTickets]) {
    if (onlyDir && entry.dir !== onlyDir) {
      if (!existsSync(entry.dir)) failedTickets.delete(file);
      continue;
    }
    if (!existsSync(entry.dir) || fileLease(file, entry.token)()) {
      failedTickets.delete(file);
      removed = true;
      if (existsSync(entry.dir)) touchedDirs.set(entry.dir, entry.slots);
    }
  }
  if (!onlyDir) {
    for (const [dir, slots] of touchedDirs) updateState(dir, slots);
  }
  if (failedTickets.size === 0) stopFailedTicketRetry();
  return removed;
}

function ensureFailedTicketRetry() {
  if (failedTicketTimer || failedTickets.size === 0) return;
  const stop = () => stopFailedTicketRetry();
  failedTicketExitListener = stop;
  process.once("exit", stop);
  failedTicketTimer = setInterval(() => {
    retryFailedTickets();
  }, failedTicketRetryMs);
  failedTicketTimer.unref?.();
}

function releaseTicket(dir, name, token, slots) {
  const file = path.join(dir, "queue", name);
  const ok = fileLease(file, token)();
  if (ok) {
    failedTickets.delete(file);
    if (failedTickets.size === 0) stopFailedTicketRetry();
  } else {
    failedTickets.set(file, { dir, name, token, slots });
    ensureFailedTicketRetry();
  }
  return ok;
}

const ticketPattern = /^(\d+)-\d+-[\da-f-]+\.json$/i;
function tickets(dir) {
  return readdirSync(path.join(dir, "queue")).filter(name => ticketPattern.test(name))
    .sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : a > b ? 1 : 0));
}
function slotFiles(dir) {
  return readdirSync(dir).filter(name => /^slot-[1-8]\.json$/.test(name));
}
function contents(file) {
  try { return readFileSync(file, "utf8"); }
  catch (err) { if (err?.code !== "ENOENT") throw err; }
}

function updateState(dir, slots) {
  const tmp = path.join(dir, "state." + randomUUID() + ".tmp");
  try {
    const active = slotFiles(dir).flatMap(name => {
      const text = contents(path.join(dir, name));
      if (text === undefined) return [];
      const { bridge, kind, started_at } = JSON.parse(text);
      return [{ bridge, kind, started_at }];
    });
    writeFileSync(tmp, JSON.stringify({
      version: 1, slots, active, queued: tickets(dir).length,
      updated_at: new Date().toISOString(),
    }), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path.join(dir, "state.json"));
  } catch { /* A reader or a concurrent hint writer can hold state.json open on Windows. */ }
  finally { try { rmSync(tmp, { force: true }); } catch { /* hint only */ } }
}

/** Query processes outside the critical section. Reap only unchanged candidates inside it. */
async function staleCandidates(dir, signal, startCache) {
  const dead = new Map();
  for (const name of [...slotFiles(dir), ...tickets(dir).map(name => path.join("queue", name))]) {
    signal.throwIfAborted();
    const file = path.join(dir, name);
    const text = contents(file);
    if (text !== undefined && await deadHolderText(text, signal, startCache)) dead.set(file, text);
  }
  return dead;
}

export async function acquireHeavySlot(root, waitMs, signal, onQueue) {
  const dir = process.env.BRIDGE_HEAVY_DIR || path.join(os.homedir(), ".cline-mcp", "heavy");
  const configured = Number(process.env.BRIDGE_HEAVY_SLOTS || 2);
  const slots = Number.isInteger(configured) ? Math.max(1, Math.min(8, configured)) : 2;
  mkdirSync(path.join(dir, "queue"), { recursive: true });
  const token = randomUUID();
  const time = new Date().toISOString();
  const metadata = {
    pid: process.pid, time, token, bridge: "opencode", kind: "edit",
    checkout: createHash("sha256").update(canonicalCheckoutPath(root)).digest("hex"), started_at: time,
  };
  const admission = path.join(dir, "admission.lock");
  let ticket;
  const startCache = new Map();
  const busy = () => new MachineBusyError(
    `Heavy-run slots busy: ${slotFiles(dir).length} active, ${tickets(dir).length} queued. Retry later or send the edit elsewhere.`,
  );
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(waitMs())));
  const waiting = AbortSignal.any([signal, deadline]);
  try {
    while (true) {
      waiting.throwIfAborted();
      const dead = await staleCandidates(dir, waiting, startCache);
      const admissionToken = randomUUID();
      let admitted = false;
      try {
        await claimFile(admission, admissionToken, dir, () => publishHolder(admission, {
          pid: process.pid, time: new Date().toISOString(), token: admissionToken,
        }), waiting);
        admitted = true;
      } catch (error) { if (!(error instanceof CheckoutBusyError)) throw error; }
      if (admitted) {
        try {
          waiting.throwIfAborted();
          const reapedFailed = retryFailedTickets(dir);
          for (const [file, text] of dead) {
            if (contents(file) === text) {
              try { unlinkSync(file); } catch (err) { if (err?.code !== "ENOENT") throw err; }
            }
          }
          const queue = tickets(dir);
          // Never let an un-unlinkable failed ticket of ours sit at the head and block admission.
          const liveQueue = queue.filter(name => !failedTickets.has(path.join(dir, "queue", name)));
          const occupied = slotFiles(dir);
          const index = Array.from({ length: slots }, (_, i) => i + 1).find(i => !occupied.includes(`slot-${i}.json`));
          if (waitMs() < 0) throw busy();
          if (index && occupied.length < slots && (!liveQueue.length || liveQueue[0] === ticket)) {
            const file = path.join(dir, `slot-${index}.json`);
            const owner = fileLease(file, token);
            try {
              publishHolder(file, { ...metadata, started_at: new Date().toISOString() });
              if (ticket && releaseTicket(dir, ticket, token, slots)) ticket = undefined;
              updateState(dir, slots);
              const releaseSlot = Object.assign(() => {
                const ok = owner();
                updateState(dir, slots);
                return ok;
              }, {
                forceRelease: () => {
                  const ok = owner.forceRelease();
                  updateState(dir, slots);
                  return ok;
                },
                retain: owner.retain,
              });
              Object.defineProperty(releaseSlot, "lastError", { get: () => owner.lastError, enumerable: true });
              return releaseSlot;
            } catch (error) { owner(); throw error; }
          }
          if (!ticket) {
            const stamp = Math.max(Date.now(), queue.length ? parseInt(queue[queue.length - 1]) + 1 : 0);
            const name = `${stamp}-${process.pid}-${token}.json`;
            // Record ticket before publication/cleanup so finally always reclaims it if anything throws.
            ticket = name;
            publishHolder(path.join(dir, "queue", name), metadata);
            liveQueue.push(name);
            updateState(dir, slots);
          } else if (dead.size || reapedFailed) updateState(dir, slots);
          onQueue?.({ position: liveQueue.indexOf(ticket) + 1, total: liveQueue.length });
        } finally { fileLease(admission, admissionToken)(); }
      }
      if (waitMs() <= 0) throw busy();
      await delay(1000, undefined, { signal: waiting });
    }
  } catch (err) {
    signal.throwIfAborted();
    if (deadline.aborted) throw busy();
    throw err;
  } finally {
    if (ticket) { releaseTicket(dir, ticket, token, slots); updateState(dir, slots); }
    onQueue?.();
  }
}
