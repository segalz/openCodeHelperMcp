import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { defaultKillTree, WINDOWS_COMMAND_LINE_LIMIT } from "./process-utils.js";
import { excludedPath } from "./permissions.js";
import { tryCodeindexMap } from "./codeindex.js";
export const CODE_MAP_HEADER = "## Code map (bridge-generated, line numbers in current checkout contents)";
const MAX_FILES = 3_000;
const MAX_BYTES = 512 * 1024;
const TIME_BUDGET_MS = 1_500;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "vendor", ".git"]);
const BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|rar|exe|dll|so|dylib|woff2?|ttf|eot|mp[34]|wav|ogg|wasm|class|pyc|db|sqlite)$/i;
function trackedFiles(root, signal, optionsSpawn) {
    return new Promise((resolve, reject) => {
        if (signal.aborted)
            return reject(new Error("Code map cancelled"));
        const child = (optionsSpawn ?? spawn)(process.platform === "win32" ? "git.exe" : "git", ["-C", root, "ls-files", "-z"], {
            shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
        });
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener("abort", stop);
            if (error)
                reject(error);
            else
                resolve(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
        };
        const stop = () => {
            if (settled)
                return;
            try {
                if (process.platform === "win32" && child.pid)
                    defaultKillTree(child.pid, "SIGKILL", "win32");
                else
                    child.kill();
            }
            catch { /* already exited */ }
            finish(new Error("Code map Git deadline or output limit exceeded"));
        };
        signal.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024)
                stop();
            else if (!settled)
                chunks.push(Buffer.from(chunk));
        });
        child.stderr.resume();
        child.on("error", () => finish(new Error("Code map Git launch failed")));
        child.on("close", code => finish(code === 0 ? undefined : new Error("Code map Git failed")));
    });
}
function included(file) {
    const parts = file.split("/");
    const base = parts.at(-1);
    return !excludedPath(file) && !parts.some(part => SKIP_DIRS.has(part.toLowerCase())) &&
        !/(?:\.min\.|\.lock$|^package-lock\.json$|^npm-shrinkwrap\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|^bun\.lockb?$)/i.test(base) &&
        !BINARY_EXTENSION.test(base) && !/[\r\n\x00-\x1f]/.test(file);
}
function symbolPattern(file) {
    switch (path.extname(file).toLowerCase()) {
        case ".ts":
        case ".tsx":
        case ".js":
        case ".jsx":
        case ".mjs":
        case ".cjs":
        case ".mts":
        case ".cts":
            return /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:class|interface|type|enum|const)\s+)([\w$]+)|^export\s+default\s+([\w$]+)/;
        case ".py":
        case ".pyi": return /^(?:async\s+)?(?:def|class)\s+(\w+)/;
        case ".go": return /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)(\w+)/;
        case ".rs": return /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?(?:fn|struct|enum|trait|impl|mod)\s+(?:<[^>]*>\s*)?([\w:]+)/;
        case ".java":
        case ".cs":
        case ".kt":
        case ".kts":
            return /^(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|static|partial|expect|actual|annotation|value)\s+)*(?:class|interface|enum(?:\s+class)?|record(?:\s+(?:class|struct))?)\s+(\w+)/;
        case ".php": return /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|function)\s+&?([\w]+)/;
        case ".rb": return /^(?:class|module|def)\s+([\w:.!?=]+)/;
        default: return undefined;
    }
}
function formatMap(entries, omitted, fits) {
    const render = (count, symbols) => {
        const missing = omitted + entries.length - count;
        return [CODE_MAP_HEADER, ...entries.slice(0, count).map((entry, i) => entry.base + (i < symbols ? entry.symbols : "")),
            ...(missing ? [`... and ${missing} more files`] : [])].join("\n");
    };
    // Keep all paths first; sacrifice symbols from the lowest-priority files before dropping paths.
    if (!entries.length && !omitted)
        return undefined;
    const full = render(entries.length, entries.length);
    if (fits(full))
        return full;
    const pathsFit = fits(render(entries.length, 0));
    // Binary search keeps rendering bounded even when thousands of symbols must be dropped.
    let low = 0;
    let high = entries.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(pathsFit ? render(entries.length, mid) : render(mid, 0)))
            low = mid;
        else
            high = mid - 1;
    }
    const result = pathsFit ? render(entries.length, low) : render(low, 0);
    return fits(result) ? result : undefined;
}
/** Best-effort, bounded map of tracked files. A scan-budget stop keeps completed entries; I/O failure omits the map. */
async function buildRegexMap(root, options = {}) {
    const controller = new AbortController();
    let timer;
    const abort = () => controller.abort();
    try {
        if (options.signal?.aborted)
            return undefined;
        const maxChars = Math.min(6000, options.maxChars ?? 6000);
        if (!Number.isFinite(maxChars) || maxChars <= 0)
            return undefined;
        const commandLimit = WINDOWS_COMMAND_LINE_LIMIT - 1_000;
        if (options.commandLineLength && commandLimit - options.commandLineLength("") < 800)
            return undefined;
        const fits = (text) => text.length <= maxChars &&
            (!options.commandLineLength || options.commandLineLength(text + "\n\n") <= commandLimit);
        const timeBudget = Math.max(1, Math.min(TIME_BUDGET_MS, options.timeBudgetMs ?? TIME_BUDGET_MS));
        const deadline = performance.now() + timeBudget;
        timer = setTimeout(abort, timeBudget);
        options.signal?.addEventListener("abort", abort, { once: true });
        // Bound every I/O operation, including metadata calls which do not accept an AbortSignal.
        const bounded = (operation) => new Promise((resolve, reject) => {
            const onAbort = () => reject(new Error("Code map timed out"));
            if (controller.signal.aborted)
                onAbort();
            else
                controller.signal.addEventListener("abort", onAbort, { once: true });
            operation.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
        });
        const rootPath = await bounded(realpath(root));
        const prompt = (options.prompt ?? "").replaceAll("\\", "/");
        const files = [...new Set(await trackedFiles(rootPath, controller.signal, options.spawnImpl))].filter(included);
        files.sort((a, b) => Number(prompt.includes(b)) - Number(prompt.includes(a)) || (a < b ? -1 : a > b ? 1 : 0));
        const entries = [];
        let scanned = 0;
        for (; scanned < files.length; scanned++) {
            if (scanned >= MAX_FILES || performance.now() >= deadline)
                break;
            const file = files[scanned];
            try {
                const absolute = path.resolve(rootPath, file);
                const relative = path.relative(rootPath, absolute);
                if (relative.startsWith("..") || path.isAbsolute(relative))
                    continue;
                const stat = await bounded(lstat(absolute));
                if (!stat.isFile() || stat.size > MAX_BYTES)
                    continue;
                const resolved = await bounded(realpath(absolute));
                const resolvedRelative = path.relative(rootPath, resolved);
                if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative))
                    continue;
                if (excludedPath(resolvedRelative))
                    continue;
                const bytes = await bounded(readFile(resolved, { signal: controller.signal }));
                if (bytes.length > MAX_BYTES || bytes.includes(0))
                    continue;
                let text;
                try {
                    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                }
                catch {
                    continue;
                } // Binary/non-UTF-8 content.
                if (/[\x01-\x08\x0e-\x1f]/.test(text))
                    continue;
                const lines = text.length ? text.split(/\r?\n/) : [];
                if (text.endsWith("\n"))
                    lines.pop();
                const pattern = symbolPattern(file);
                const symbols = [];
                if (pattern)
                    lines.forEach((line, index) => {
                        const match = pattern.exec(line);
                        if (match)
                            symbols.push(`${match[1] ?? match[2]}:${index + 1}`);
                    });
                entries.push({ base: `${file} (${lines.length} lines):`, symbols: symbols.length ? " " + symbols.join(", ") : "" });
            }
            catch (error) {
                // The overall scan budget is a normal partial-result boundary. Other I/O errors omit the map.
                if (controller.signal.aborted && !options.signal?.aborted && entries.length > 0)
                    break;
                throw error;
            }
        }
        if (options.signal?.aborted)
            return undefined;
        return formatMap(entries, files.length - scanned, fits);
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
    }
}

