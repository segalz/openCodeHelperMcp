// Ported from ClineMcp; preserve recovery/lock compatibility.
import { spawn } from "node:child_process";
import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultKillTree } from "./process-utils.js";
import { confirmTreeDead } from "./proctree.js";
import { createWindowsJob } from "./jobobject.js";
import { ChildProcess } from "node:child_process";
import { redactSecrets } from "./safety.js";
export class VerificationError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "VerificationError";
    }
}
const OUTPUT_LIMIT = 1024 * 1024;
const TAIL_LIMIT = 8 * 1024;
const EXIT_GRACE_MS = 500;
export async function resolveVerificationCommand(command, args = [], cwd = process.cwd()) {
    if (!command || command.includes("\0") || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
        throw new VerificationError("verification_refused", "Verification requires a command and literal string arguments.");
    }
  if (/[\\/]$/.test(command)) {
    throw new VerificationError("verification_refused", "Verification command must be a file, not a directory.");
  }
  const hasDirectory = command.includes("/") || command.includes("\\");
  const ext = path.extname(command);
  const bare = !hasDirectory && !ext;
  if (process.platform !== "win32") {
    // POSIX spawns resolve through PATH; check that the program is a runnable file so a missing/directory/non-executable one is refused up front.
    const found = hasDirectory ? await isRunnablePosix(path.resolve(cwd, command))
      : (await Promise.all(pathDirectories().map(dir => isRunnablePosix(path.join(dir, command))))).some(Boolean);
    if (!found) throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
    return { command, args };
  }
  const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(path.basename(command));
  if (npm) {
    const script = npm[1].toLowerCase() + "-cli.js";
    const candidates = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : [])];
    for (const candidate of candidates) {
      if (await isFile(candidate)) return { command: process.execPath, args: [candidate, ...args] };
    }
    throw new VerificationError("verification_refused", "Could not resolve the npm installation's CLI script.");
  }
  if (/\.(cmd|bat)$/i.test(command)) throw new VerificationError("verification_refused", "Windows batch commands require a shell and are refused.");
  if (ext && !/^\.(?:exe|com)$/i.test(ext)) {
    throw new VerificationError("verification_refused", "Verification executable is not a runnable Windows program.");
  }
  // A project-local tool (vitest, tsc, eslint...) wins, as with `npm run`: the nearest node_modules/.bin upward.
  if (bare) {
    const local = await nearestBinShim(command, cwd);
    if (local) return resolveCmdShim(local, args, 0);
  }
  // Resolve names ourselves so PATHEXT cannot silently run a batch file. As on Windows, the first PATH folder
  // that has the name wins; a global npm/corepack .cmd shim (pnpm, yarn) or explicit node_modules/.bin/<tool>
  // path is parsed, never run by cmd.exe.
  for (const directory of hasDirectory ? [""] : pathDirectories()) {
    for (const extension of ext ? [""] : [".exe", ".com"]) {
      const candidate = path.resolve(cwd, directory, command + extension);
      if (await isFile(candidate)) return { command: candidate, args };
    }
    const resolved = path.resolve(cwd, directory, command);
    const allowShim = bare || (!ext && isNodeModulesBin(resolved));
    const shim = allowShim ? resolved + ".cmd" : undefined;
    if (shim && await isFile(shim)) return resolveCmdShim(shim, args, 0);
  }
  throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
}

