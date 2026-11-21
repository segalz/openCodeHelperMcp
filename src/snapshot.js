// Ported from ClineMcp; preserve recovery/lock compatibility.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultKillTree } from "./process-utils.js";
import { KILL_SETTLE_MS, SNAPSHOT_GIT_TIMEOUT_MS } from "./waits.js";
export class SnapshotError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "SnapshotError";
    }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function hashFile(file, signal, maxBytes = SPECIAL_PLACEHOLDER_HASH_CAP) {
    const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
    if (signal?.aborted) throw abortError();
    const digest = createHash("sha256");
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    let bytes = 0;
    try {
        for await (const chunk of stream) {
            if (signal?.aborted) throw abortError();
            bytes += chunk.length;
            if (bytes > maxBytes) return null;
            digest.update(chunk);
        }
        if (signal?.aborted) throw abortError();
        return digest.digest("hex");
    } finally {
        signal?.removeEventListener("abort", abort);
        stream.destroy();
    }
}
const missing = (err) => err.code === "ENOENT";
/** All Git operations are read-only, bounded in time and aggregate output, and do not refresh the index. */
async function git(root, args, signal, input, allowedCodes = [0]) {
    if (signal?.aborted) {
        throw new SnapshotError("cancelled", "Snapshot Git call cancelled.");
    }
    return new Promise((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], {
            shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
        });
        const chunks = [];
        let bytes = 0;
        let failure;
        let killDeadline;
        const stop = (cancelled = false) => {
            if (failure)
                return;
            failure = cancelled
                ? new SnapshotError("cancelled", "Snapshot Git call cancelled.")
                : new SnapshotError("snapshot_git_failed", "Snapshot Git call exceeded its time/output bound.");
            if (child.pid)
                defaultKillTree(child.pid);
            // Killing trees may be denied by the host. Do not leave a Git call or inherited pipe unbounded.
            killDeadline = setTimeout(() => {
                child.kill("SIGKILL");
                child.stdout.destroy();
                child.stderr.destroy();
                cleanup();
                reject(failure);
            }, KILL_SETTLE_MS);
        };
        const timer = setTimeout(() => stop(false), SNAPSHOT_GIT_TIMEOUT_MS);
        const abort = () => stop(true);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            stop(true);
        child.stdin.on("error", () => { });
        child.stdin.end(input);
        const collect = (chunk, stdout) => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024)
                stop(false);
            else if (stdout)
                chunks.push(chunk);
        };
        child.stdout.on("data", (chunk) => collect(chunk, true));
        child.stderr.on("data", (chunk) => collect(chunk, false));
        const cleanup = () => { clearTimeout(timer); clearTimeout(killDeadline); signal?.removeEventListener("abort", abort); };
        child.on("error", () => {
            cleanup();
            reject(failure ?? (signal?.aborted
                ? new SnapshotError("cancelled", "Snapshot Git call cancelled.")
                : new SnapshotError("snapshot_git_failed", "Could not launch Git.")));
        });
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
/** Verify every ancestor of `file` is a real directory (no symlink, reparse point, or nested repo). */
async function safeAncestors(root, file) {
    const absolute = relativePath(root, file);
    const parts = file.split("/");
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
        current = path.join(current, parts[i]);
        const stat = await statOrMissing(current);
        if (!stat)
            return { absolute, missingAncestor: true };
        if (stat.isSymbolicLink())
            throw new SnapshotError("snapshot_unsupported", `Symlink/reparse point refused: ${file}`);
        const resolved = await realpath(current);
        if (path.resolve(resolved).toLowerCase() !== path.resolve(current).toLowerCase()) {
            throw new SnapshotError("snapshot_unsupported", `Reparse point refused: ${file}`);
        }
        if (stat.isDirectory() && await statOrMissing(path.join(current, ".git"))) {
            throw new SnapshotError("snapshot_unsupported", `Nested repository refused: ${file}`);
        }
        if (!stat.isDirectory())
            throw new SnapshotError("snapshot_unsupported", `Non-directory ancestor: ${file}`);
    }
    return { absolute, missingAncestor: false };
}
function isSpecialPath(file, specialEntries) {
    if (!specialEntries?.length)
        return false;
    const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
    for (const entry of specialEntries) {
        if (normalized === entry.path || normalized.startsWith(entry.path + "/"))
            return true;
    }
    return false;
}
const SPECIAL_PLACEHOLDER_LIMIT = 1024 * 1024;
const SPECIAL_PLACEHOLDER_HASH_CAP = 64 * 1024 * 1024;
async function specialEntryState(root, entry, signal, { baseline = false } = {}) {
    const { absolute, missingAncestor } = await safeAncestors(root, entry.path);
    if (missingAncestor)
        return "missing";
    const stat = await statOrMissing(absolute);
    if (!stat)
        return "missing";
    if (entry.kind === "symlink") {
        if (stat.isSymbolicLink()) {
            const target = await readlink(absolute);
            if (baseline) {
                const resolvedTarget = path.resolve(path.dirname(absolute), target);
                const rel = path.relative(root, resolvedTarget);
                if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
                    throw new SnapshotError("snapshot_unsupported", `Tracked symlink points outside the checkout: ${entry.path}`);
                }
            }
            return `link:${target}`;
        }
        if (stat.isFile()) {
            const resolved = await realpath(absolute);
            if (path.resolve(resolved).toLowerCase() !== path.resolve(absolute).toLowerCase())
                return "other";
            if (stat.size > SPECIAL_PLACEHOLDER_HASH_CAP)
                return `file-size:${stat.size}`;
            // Always the capped, streamed hash (same SHA-256 hex as before): a placeholder that grows after the stat can
            // never be read past the cap (final Codex check).
            const hashed = await hashFile(absolute, signal, SPECIAL_PLACEHOLDER_HASH_CAP);
            if (hashed === null) {
                const current = await statOrMissing(absolute);
                return current?.isFile() ? `file-size:${current.size}` : "other";
            }
            return `file:${hashed}`;
        }
        return "other";
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        return "other";
    const resolved = await realpath(absolute);
    if (path.resolve(resolved).toLowerCase() !== path.resolve(absolute).toLowerCase())
        return "other";
    if (await statOrMissing(path.join(absolute, ".git"))) {
        const [headBuf, status] = await Promise.all([
            git(absolute, ["rev-parse", "HEAD"], signal),
            git(absolute, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal)
        ]);
        if (baseline && status.length > 0)
            throw new SnapshotError("snapshot_unsupported", `Dirty submodule baseline refused: ${entry.path}`);
        return `repo:${headBuf.toString("utf8").trim()}:${hash(status)}`;
    }
    const names = (await readdir(absolute)).sort();
    if (baseline && names.length > 0)
        throw new SnapshotError("snapshot_unsupported", `Non-empty uninitialized submodule refused: ${entry.path}`);
    return `dir:${JSON.stringify(names)}`;
}
async function files(root, signal) {
    const [stageBuf, allBuf] = await Promise.all([
        git(root, ["ls-files", "--stage", "-z"], signal),
        git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal)
    ]);
    const stages = stageBuf.toString("utf8").split("\0");
    const specialMap = new Map();
    const regularPaths = new Set();
    const conflicts = new Set();
    for (const line of stages) {
        if (!line)
            continue;
        const tab = line.indexOf("\t");
        if (tab === -1)
            continue;
        const file = line.slice(tab + 1);
        if (!file)
            continue;
        const [mode, , stage] = line.slice(0, tab).split(" ");
        if (mode === "120000" || mode === "160000") {
            const kind = mode === "120000" ? "symlink" : "submodule";
            if (stage !== "0")
                conflicts.add(file);
            if (specialMap.has(file) && specialMap.get(file) !== kind)
                conflicts.add(file);
            specialMap.set(file, kind);
        }
        else {
            regularPaths.add(file);
        }
    }
    for (const file of specialMap.keys()) {
        if (regularPaths.has(file))
            conflicts.add(file);
    }
    const special = [...specialMap.entries()]
        .map(([file, kind]) => ({ path: file, kind }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const all = [...new Set(allBuf.toString("utf8").split("\0").filter(Boolean))].sort();
    const regular = special.length ? all.filter(file => !isSpecialPath(file, special)) : all;
    return { regular, special, conflicts: [...conflicts] };
}
/** Ignored paths, with ignored folders collapsed to one "dir/" entry (cheap even with node_modules). */
async function ignoredEntries(root, signal) {
    return [...new Set((await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], signal))
            .toString("utf8").split("\0").filter(Boolean))].sort();
}
async function excludeFile(root, signal) {
    const file = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"], signal)).toString("utf8").trim());
    try { return { path: file, content: (await readFile(file)).toString("base64") }; }
    catch (err) { if (missing(err)) return { path: file, content: null }; throw err; }
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
    const { regular: candidates, special, conflicts } = await files(root, opts.signal);
    if (conflicts.length) {
        throw new SnapshotError("snapshot_unsupported", `Conflicted tracked symlink/submodule refused: ${conflicts[0]}`);
    }
    if (special.length) {
        const specialLower = new Map();
        for (const entry of special) {
            const lower = entry.path.toLowerCase();
            if (specialLower.has(lower))
                throw new SnapshotError("snapshot_unsupported", `Case-colliding special path refused: ${entry.path}`);
            specialLower.set(lower, entry.path);
        }
        for (const file of candidates) {
            const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
            let prefix = "";
            for (const part of normalized.split("/")) {
                prefix = prefix ? `${prefix}/${part}` : part;
                const matched = specialLower.get(prefix.toLowerCase());
                if (matched !== undefined && prefix !== matched)
                    throw new SnapshotError("snapshot_unsupported", `Case-colliding path refused: ${file}`);
            }
        }
    }
    const specialEntries = [];
    for (const entry of special) {
        specialEntries.push({ ...entry, state: await specialEntryState(root, entry, opts.signal, { baseline: true }) });
    }
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
    const [ignored, exclude] = await Promise.all([ignoredEntries(root, opts.signal), excludeFile(root, opts.signal)]);
    const handle = { checkoutRoot: root, directory, manifest: entries.map((entry, i) => ({ path: entry.path, size: content[i].length, sha256: hash(content[i]) })),
        ...(specialEntries.length ? { specialEntries } : {}),
        ignoredEntries: ignored, excludeFile: exclude };
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
/** Restore one baseline file in place; true when it had to be rewritten. */
async function restoreEntry(root, handle, i) {
    const entry = handle.manifest[i];
    const bytes = await readFile(path.join(handle.directory, String(i)));
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
        throw new SnapshotError("snapshot_invalid", "Snapshot bytes failed integrity check.");
    const stat = await safeFile(root, entry.path);
    const absolute = relativePath(root, entry.path);
    if (stat?.isFile() && hash(await readFile(absolute)) === entry.sha256)
        return false;
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
    return true;
}
const isIgnoreFile = (file) => file === ".gitignore" || file.endsWith("/.gitignore");
export async function restoreSnapshot(handle) {
    const root = await checkout(handle.checkoutRoot);
    const report = { restored: [], removed: [], failed: [] };
    const baseline = new Set(handle.manifest.map(entry => entry.path));
    const special = handle.specialEntries ?? [];
    const prune = async (dir) => {
        while (dir !== root) {
            try { await rmdir(dir); }
            catch { break; } // Never recursively remove directories or ignored content.
            dir = path.dirname(dir);
        }
    };
    const remove = async (file) => {
        try {
            const stat = await safeFile(root, file);
            if (!stat) return;
            if (!stat.isFile())
                throw new SnapshotError("snapshot_unsupported", `Non-regular file refused: ${file}`);
            const absolute = relativePath(root, file);
            await rm(absolute);
            report.removed.push(file);
            await prune(path.dirname(absolute));
        }
        catch (err) { report.failed.push({ path: file, error: err.message }); }
    };
    // Ignore rules first: a rule the model added must not hide its new files from removal,
    // and must not make a baseline file look "newly ignored" and stay changed.
    const ignoreDone = new Set();
    for (let i = 0; i < handle.manifest.length; i++) {
        if (!isIgnoreFile(handle.manifest[i].path)) continue;
        if (isSpecialPath(handle.manifest[i].path, special)) continue;
        ignoreDone.add(i);
        try { if (await restoreEntry(root, handle, i)) report.restored.push(handle.manifest[i].path); }
        catch (err) { report.failed.push({ path: handle.manifest[i].path, error: err.message }); }
    }
    if (handle.ignoredEntries) {
        // Remove .gitignore files the model created: visible ones, and self-ignoring ones found through
        // ignored entries that did not exist at snapshot time. Repeat for nested ones, a bounded number of times.
        const known = new Set(handle.ignoredEntries);
        for (let round = 0; round < 5; round++) {
            const { regular } = await files(root);
            const candidates = new Set(regular.filter(file => isIgnoreFile(file) && !baseline.has(file) && !isSpecialPath(file, special)));
            for (const entry of await ignoredEntries(root)) {
                if (known.has(entry)) continue;
                const file = entry.endsWith("/") ? `${entry}.gitignore` : entry;
                if (isIgnoreFile(file) && !baseline.has(file) && !isSpecialPath(file, special) && await statOrMissing(relativePath(root, file)).catch(() => undefined)) candidates.add(file);
            }
            if (!candidates.size) break;
            const before = report.removed.length;
            for (const file of candidates) await remove(file);
            if (report.removed.length === before) break;
        }
    }
    if (handle.excludeFile) {
        const { path: file, content } = handle.excludeFile;
        try {
            const now = await readFile(file).then(b => b.toString("base64"), err => { if (missing(err)) return null; throw err; });
            if (now !== content) {
                if (content === null) await rm(file, { force: true });
                else await writeFile(file, Buffer.from(content, "base64"));
                report.restored.push("info/exclude");
            }
        }
        catch (err) { report.failed.push({ path: "info/exclude", error: err.message }); }
    }
    const { regular: current } = await files(root);
    // check-ignore respects tracked files. A newly ignored baseline path must not be overwritten.
    const ignored = new Set(handle.manifest.length ? (await git(root, ["check-ignore", "-z", "--stdin"], undefined, handle.manifest.map(entry => entry.path).join("\0") + "\0", [0, 1])).toString("utf8").split("\0") : []);
    for (const file of current.filter(file => !baseline.has(file) && !isSpecialPath(file, special))) await remove(file);
    for (let i = 0; i < handle.manifest.length; i++) {
        if (ignoreDone.has(i)) continue;
        const entry = handle.manifest[i];
        if (isSpecialPath(entry.path, special)) continue;
        try {
            if (ignored.has(entry.path))
                throw new SnapshotError("snapshot_unsupported", "Baseline path is now ignored; left untouched.");
            if (await restoreEntry(root, handle, i)) report.restored.push(entry.path);
        }
        catch (err) { report.failed.push({ path: entry.path, error: err.message }); }
    }
    for (const entry of special) {
        try {
            const now = await specialEntryState(root, entry);
            if (now !== entry.state) {
                report.failed.push({ path: entry.path, error: `Tracked ${entry.kind} changed during the run; it was left as is.` });
            }
        }
        catch (err) { report.failed.push({ path: entry.path, error: err.message }); }
    }
    return report;
}
/** Files that exist now but not in the baseline (ignored files excluded, so build caches do not show up). */
export async function createdFiles(handle) {
    const baseline = new Set(handle.manifest.map(entry => entry.path));
    const special = handle.specialEntries ?? [];
    const root = await checkout(handle.checkoutRoot);
    const created = [];
    const { regular } = await files(root);
    // A tracked file deleted before the run is listed by Git but absent: only files that exist now count.
    for (const file of regular.filter(file => !baseline.has(file) && !isSpecialPath(file, special))) {
        try { if (await statOrMissing(relativePath(root, file.endsWith("/") ? file.slice(0, -1) : file))) created.push(file); }
        catch { created.push(file); }
    }
    return created;
}
export async function discardSnapshot(handle) {
    await rm(handle.directory, { recursive: true, force: true });
}
export async function headAndIndexIdentity(checkoutRoot, signal) {
    const root = await checkout(checkoutRoot, signal);
    const head = (await git(root, ["rev-parse", "HEAD"], signal)).toString("utf8").trim();
    const index = (await git(root, ["rev-parse", "--git-path", "index"], signal)).toString("utf8").trim();
    try {
        await readFile(path.resolve(root, index));
    }
    catch (err) {
        if (missing(err))
            return { head, indexHash: null };
        throw err;
    }
    // Hash the staged entries, not the raw index bytes: `git status`, editors and Git tools rewrite the
    // index's stat cache without changing what is staged, which used to refuse restores as "index changed".
    return { head, indexHash: hash(await git(root, ["ls-files", "--stage", "-z"], signal)) };
}

export async function resolveCheckoutRoot(directory, signal) {
  return realpath((await git(directory, ["rev-parse", "--show-toplevel"], signal)).toString("utf8").trim());
}
export async function ignoredCheckoutPaths(root, signal) {
  return [...new Set((await git(root, ["ls-files", "-z", "--ignored", "--cached", "--others", "--exclude-standard", "--directory"], signal)).toString("utf8").split("\0").filter(Boolean))];
}
