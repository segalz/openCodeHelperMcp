// Ported from ClineMcp; preserve recovery/lock compatibility.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROCESS_QUERY_TIMEOUT_MS, boundedSignal } from "./waits.js";

export class CheckoutBusyError extends Error {
    checkoutRoot;
    constructor(checkoutRoot) {
        super(`Checkout already has a writer: ${checkoutRoot}`);
        this.checkoutRoot = checkoutRoot;
        this.kind = "checkout_busy";
        this.name = "CheckoutBusyError";
    }
}
const held = new Map();
const acquiring = new Set();
export function canonicalCheckoutPath(checkoutRoot) {
    const resolved = realpathSync(checkoutRoot);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function checkoutLockPath(checkoutRoot, lockDirectory = path.join(os.homedir(), ".cline-mcp", "locks")) {
    return path.join(lockDirectory, createHash("sha256").update(canonicalCheckoutPath(checkoutRoot)).digest("hex") + ".lock");
}
function pidIsGone(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
    }
    catch (error) {
        // ESRCH: PID does not exist. EPERM: PID belongs to another user or a protected/system process, not a bridge of ours.
        return error.code === "ESRCH" || error.code === "EPERM";
    }
    return false;
}
function execFileText(command, args, timeout = PROCESS_QUERY_TIMEOUT_MS, signal) {
    if (signal?.aborted || timeout <= 0)
        return Promise.resolve({ ok: false, stdout: "" });
    return new Promise(resolve => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const child = execFile(command, args, { encoding: "utf8", windowsHide: true, timeout, signal }, (error, stdout) => {
            finish({ ok: !error, stdout: stdout ?? "" });
        });
        const onAbort = () => {
            try { child.kill(); } catch { /* already gone */ }
            finish({ ok: false, stdout: "" });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
async function readProcessStartMs(pid, signal) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return undefined;
    try {
        if (process.platform === "win32") {
            // Call get_StartTime() directly so Win32 ERROR_ACCESS_DENIED (5) surfaces instead of PowerShell yielding $null.
            const command = `try { [System.Diagnostics.Process]::GetProcessById(${pid}).get_StartTime().ToUniversalTime().ToString('o') } ` +
                `catch { $e = $_.Exception; while ($e) { ` +
                `if (($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 5) -or $e -is [System.UnauthorizedAccessException]) { Write-Output 'ACCESS_DENIED'; exit 0 }; ` +
                `$e = $e.InnerException }; exit 1 }`;
            const out = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], PROCESS_QUERY_TIMEOUT_MS, signal);
            if (!out.ok)
                return undefined;
            const text = out.stdout.trim();
            if (text === "ACCESS_DENIED")
                return "denied";
            const ms = Date.parse(text);
            return Number.isFinite(ms) ? ms : undefined;
        }
        if (process.platform === "linux") {
            let stat;
            try {
                stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
            }
            catch (error) {
                if (error.code === "EACCES" || error.code === "EPERM")
                    return "denied";
                return undefined;
            }
            const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
            const boot = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", { encoding: "utf8", signal }))?.[1]);
            const getconf = await execFileText("getconf", ["CLK_TCK"], 10_000, signal);
            const hz = (getconf.ok ? Number(getconf.stdout.trim()) : NaN) || 100;
            return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks / hz) * 1000 : undefined;
        }
    }
    catch { /* unknown */ }
    return undefined;
}
/** Start time of a live process in ms, or undefined when it cannot be read (then nothing is reclaimed). */
export async function processStartMs(pid) {
    const result = await readProcessStartMs(pid);
    return typeof result === "number" ? result : undefined;
}
/** Slack between the OS start time and the holder's own clock reading. */
const START_TOLERANCE_MS = 5_000;
/** A holder is dead when its PID is gone or inaccessible (protected/other-user process), or when that PID now belongs
 * to a process started after the lock was written (PID reuse). An unreadable start time otherwise keeps the lock busy:
 * a live lock is never reclaimed by age. */
export async function holderIsDead(holder, startMs, signal) {
    const pid = Number(holder?.pid);
    if (pidIsGone(pid))
        return true;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
        return false;
    const written = typeof holder?.time === "string" ? Date.parse(holder.time) : NaN;
    if (!Number.isFinite(written))
        return false;
    if (!startMs || startMs === processStartMs) {
        const result = await readProcessStartMs(pid, signal);
        signal?.throwIfAborted();
        if (result === "denied")
            return true;
        return result !== undefined && result > written + START_TOLERANCE_MS;
    }
    try {
        const started = await startMs(pid);
        return started !== undefined && started > written + START_TOLERANCE_MS;
    }
    catch (error) {
        return error?.code === "EACCES" || error?.code === "EPERM";
    }
}
async function deadHolderText(text, signal) {
    try {
        return await holderIsDead(JSON.parse(text), undefined, signal);
    }
    catch {
        signal?.throwIfAborted();
        /* An incomplete or unreadable lock is busy, never stale by age alone. */
    }
    return false;
}
async function deadHolder(file, signal) {
    try {
        return await deadHolderText(readFileSync(file, "utf8"), signal);
    }
    catch {
        signal?.throwIfAborted();
        /* An incomplete or unreadable lock is busy, never stale by age alone. */
    }
    return false;
}
/** Removes the lock only if it still holds the exact metadata that was found dead. The death check awaits a process
 * launch, so the holder may release meanwhile and a new writer may create a fresh lock at the same path; that lock
 * must never be unlinked. The re-read and the unlink run with no await in between. */