const exists = (file) => access(file).then(() => true, () => false);
const isFile = (file) => stat(file).then(info => info.isFile(), () => false);
const isRunnablePosix = (file) => isFile(file).then(ok => ok && access(file, constants.X_OK).then(() => true, () => false));
const isNodeModulesBin = (file) => {
  const binDir = path.dirname(file);
  return path.basename(binDir).toLowerCase() === ".bin"
    && path.basename(path.dirname(binDir)).toLowerCase() === "node_modules";
};
const pathDirectories = () => (process.env.PATH ?? "").split(path.delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(Boolean);

async function findOnPath(fileName, first) {
  for (const directory of [...(first ? [first] : []), ...pathDirectories()]) {
    const candidate = path.resolve(directory, fileName);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** The nearest `node_modules/.bin/<name>.cmd` from `cwd` upward, stopping at the repository root (`.git`). */
async function nearestBinShim(name, cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", name + ".cmd");
    if (await isFile(candidate)) return candidate;
    if (path.dirname(dir) === dir || await exists(path.join(dir, ".git"))) return undefined;
  }
}

// The launch line of an npm cmd-shim, in its current and older forms:
//   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..\vitest\vitest.mjs" %*
//   "%~dp0\node.exe"  "%~dp0\..\x\cli.js" %*      node  "%~dp0\..\x\cli.js" %*      "%dp0%\..\esbuild\esbuild.exe" %*
const SHIM_PREFIX = String.raw`^(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?@?`;
const SHIM_TARGET = String.raw`"%~?dp0%?[\\/]?([^"]+)"\s+%\*$`;
const SHIM_NODE = [
  new RegExp(SHIM_PREFIX + String.raw`"%_prog%"\s+` + SHIM_TARGET, "i"),
  new RegExp(SHIM_PREFIX + String.raw`"%~?dp0%?[\\/]?(?:[^"]*[\\/])?node(?:\.exe)?"\s+` + SHIM_TARGET, "i"),
  new RegExp(SHIM_PREFIX + String.raw`node(?:\.exe)?\s+` + SHIM_TARGET, "i")
];
const SHIM_EXE = new RegExp(SHIM_PREFIX + String.raw`"%~?dp0%?[\\/]?([^"]+\.exe)"\s+%\*$`, "i");

/**
 * Turn an npm cmd-shim (or a corepack `@corepack <tool> %*` shim) into a direct, shell-free launch: node plus
 * the JS entry, or the wrapped .exe. Anything else is a real batch file and stays refused.
 * Keep in step with ClineMcp `src/verify.ts`.
 */
async function resolveCmdShim(file, args, depth) {
  const refuse = (why) => new VerificationError("verification_refused",
    `${file} is a batch file that cannot run without a shell (${why}); give the program directly.`);
  let text;
  try { text = await readFile(file, "utf8"); } catch { throw refuse("unreadable"); }
  const corepack = /^@?corepack\s+([A-Za-z0-9._-]+)\s+%\*$/i.exec(text.trim());
  if (corepack) {
    if (depth > 0) throw refuse("nested shim");
    const inner = await findOnPath("corepack.cmd", path.dirname(file));
    if (!inner) throw refuse("corepack not found");
    return resolveCmdShim(inner, [corepack[1], ...args], depth + 1);
  }
  const line = text.split(/\r?\n/).map(l => l.trim()).filter(l => /%\*$/.test(l)).pop() ?? "";
  const viaNode = SHIM_NODE.map(pattern => pattern.exec(line)).find(Boolean);
  const exe = viaNode ? undefined : SHIM_EXE.exec(line);
  const relative = viaNode?.[1] ?? exe?.[1];
  if (!relative) throw refuse("not an npm shim");
  const target = path.resolve(path.dirname(file), relative);
  if (!await isFile(target)) throw refuse(`its target ${target} does not exist`);
  return viaNode ? { command: process.execPath, args: [target, ...args] } : { command: target, args };
}

function createWindow() {
    return { chunks: [], head: 0, bytes: 0 };
}
function pushRolling(window, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf.length)
        return;
    if (buf.length >= OUTPUT_LIMIT) {
        window.chunks = [Buffer.from(buf.subarray(buf.length - OUTPUT_LIMIT))];
        window.head = 0;
        window.bytes = OUTPUT_LIMIT;
        return;
    }
    window.chunks.push(buf);
    window.bytes += buf.length;
    while (window.bytes > OUTPUT_LIMIT && window.head < window.chunks.length) {
        const overflow = window.bytes - OUTPUT_LIMIT;
        const first = window.chunks[window.head];
        if (first.length <= overflow) {
            window.chunks[window.head] = undefined;
            window.head++;
            window.bytes -= first.length;
        }
        else {
            window.chunks[window.head] = first.subarray(overflow);
            window.bytes -= overflow;
        }
    }
    if (window.head > 0 && window.head * 2 >= window.chunks.length) {
        window.chunks = window.chunks.slice(window.head);
        window.head = 0;
    }
}
function tail(chunks) {
    const redacted = Buffer.from(redactSecrets(Buffer.concat(chunks).toString("utf8")), "utf8");
    let start = Math.max(0, redacted.length - TAIL_LIMIT);
    // Do not start inside a UTF-8 code point (replacement characters could exceed the byte budget).
    while (start < redacted.length && (redacted[start] & 0xc0) === 0x80)
        start++;
    return redacted.subarray(start).toString("utf8");
}
export async function runVerification(spec, cwd, signal, {
    spawnImpl = spawn,
    resolveImpl = resolveVerificationCommand,
    killImpl = defaultKillTree,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    createWindowsJobImpl,
    confirmTreeDeadImpl,
    createWindowsJob: createWindowsJobOption = createWindowsJobImpl ?? createWindowsJob,
    confirmTreeDead: confirmTreeDeadOption = confirmTreeDeadImpl ?? confirmTreeDead,
} = {}) {
    const timeout = spec.timeoutSeconds ?? 60;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)
        throw new VerificationError("verification_refused", "Verification timeout must be 1-300 seconds.");
    const started = performance.now();
    const executable = await resolveImpl(spec.command, spec.args, cwd);
    const prepareStarted = performance.now();
    const useJob = (process.platform === "win32" && spawnImpl === spawn) || createWindowsJobOption !== createWindowsJob;
    const job = useJob ? await createWindowsJobOption(timeout * 1000, signal) : undefined;
    const remainingMs = Math.max(0, timeout * 1000 - (useJob ? performance.now() - prepareStarted : 0));
    if (signal?.aborted) {
        await job?.close();
        return { passed: false, exitCode: null, signal: "SIGKILL", timedOut: false,
            killedForOutput: false, durationMs: performance.now() - started, stdoutTail: "", stderrTail: "" };
    }
    return new Promise((resolve, reject) => {
        let child;
        const rootStartedMs = Date.now();
        try { child = spawnImpl(executable.command, executable.args, {
            cwd: path.resolve(cwd), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
        }); } catch { reject(new VerificationError("verification_launch_failed", "Could not launch verification executable.")); return; }
        job?.assign(child);
        const pid = child.pid;
        const stdout = createWindow(), stderr = createWindow();
        let timedOut = false, cancelled = false, done = false, stopped = false, jobAssigned = false;
        // Set when the root exited but something kept its pipes open: a likely survivor, so an unreadable process
        // table must fail the check (S3b). Pipes that closed normally are not such evidence (plan S18 review).
        let pipesHeldOpen = false;
        let killDeadline, exitGrace, confirm, exitedAt;
        // A real verify process tree must be confirmed dead before the result returns: a restore follows.
        const realChild = child instanceof ChildProcess && Number.isInteger(pid) && pid > 0;
        const rootAlive = () => exitedAt === undefined && child.exitCode === null && child.signalCode === null;
        const confirmKill = () => confirmTreeDeadOption(pid, {
            killRoot: () => killImpl(pid), isRootAlive: rootAlive, rootStartedMs, rootExitedMs: () => exitedAt
        }).catch(() => ({ confirmed: false, alive: [pid], unverified: true }));
        const destroyPipes = () => { child.stdout.destroy(); child.stderr.destroy(); };
        const stop = () => {
            if (done || stopped) return;
            stopped = true;
            clearTimeoutImpl(timer);
            clearTimeoutImpl(exitGrace);
            if (realChild) confirm ??= confirmKill();
            // Settle even if an inherited pipe or OS kill failure prevents a close event.
            killDeadline = setTimeoutImpl(() => {
                if (!realChild || rootAlive()) { try { child.kill("SIGKILL"); } catch { /* bounded grace fallback */ } }
                finish(null, "SIGKILL");
                destroyPipes();
            }, 5000);
            // After exit the root PID may already belong to another process.
            try { if (pid && (!realChild || rootAlive())) killImpl(pid); } catch { /* bounded grace fallback */ }
            void job?.close();
        };
        const timer = setTimeoutImpl(() => { timedOut = true; stop(); }, remainingMs);
        const abort = () => { cancelled = true; stop(); };
        const cleanup = () => {
            clearTimeoutImpl(timer); clearTimeoutImpl(exitGrace); clearTimeoutImpl(killDeadline);
            signal?.removeEventListener("abort", abort);
        };
        const finish = (exitCode, exitSignal) => {
            if (done)
                return;
            done = true;
            cleanup();
            // A check that ended by itself fails the tree check only on a real survivor: an unreadable process table
            // alone must not turn a passing check into a restore (plan S18 review). A stopped check needs a confirmed kill.
            const ended = !stopped && !timedOut && !cancelled;
            const unsafe = (kill) => kill && !kill.confirmed && (!ended || pipesHeldOpen || (kill.alive?.length ?? 0) > 0);
            const settle = (kill) => resolve({ passed: exitCode === 0 && !timedOut && !cancelled && !exitSignal && !unsafe(kill),
                exitCode, signal: exitSignal ?? (cancelled ? "SIGKILL" : null), timedOut, killedForOutput: false,
                durationMs: performance.now() - started, stdoutTail: tail(stdout.chunks.slice(stdout.head)), stderrTail: tail(stderr.chunks.slice(stderr.head)),
                ...(unsafe(kill) ? { killConfirmed: false, stillAlive: kill.alive, ...(kill.unverified ? { killUnverified: true } : {}) } : {}),
                ...(kill && !kill.confirmed && !unsafe(kill) ? { treeCheckUnverified: true } : {}) });
            if (confirm) confirm.then(settle);
            else settle();
        };
        const collect = (chunk, window) => {
            if (done)
                return;
            // Keep a rolling 1 MiB redaction context per stream before cutting the final 8 KiB tails.
            pushRolling(window, chunk);
        };
        child.stdout.on("data", (chunk) => collect(chunk, stdout));
        child.stderr.on("data", (chunk) => collect(chunk, stderr));
        child.once("error", () => {
            if (done)
                return;
            done = true;
            cleanup();
            const fail = () => reject(new VerificationError("verification_launch_failed", "Could not launch verification executable."));
            if (confirm) confirm.then(fail);
            else fail();
        });
        child.once("exit", (code, sig) => {
            exitedAt = Date.now();
            if (job?.assigned) jobAssigned = true;
            void job?.close();
            if (done || stopped || !realChild) return;
            clearTimeoutImpl(timer);
            // A child outside the job can keep the pipes open after the root exits.
            exitGrace = setTimeoutImpl(() => {
                pipesHeldOpen = true;
                confirm ??= confirmKill();
                finish(code, sig);
                destroyPipes();
            }, EXIT_GRACE_MS);
        });
        child.once("close", (code, sig) => {
            if (stopped) finish(null, "SIGKILL");
            else {
                if (exitedAt === undefined) exitedAt = Date.now();
                if (job?.assigned) jobAssigned = true;
                if (realChild && !jobAssigned) confirm ??= confirmKill();
                finish(code, sig);
            }
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    }).finally(() => job?.close());
}
