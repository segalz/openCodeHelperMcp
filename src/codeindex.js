import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defaultKillTree } from "./process-utils.js";

const mapReply = z.object({
  schemaVersion: z.literal(2), command: z.literal("map"),
  referencesAreCandidates: z.literal(true), truncated: z.boolean(), map: z.string(),
  anchors: z.array(z.object({
    text: z.string(), kind: z.enum(["identifier", "path", "lexical"]),
    matched: z.array(z.string()).min(1).max(8),
  }).strict()).max(16),
}).strict();

// Both Git discovery and the optional CLI share one deadline and output bound.
function capture(executable, args, { root, env, signal, input, spawnImpl, killTreeImpl, attemptDeadline }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawnImpl(executable, args, {
      cwd: root, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0, settled = false, stopping, killTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else {
        try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch (error) { reject(error); }
      }
    };
    const fail = error => {
      if (settled || stopping) return;
      stopping = error;
      // Wait for tree termination and closed pipes, with bounded cleanup if the
      // host refuses termination or a descendant keeps an inherited pipe open.
      killTimer = setTimeout(() => {
        try { child.kill?.("SIGKILL"); } catch { /* already exited */ }
        child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        finish(error);
      }, Math.max(0, Math.min(1000, attemptDeadline - performance.now())));
      try { if (child.pid) killTreeImpl(child.pid); } catch { /* already exited */ }
      child.stdin.destroy();
    };
    const stop = () => fail(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", chunk => {
      if (settled || stopping) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) fail(new Error("Code index output limit"));
      else chunks.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", code => finish(stopping ?? (code === 0 ? undefined : new Error("Code index process failed"))));
    child.stdin.on("error", fail);
    if (signal.aborted) stop();
    else child.stdin.end(input);
  });
}

/** Fail closed to the regex map, except caller cancellation which always escapes. */
export async function tryCodeindexMap(root, {
  cli, prompt = "", budget, timeBudgetMs = 10_000, signal,
  env = process.env, spawnImpl = spawn, killTreeImpl = defaultKillTree,
}) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(cli) || timeBudgetMs <= 0) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const attemptDeadline = performance.now() + timeBudgetMs;
  const deadline = Math.min(performance.now() + 10_000, attemptDeadline);
  const timer = setTimeout(() => controller.abort(new Error("Code index deadline")), Math.max(1, deadline - performance.now()));
  // Metadata calls do not accept a signal. Process calls handle cancellation
  // themselves so their termination completes before fallback or return.
  const bounded = operation => new Promise((resolve, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
  });
  try {
    if (!(await bounded(stat(cli))).isFile()) return undefined;
    controller.signal.throwIfAborted();
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
    gitEnv.GIT_OPTIONAL_LOCKS = "0";
    const options = { root, env: gitEnv, signal: controller.signal, spawnImpl, killTreeImpl, attemptDeadline };
    const top = (await capture(process.platform === "win32" ? "git.exe" : "git",
      ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", "--show-toplevel"], options)).trim();
    // Never expand an analysis subdirectory to its parent checkout.
    const [canonicalRoot, canonicalTop] = await bounded(Promise.all([realpath(root), realpath(top)]));
    controller.signal.throwIfAborted();
    if (canonicalRoot !== canonicalTop) return undefined;
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return undefined;
    const stdout = await capture(process.execPath, [cli, "map", "--root", root, "--json",
      "--budget", String(budget), "--deadline-ms", String(remaining)], { ...options, env, input: prompt });
    if (stdout.length > budget) return undefined;
    const reply = mapReply.safeParse(JSON.parse(stdout));
    return reply.success ? reply.data.map : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