async function unlinkIfStillDead(file, signal, knownDeadText) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return false; }
    if (text !== knownDeadText) {
        try { if (!await holderIsDead(JSON.parse(text), undefined, signal)) return false; } catch { signal?.throwIfAborted(); return false; }
        signal?.throwIfAborted();
        try { if (readFileSync(file, "utf8") !== text) return false; } catch { return false; }
    }
    unlinkSync(file);
    return true;
}
function createHolder(file, token) {
    const fd = openSync(file, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token }));
    }
    catch (error) {
        closeSync(fd); // Windows cannot unlink the failed write while this handle is still open.
        unlinkSync(file);
        throw error;
    }
    closeSync(fd);
}
/** Unique claims cannot be replaced while being inspected. Refuse if another live claimant exists.
 * Keeping our claim through the critical section prevents two stale-reaper recoverers from both entering. */
async function claimReclamation(file, token, root, signal) {
    const directory = file + ".reap-claims";
    mkdirSync(directory, { recursive: true });
    const own = `${process.pid}-${token}.json`;
    const claim = path.join(directory, own);
    createHolder(claim, token);
    try {
        for (const name of readdirSync(directory)) {
            signal?.throwIfAborted();
            if (name === own)
                continue;
            const pid = /^(\d+)-[a-f0-9-]+\.json$/i.exec(name)?.[1];
            if (!pid || !(pidIsGone(Number(pid)) || await deadHolder(path.join(directory, name), signal)))
                throw new CheckoutBusyError(root);
            // The pid is encoded before creation, so even a crash before writing metadata is recoverable.
            try {
                unlinkSync(path.join(directory, name));
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        return { file: claim, release: () => unlinkSync(claim) };
    }
    catch (error) {
        unlinkSync(claim);
        throw error;
    }
}
/** Exclusive across this process and bridge processes. Callers pass the Git checkout root.
 * Stale-lock reclamation shares one bounded deadline (`deadlineMs`, default `PROCESS_QUERY_TIMEOUT_MS`) and respects `signal`. */
export async function acquire(checkoutRoot, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    const root = canonicalCheckoutPath(checkoutRoot);
    if (held.has(root) || acquiring.has(root))
        throw new CheckoutBusyError(root);
    acquiring.add(root);
    try {
        const file = checkoutLockPath(root, options.lockDirectory);
        mkdirSync(path.dirname(file), { recursive: true });
        const token = randomUUID();
        const create = () => createHolder(file, token);
        try {
            create();
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const reclaimSignal = boundedSignal(options.deadlineMs ?? PROCESS_QUERY_TIMEOUT_MS, signal);
            try {
                let initialText;
                try { initialText = readFileSync(file, "utf8"); } catch { /* gone or unreadable */ }
                if (initialText === undefined || !await deadHolderText(initialText, reclaimSignal)) {
                    signal?.throwIfAborted();
                    throw new CheckoutBusyError(root);
                }
                // Serialize reclaimers: none may unlink a newly created live lock after another reclaimed it.
                const reaper = file + ".reap";
                const claim = await claimReclamation(file, token, root, reclaimSignal);
                let reaperOwned = false;
                try {
                    reclaimSignal.throwIfAborted();
                    if (existsSync(reaper)) {
                        if (!await deadHolder(reaper, reclaimSignal)) {
                            signal?.throwIfAborted();
                            throw new CheckoutBusyError(root);
                        }
                        unlinkSync(reaper);
                    }
                    // Publish complete, closed metadata atomically; a crash cannot leave an empty .reap file.
                    try {
                        linkSync(claim.file, reaper);
                        reaperOwned = true;
                    }
                    catch (err) {
                        if (err.code === "EEXIST")
                            throw new CheckoutBusyError(root);
                        throw err;
                    }
                    if (!await unlinkIfStillDead(file, reclaimSignal, initialText)) {
                        signal?.throwIfAborted();
                        throw new CheckoutBusyError(root);
                    }
                    try {
                        create();
                    }
                    catch (err) {
                        if (err.code === "EEXIST")
                            throw new CheckoutBusyError(root);
                        throw err;
                    }
                }
                finally {
                    try {
                        if (reaperOwned)
                            unlinkSync(reaper);
                    }
                    finally {
                        claim.release();
                    }
                }
            }
            catch (reclaimError) {
                if (signal?.aborted)
                    throw signal.reason;
                if (reclaimSignal.aborted)
                    throw new CheckoutBusyError(root);
                throw reclaimError;
            }
        }
        const release = Object.assign(() => {
            if (held.get(root) !== release)
                return;
            // Do not remove a lock replaced by an external actor.
            try {
                if (JSON.parse(readFileSync(file, "utf8")).token === token)
                    unlinkSync(file);
            }
            catch {
                // An externally removed/replaced lock must not turn task cleanup into an unhandled rejection.
            }
            finally {
                held.delete(root);
            }
        }, { checkoutRoot: root });
        held.set(root, release);
        return release;
    }
    finally {
        acquiring.delete(root);
    }
}
export function ownsCheckoutLock(release, checkoutRoot) {
    return !!release && held.get(canonicalCheckoutPath(checkoutRoot)) === release;
}
