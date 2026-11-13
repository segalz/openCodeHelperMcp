// Ported from ClineMcp; preserve recovery/lock compatibility.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
        return error.code === "ESRCH";
    }
    return false;
}
function deadHolder(file) {
    try {
        const holder = JSON.parse(readFileSync(file, "utf8"));
        return pidIsGone(holder.pid);
    }
    catch { /* An incomplete or unreadable lock is busy, never stale by age alone. */ }
    return false;
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
function claimReclamation(file, token, root) {
    const directory = file + ".reap-claims";
    mkdirSync(directory, { recursive: true });
    const own = `${process.pid}-${token}.json`;
    const claim = path.join(directory, own);
    createHolder(claim, token);
    try {
        for (const name of readdirSync(directory)) {
            if (name === own)
                continue;
            const pid = /^(\d+)-[a-f0-9-]+\.json$/i.exec(name)?.[1];
            if (!pid || !pidIsGone(Number(pid)))
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
/** Exclusive across this process and bridge processes. Callers pass the Git checkout root. */
export function acquire(checkoutRoot, options = {}) {
    const root = canonicalCheckoutPath(checkoutRoot);
    if (held.has(root))
        throw new CheckoutBusyError(root);
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
        if (!deadHolder(file))
            throw new CheckoutBusyError(root);
        // Serialize reclaimers: none may unlink a newly created live lock after another reclaimed it.
        const reaper = file + ".reap";
        const claim = claimReclamation(file, token, root);
        let reaperOwned = false;
        try {
            if (existsSync(reaper)) {
                if (!deadHolder(reaper))
                    throw new CheckoutBusyError(root);
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
            if (!deadHolder(file))
                throw new CheckoutBusyError(root);
            unlinkSync(file);
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
export function ownsCheckoutLock(release, checkoutRoot) {
    return !!release && held.get(canonicalCheckoutPath(checkoutRoot)) === release;
}
