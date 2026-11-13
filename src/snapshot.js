// Ported from ClineMcp; preserve recovery/lock compatibility.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultKillTree } from "./process-utils.js";
export class SnapshotError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "SnapshotError";
    }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const missing = (err) => err.code === "ENOENT";
/** All Git operations are read-only, bounded in time and aggregate output, and do not refresh the index. */
async function git(root, args, signal, input, allowedCodes = [0]) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], {
            shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
        });
        const chunks = [];
        let bytes = 0;
        let failure;
        let killDeadline;
        const stop = () => {
            if (failure)
                return;
            failure = new SnapshotError("snapshot_git_failed", "Snapshot Git call cancelled or exceeded its time/output bound.");
            if (child.pid)
                defaultKillTree(child.pid);
            // Killing trees may be denied by the host. Do not leave a Git call or inherited pipe unbounded.
            killDeadline = setTimeout(() => {
                child.kill("SIGKILL");
                child.stdout.destroy();
                child.stderr.destroy();
                cleanup();
                reject(failure);
            }, 5000);
        };
        const timer = setTimeout(stop, 10_000);
        const abort = () => stop();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            stop();
        child.stdin.on("error", () => { });
        child.stdin.end(input);
        const collect = (chunk, stdout) => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024)
                stop();
            else if (stdout)
                chunks.push(chunk);
        };
        child.stdout.on("data", (chunk) => collect(chunk, true));
        child.stderr.on("data", (chunk) => collect(chunk, false));
        const cleanup = () => { clearTimeout(timer); clearTimeout(killDeadline); signal?.removeEventListener("abort", abort); };
        child.on("error", () => { cleanup(); reject(new SnapshotError("snapshot_git_failed", "Could not launch Git.")); });
        child.on("close", code => {
            cleanup();
            if (failure)
                reject(failure);
            else if (code === null || !allowedCodes.includes(code))
                reject(new SnapshotError("snapshot_git_failed", `Git ${args[0]} failed.`));
            else
                resolve(Buffer.concat(chunks));
        });
    });
}
function relativePath(root, file) {
    const parts = file.split("/");
    if (!file || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") ||
        file.includes("\\") || file.includes("\0") || path.isAbsolute(file) ||
        (process.platform === "win32" && parts.some(p => /[:]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) {
        throw new SnapshotError("snapshot_unsupported", `Unsafe snapshot path: ${file}`);
    }
    return path.join(root, ...parts);
}
async function statOrMissing(file) {
    try {
        return await lstat(file);
    }
    catch (err) {
        if (missing(err))
            return undefined;
        throw err;
    }
}
/** Never follow a checkout link (including Windows junctions) or enter a nested repository. */
async function safeFile(root, file) {
    const absolute = relativePath(root, file);
    let current = root;
    for (const part of file.split("/")) {
        current = path.join(current, part);
        const stat = await statOrMissing(current);
        if (!stat)
            return undefined;
        if (stat.isSymbolicLink())
            throw new SnapshotError("snapshot_unsupported", `Symlink/reparse point refused: ${file}`);
        const resolved = await realpath(current);
        if (path.resolve(resolved).toLowerCase() !== path.resolve(current).toLowerCase()) {
            throw new SnapshotError("snapshot_unsupported", `Reparse point refused: ${file}`);
        }
        if (stat.isDirectory() && await statOrMissing(path.join(current, ".git"))) {
            throw new SnapshotError("snapshot_unsupported", `Nested repository refused: ${file}`);
        }
        if (current === absolute)
            return stat;
        if (!stat.isDirectory())
            throw new SnapshotError("snapshot_unsupported", `Non-directory ancestor: ${file}`);
    }
}
async function files(root, signal) {
    const stages = (await git(root, ["ls-files", "--stage", "-z"], signal)).toString("utf8").split("\0");
    if (stages.some(line => line.startsWith("160000 ") || line.startsWith("120000 "))) {
        throw new SnapshotError("snapshot_unsupported", "Submodules and tracked symlinks are refused.");
    }
    return [...new Set((await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal))
            .toString("utf8").split("\0").filter(Boolean))].sort();
}
async function checkout(root, signal) {
    const stat = await lstat(path.resolve(root));
    if (stat.isSymbolicLink())
        throw new SnapshotError("snapshot_unsupported", "Checkout root is a symlink/reparse point.");
    const resolved = await realpath(root);
    const top = (await git(resolved, ["rev-parse", "--show-toplevel"], signal)).toString("utf8").trim();
    const normalize = (value) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
    if (normalize(await realpath(top)) !== normalize(resolved))
        throw new SnapshotError("snapshot_invalid", "Expected the checkout root.");
    return resolved;
}
function limit(value, maximum) {
    if (value === undefined)
        return maximum;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
        throw new SnapshotError("snapshot_invalid", "Invalid snapshot limit.");
    return value;
}
export async function takeSnapshot(checkoutRoot, opts = {}) {
    const root = await checkout(checkoutRoot, opts.signal);
    const maxFiles = limit(opts.maxFiles, 20_000);
    const maxFile = limit(opts.maxFileBytes, 64 * 1024 * 1024);
    const maxTotal = limit(opts.maxTotalBytes, 512 * 1024 * 1024);
    const base = path.resolve(opts.snapshotBase ?? path.join(os.tmpdir(), "cline-mcp-snapshots"));
    // Resolve the closest existing ancestor too: a symlinked base must not lead back into the checkout.
    let ancestor = base;
    while (!await statOrMissing(ancestor))
        ancestor = path.dirname(ancestor);
    const resolvedBase = path.resolve(await realpath(ancestor), path.relative(ancestor, base));
    const relative = path.relative(root, resolvedBase);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new SnapshotError("snapshot_invalid", "Snapshot storage must be outside the checkout.");
    }
    const candidates = await files(root, opts.signal);
    const entries = [];
    let total = 0;
    for (const file of candidates) {
        // Git reports an untracked nested repository with a trailing slash.
        const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
        const stat = await safeFile(root, normalized);
        if (!stat)
            continue; // A tracked deletion is an absent baseline file.
        if (!stat.isFile())
            throw new SnapshotError("snapshot_unsupported", `Non-regular file refused: ${file}`);
        total += stat.size;
        entries.push({ path: file, size: stat.size });
        if (entries.length > maxFiles || stat.size > maxFile || total > maxTotal) {
            throw new SnapshotError("snapshot_limit", "Snapshot file count or byte limit exceeded.");
        }
    }
    // Read all bytes before writing anything: even growth between stat and read cannot leave a partial snapshot on refusal.
    const content = [];
    total = 0;
    for (const entry of entries) {
        await safeFile(root, entry.path);
        const bytes = await readFile(relativePath(root, entry.path), { signal: opts.signal });
        total += bytes.length;
        if (bytes.length > maxFile || total > maxTotal)
            throw new SnapshotError("snapshot_limit", "Snapshot byte limit exceeded during read.");
        content.push(bytes);
    }
    const directory = path.join(resolvedBase, randomUUID());
    const handle = { checkoutRoot: root, directory, manifest: entries.map((entry, i) => ({ path: entry.path, size: content[i].length, sha256: hash(content[i]) })) };
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (let i = 0; i < content.length; i++)
            await writeFile(path.join(directory, String(i)), content[i], { flag: "wx", mode: 0o600 });
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify(handle), { flag: "wx", mode: 0o600 });
        return handle;
    }
    catch (err) {
        await rm(directory, { recursive: true, force: true });
        throw err;
    }
}
export async function restoreSnapshot(handle) {
    const root = await checkout(handle.checkoutRoot);
    const report = { restored: [], removed: [], failed: [] };
    const current = await files(root);
    const baseline = new Set(handle.manifest.map(entry => entry.path));
    // check-ignore respects tracked files. A newly ignored baseline path must not be overwritten.
    const ignored = new Set(handle.manifest.length ? (await git(root, ["check-ignore", "-z", "--stdin"], undefined, handle.manifest.map(entry => entry.path).join("\0") + "\0", [0, 1])).toString("utf8").split("\0") : []);
    const prune = async (dir) => {
        while (dir !== root) {
            try {
                await rmdir(dir);
            }
            catch {
                break;
            } // Never recursively remove directories or ignored content.
            dir = path.dirname(dir);
        }
    };
    for (const file of current.filter(file => !baseline.has(file))) {
        try {
            const stat = await safeFile(root, file);
            if (!stat)
                continue;
            if (!stat.isFile())
                throw new SnapshotError("snapshot_unsupported", `Non-regular file refused: ${file}`);
            const absolute = relativePath(root, file);
            await rm(absolute);
            report.removed.push(file);
            await prune(path.dirname(absolute));
        }
        catch (err) {
            report.failed.push({ path: file, error: err.message });
        }
    }
    for (let i = 0; i < handle.manifest.length; i++) {
        const entry = handle.manifest[i];
        try {
            if (ignored.has(entry.path))
                throw new SnapshotError("snapshot_unsupported", "Baseline path is now ignored; left untouched.");
            const bytes = await readFile(path.join(handle.directory, String(i)));
            if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
                throw new SnapshotError("snapshot_invalid", "Snapshot bytes failed integrity check.");
            const stat = await safeFile(root, entry.path);
            const absolute = relativePath(root, entry.path);
            if (stat?.isFile() && hash(await readFile(absolute)) === entry.sha256)
                continue;
            if (stat?.isDirectory())
                await rmdir(absolute); // Only an empty replacement directory is safe to remove.
            else if (stat && !stat.isFile())
                throw new SnapshotError("snapshot_unsupported", "Baseline path is no longer a regular file.");
            await mkdir(path.dirname(absolute), { recursive: true });
            // Replace instead of writing through a hard link to another (possibly ignored) path.
            const temporary = path.join(path.dirname(absolute), `.cline-restore-${randomUUID()}`);
            try {
                await writeFile(temporary, bytes, { flag: "wx" });
                await rename(temporary, absolute);
            }
            finally {
                await rm(temporary, { force: true });
            }
            report.restored.push(entry.path);
        }
        catch (err) {
            report.failed.push({ path: entry.path, error: err.message });
        }
    }
    return report;
}
export async function discardSnapshot(handle) {
    await rm(handle.directory, { recursive: true, force: true });
}
export async function headAndIndexIdentity(checkoutRoot, signal) {
    const root = await checkout(checkoutRoot, signal);
    const head = (await git(root, ["rev-parse", "HEAD"], signal)).toString("utf8").trim();
    const index = (await git(root, ["rev-parse", "--git-path", "index"], signal)).toString("utf8").trim();
    try {
        return { head, indexHash: hash(await readFile(path.resolve(root, index))) };
    }
    catch (err) {
        if (missing(err))
            return { head, indexHash: null };
        throw err;
    }
}

export async function resolveCheckoutRoot(directory, signal) {
  return realpath((await git(directory, ["rev-parse", "--show-toplevel"], signal)).toString("utf8").trim());
}
export async function ignoredCheckoutPaths(root, signal) {
  return [...new Set((await git(root, ["ls-files", "-z", "--ignored", "--cached", "--others", "--exclude-standard", "--directory"], signal)).toString("utf8").split("\0").filter(Boolean))];
}