/** String API retained; onSource reports the context actually selected for launch. */
export async function buildCodeMap(root, options = {}) {
    const started = performance.now();
    const cli = (options.env ?? process.env).CODEINDEX_CLI;
    let map;
    if (cli) {
        options.signal?.throwIfAborted();
        const commandLimit = WINDOWS_COMMAND_LINE_LIMIT - 1_000;
        const headroom = options.commandLineLength ? commandLimit - options.commandLineLength("") : Infinity;
        // A UTF-16 unit may require two units after Windows argument escaping.
        const budget = Math.floor(Math.min(6000, options.maxChars ?? 6000, (headroom - 4) / 2));
        if (headroom < 800 || !Number.isFinite(budget) || budget <= 0) {
            options.onSource?.("none");
            return undefined;
        }
        map = await tryCodeindexMap(root, { cli, prompt: options.prompt, budget,
            timeBudgetMs: (options.timeBudgetMs ?? Infinity) - (performance.now() - started), signal: options.signal, env: options.env,
            spawnImpl: options.spawnImpl, killTreeImpl: options.killTreeImpl });
        options.signal?.throwIfAborted();
        if (typeof map === "string" && map.length <= budget && (!options.commandLineLength || options.commandLineLength(map + "\n\n") <= commandLimit)) {
            options.onSource?.(map ? "codeindex" : "none");
            return map || undefined;
        }
    }
    const remaining = (options.timeBudgetMs ?? Infinity) - (performance.now() - started);
    map = remaining > 0 ? await buildRegexMap(root, { ...options, timeBudgetMs: Math.min(TIME_BUDGET_MS, remaining) }) : undefined;
    if (cli) options.signal?.throwIfAborted();
    options.onSource?.(map ? "regex" : "none");
    return map;
}
