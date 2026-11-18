// Ported from ClineMcp; preserve recovery/lock compatibility.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { defaultKillTree } from "./process-utils.js";
import { confirmTreeDead } from "./proctree.js";
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
export async function resolveVerificationCommand(command, args = [], cwd = process.cwd()) {
    if (!command || command.includes("\0") || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
        throw new VerificationError("verification_refused", "Verification requires a command and literal string arguments.");
    }
    if (process.platform !== "win32")
        return { command, args };
    const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(path.basename(command));
    if (npm) {
        const script = npm[1].toLowerCase() + "-cli.js";
        const candidates = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
            ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : [])];
        for (const candidate of candidates) {
            try {
                await access(candidate);
                return { command: process.execPath, args: [candidate, ...args] };
            }
            catch { /* Try the next supported npm installation. */ }
        }
        throw new VerificationError("verification_refused", "Could not resolve the npm installation's CLI script.");
    }
    if (/\.(cmd|bat)$/i.test(command))
        throw new VerificationError("verification_refused", "Windows batch commands require a shell and are refused.");
    // Resolve plain executable names ourselves so PATHEXT cannot silently select a batch shim.
    const hasDirectory = command.includes("/") || command.includes("\\");
    const directories = hasDirectory ? [""] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const extensions = path.extname(command) ? [""] : [".exe", ".com"];
    for (const directory of directories)
        for (const extension of extensions) {
            const candidate = path.resolve(cwd, directory.replace(/^"|"$/g, ""), command + extension);
            try {
                await access(candidate);
                return { command: candidate, args };
            }
            catch { /* Continue PATH search. */ }
        }
    throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
}
function tail(chunks) {
    const redacted = Buffer.from(redactSecrets(Buffer.concat(chunks).toString("utf8")), "utf8");
    let start = Math.max(0, redacted.length - TAIL_LIMIT);
    // Do not start inside a UTF-8 code point (replacement characters could exceed the byte budget).
    while (start < redacted.length && (redacted[start] & 0xc0) === 0x80)
        start++;
    return redacted.subarray(start).toString("utf8");
}
export async function runVerification(spec, cwd, signal, { spawnImpl = spawn, resolveImpl = resolveVerificationCommand, killImpl = defaultKillTree, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    const timeout = spec.timeoutSeconds ?? 60;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)
        throw new VerificationError("verification_refused", "Verification timeout must be 1-300 seconds.");
    const started = performance.now();
    const executable = await resolveImpl(spec.command, spec.args, cwd);
    if (signal?.aborted)
        return { passed: false, exitCode: null, signal: "SIGKILL", timedOut: false,
            killedForOutput: false, durationMs: performance.now() - started, stdoutTail: "", stderrTail: "" };
    return new Promise((resolve, reject) => {
        let child;
        const rootStartedMs = Date.now();
        try { child = spawnImpl(executable.command, executable.args, {
            cwd: path.resolve(cwd), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
        }); } catch { reject(new VerificationError("verification_launch_failed", "Could not launch verification executable.")); return; }
        const stdout = [], stderr = [];
        let bytes = 0, timedOut = false, killedForOutput = false, cancelled = false, done = false;
        let killDeadline, confirm, exitedAt;
        // A real verify process tree must be confirmed dead before the result returns: a restore follows.
        const realChild = child instanceof ChildProcess && Number.isInteger(child.pid) && child.pid > 0;
        const rootAlive = () => exitedAt === undefined && child.exitCode === null && child.signalCode === null;
        child.once("exit", () => { exitedAt = Date.now(); });
        const stop = () => {
            if (done || killDeadline)
                return;
            // Settle even if an inherited pipe or OS kill failure prevents a close event.
            killDeadline = setTimeoutImpl(() => {
                child.kill("SIGKILL");
                child.stdout.destroy();
                child.stderr.destroy();
                finish(null, "SIGKILL");
            }, 5000);
            // After exit the root PID may already belong to another process: never kill it by PID again.
            try { if (child.pid && (!realChild || rootAlive())) killImpl(child.pid); } catch { /* bounded grace fallback */ }
            if (realChild) confirm = confirmTreeDead(child.pid, { killRoot: () => killImpl(child.pid), isRootAlive: rootAlive,
                rootStartedMs, rootExitedMs: () => exitedAt }).catch(() => ({ confirmed: false, alive: [child.pid], unverified: true }));
        };
        const timer = setTimeoutImpl(() => { timedOut = true; stop(); }, timeout * 1000);
        const abort = () => { cancelled = true; stop(); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            abort();
        const cleanup = () => { clearTimeoutImpl(timer); clearTimeoutImpl(killDeadline); signal?.removeEventListener("abort", abort); };
        const finish = (exitCode, exitSignal) => {
            if (done)
                return;
            done = true;
            cleanup();
            const settle = (kill) => resolve({ passed: exitCode === 0 && !timedOut && !killedForOutput && !cancelled && !exitSignal,
                exitCode, signal: exitSignal ?? (cancelled ? "SIGKILL" : null), timedOut, killedForOutput,
                durationMs: performance.now() - started, stdoutTail: tail(stdout), stderrTail: tail(stderr),
                ...(kill && !kill.confirmed ? { killConfirmed: false, stillAlive: kill.alive, ...(kill.unverified ? { killUnverified: true } : {}) } : {}) });
            if (confirm) confirm.then(settle);
            else settle();
        };
        const collect = (chunk, chunks) => {
            if (done || killedForOutput)
                return;
            // Keep a bounded redaction context before cutting the final 8 KiB tails.
            const remaining = Math.max(0, OUTPUT_LIMIT + 1 - bytes);
            chunks.push(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > OUTPUT_LIMIT) {
                killedForOutput = true;
                stop();
            }
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
        child.once("close", finish);
    });
}
