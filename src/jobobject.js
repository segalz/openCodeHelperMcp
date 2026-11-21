// Keep in step with ClineMcp/src/jobobject.ts. Each helper owns exactly one Windows job.
import { ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { KILL_SETTLE_MS, PROCESS_QUERY_TIMEOUT_MS } from "./waits.js";

const source = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

class JobOwner {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, Terminated;
    }
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObjectW(IntPtr security, IntPtr name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Main() {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) return;
        try {
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE alone
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return;
            Console.WriteLine("ready");
            string line;
            while ((line = Console.ReadLine()) != null) {
                int pid;
                if (!int.TryParse(line, out pid) || pid <= 0) break;
                bool assigned = false;
                IntPtr process = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
                if (process != IntPtr.Zero) {
                    try {
                        // Pin the identity before asking Node whether its original ChildProcess still lives.
                        Console.WriteLine("opened");
                        if (Console.ReadLine() == "assign") assigned = AssignProcessToJobObject(job, process);
                    } finally { CloseHandle(process); }
                }
                Console.WriteLine(assigned ? "assigned" : "skipped");
            }
            bool confirmed = false;
            if (TerminateJobObject(job, 1)) {
                Accounting info;
                int started = Environment.TickCount;
                while (QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) {
                    if (info.ActiveProcesses == 0) { confirmed = true; break; }
                    if (unchecked(Environment.TickCount - started) >= 2000) break;
                    Thread.Sleep(5);
                }
            }
            Console.WriteLine(confirmed ? "drained" : "active");
            Console.Out.Flush();
        } finally { CloseHandle(job); }
    }
}`;

// Share the completed executable between servers and test workers. Concurrent cold builds publish only
// complete binaries, and compile in the user's temporary directory with the in-box Framework compiler.
async function buildHelper() {
  const directory = path.join(os.tmpdir(), "mcp-winjob-" + createHash("sha256").update(source).digest("hex"));
  const executable = path.join(directory, "owner.exe");
  try { await access(executable); return executable; } catch { /* first use */ }
  await mkdir(directory, { recursive: true });
  const staging = path.join(directory, randomUUID());
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
  try {
    await writeFile(staging + ".cs", source, { flag: "wx" });
    await new Promise((resolve, reject) => {
      const child = spawn(compiler, ["/nologo", "/noconfig", "/target:exe", "/optimize+", "/out:" + staging + ".exe", staging + ".cs"],
        { cwd: directory, stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, PROCESS_QUERY_TIMEOUT_MS).unref();
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error("Job helper compilation failed"));
      });
      child.unref();
    });
    try { await rename(staging + ".exe", executable); } catch { await access(executable); }
    return executable;
  } finally {
    await Promise.all([staging + ".cs", staging + ".exe"].map(file => rm(file, { force: true }).catch(() => {})));
  }
}

let executable;
let retryBuildAfter = 0;
let shuttingDown = false;
const owners = new Set();

function getHelper() {
  if (Date.now() < retryBuildAfter) return Promise.resolve(undefined);
  return executable ??= buildHelper().catch(() => {
    retryBuildAfter = Date.now() + 60_000;
    executable = undefined;
    return undefined;
  });
}

/** The helper and both pipes are unreferenced. EOF (also on server death) closes its sole job handle. */
function startOwner(file) {
  const child = spawn(file, [], { cwd: path.dirname(file), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  owners.add(child);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  let pending;
  const queued = [];
  let assigned = false;
  let assignedCount = 0;
  let missedAssignment = false;
  let drained = false;
  let confirmed = false;
  let closing = false;
  let exited = false;
  let ended = false;
  let repliesClosed = false;
  let timer;
  const canConfirm = () => drained && assignedCount > 0 && !missedAssignment && !pending && queued.length === 0;
  const kill = () => {
    try {
      if (!ended && child.exitCode === null && child.signalCode === null) child.ref?.();
      child.kill();
    } catch {
      try { child.unref?.(); } catch { /* already gone */ }
    }
  };
  let closeSignal;
  let closeDeadline = Infinity;
  const forceClose = () => {
    if (pending || queued.length > 0) missedAssignment = true;
    closeSignal?.removeEventListener("abort", forceClose);
    clearTimeout(timer);
    kill();
    confirmed = canConfirm();
    finish(confirmed);
  };
  const end = () => {
    if (ended) return;
    if (pending || queued.length > 0) missedAssignment = true;
    exited = true;
    ended = true;
    assigned = false;
    pending = undefined;
    queued.length = 0;
    owners.delete(child);
    closeSignal?.removeEventListener("abort", forceClose);
    clearTimeout(timer);
    confirmed = canConfirm();
    ready(false);
    finish(confirmed);
  };
  child.once("error", end);
  // Mark exited immediately on `exit` so `alive` turns false for callers waiting on exit (e.g. broken stdout),
  // while waiting for `replies` / `close` before `end()` so the final "drained"/"active" stdout line is always read first.
  child.once("exit", () => { exited = true; assigned = false; owners.delete(child); if (!closing || repliesClosed) end(); });
  child.once("close", end);
  child.stdin.on("error", kill);
  child.stdout.on("error", kill);
  const rootIsLive = (root) => root.exitCode === null && root.signalCode === null;
  const sendNext = () => {
    while (queued.length) {
      const root = queued.shift();
      if (!rootIsLive(root)) {
        missedAssignment = true;
        continue;
      }
      pending = root;
      assigned = false;
      child.stdin.write(root.pid + "\n");
      return;
    }
    if (closing) child.stdin.end();
  };
  const replies = createInterface({ input: child.stdout });
  replies.on("error", kill);
  replies.once("close", () => { repliesClosed = true; if (exited) end(); });
  replies.on("line", line => {
    if (ended) return;
    if (line === "ready") ready(true);
    if (line === "opened") {
      const live = pending && rootIsLive(pending);
      child.stdin.write(live ? "assign\n" : "skip\n");
    }
    if (line === "assigned" || line === "skipped") {
      assigned = line === "assigned";
      if (assigned) assignedCount++;
      else missedAssignment = true;
      pending = undefined;
      sendNext();
    }
    if (line === "drained") {
      drained = true;
      confirmed = canConfirm();
    }
  });
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  const job = {
    get alive() { return !ended && !exited && !closing; },
    get assigned() { return assigned; },
    get confirmed() { return confirmed; },
    assign(root) {
      if (!(root instanceof ChildProcess) || !root.pid) return;
      if (!job.alive || !rootIsLive(root)) {
        if (!ended) missedAssignment = true;
        return;
      }
      queued.push(root);
      if (!pending) sendNext();
    },
    close(budgetMs = KILL_SETTLE_MS, signal) {
      if (!ended) {
        const cap = Math.min(KILL_SETTLE_MS, budgetMs);
        if (!closing) {
          closing = true;
          // A wedged helper can be killed independently. Closing its last handle enforces the same limit.
          if (signal?.aborted || cap <= 0) forceClose();
          else {
            closeSignal = signal;
            closeDeadline = performance.now() + cap;
            signal?.addEventListener("abort", forceClose, { once: true });
            timer = setTimeout(forceClose, cap);
            if (!pending) sendNext();
          }
        } else if (signal?.aborted || cap <= 0) {
          forceClose();
        } else {
          if (signal && signal !== closeSignal) {
            closeSignal?.removeEventListener("abort", forceClose);
            closeSignal = signal;
            signal.addEventListener("abort", forceClose, { once: true });
          }
          const nextDeadline = performance.now() + cap;
          if (nextDeadline < closeDeadline) {
            closeDeadline = nextDeadline;
            clearTimeout(timer);
            timer = setTimeout(forceClose, cap);
          }
        }
      }
      return finished;
    },
  };
  return { started, job, kill };
}

/** Prepare before spawn so cold compilation or helper startup cannot widen the assignment race. */
export function createWindowsJob(budgetMs, signal) {
  if (process.platform !== "win32" || shuttingDown || signal?.aborted || !(budgetMs > 0)) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const starting = new Set();
    let settled = false;
    let retry;
    const cancel = () => finish();
    const timer = setTimeout(cancel, Math.min(PROCESS_QUERY_TIMEOUT_MS, budgetMs / 2));
    signal?.addEventListener("abort", cancel, { once: true });

    function finish(winner) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retry);
      signal?.removeEventListener("abort", cancel);
      for (const owner of starting) if (owner !== winner) owner.kill();
      resolve(winner?.job);
    }

    const launch = (file, attempt) => {
      retry = undefined;
      if (settled || shuttingDown) { finish(); return; }
      // Windows can stall a single Framework process in its loader for seconds. Race a spare
      // within the same startup budget. Only the ready winner ever receives a CLI PID.
      if (attempt < 3) retry = setTimeout(() => launch(file, attempt + 1), 175 * attempt);
      const finishIfExhausted = () => { if (!retry && !starting.size) finish(); };
      try {
        const owner = startOwner(file);
        starting.add(owner);
        void owner.started.then(ok => {
          if (ok) finish(owner);
          else { starting.delete(owner); finishIfExhausted(); }
        });
      } catch { finishIfExhausted(); }
    };
    void getHelper().then(file => file ? launch(file, 1) : finish());
  });
}

export function shutdownJobObjects() {
  shuttingDown = true;
  for (const owner of owners) { try { owner.kill(); } catch { /* already gone */ } }
}
