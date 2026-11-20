import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const HOST = "127.0.0.1";
const LISTEN_MS = 15_000;
const IDLE_MS = 120_000;
const MAX_ANALYSIS_SERVERS = 2;
const liveServers = new Set();
let shuttingDown = false;

async function freeLoopbackPort(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createServer();
    let port;
    socket.once("error", reject);
    socket.once("close", () => resolve(port));
    socket.listen({ host: HOST, port: 0, exclusive: true, signal }, () => {
      port = socket.address()?.port;
      socket.close();
    });
  });
}

function configKey({ executable, mode, cwd, env }) {
  // Include inherited settings too. Keep both the key and the environment out of diagnostics.
  const values = Object.keys(env).sort().filter(name => env[name] !== undefined).map(name => [name, String(env[name])]);
  return JSON.stringify([executable, mode, cwd, values]);
}

function requireStopped(result) {
  if (result?.killConfirmed === false) {
    throw Object.assign(new Error("Could not confirm that the OpenCode server stopped."), {
      kind: "server_stop_unconfirmed", killConfirmed: false, stillAlive: result.stillAlive,
      ...(result.killUnverified ? { killUnverified: true } : {}),
    });
  }
}

/** Owned by one edit transaction, including time spent in its verification checks. */
export function createEditServerScope() {
  return {
    server: undefined,
    async close() {
      if (this.server) requireStopped(await this.server.stop());
      this.server = undefined;
    },
  };
}

export function shutdownServers() {
  shuttingDown = true;
  return Promise.allSettled([...liveServers].map(server => server.stop()));
}

export function createServerPool({ getFreePort = freeLoopbackPort, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  // In release order. Starting and stopping servers count toward capacity until their tree is reaped.
  const analysis = new Set();

  function start(config, key, runProcess, timeoutMs) {
    const controller = new AbortController();
    const { signal } = controller;
    let announce;
    const ready = new Promise(resolve => { announce = resolve; });
    // `opencode serve` is unauthenticated without a password: any local process, or a web page through DNS
    // rebinding, could drive it with this server's permissions. Each server gets its own basic-auth secret,
    // passed only through the environment (never argv) to the server and the runs attached to it.
    const password = randomBytes(32).toString("hex");
    const server = {
      key, signal, ready, password, logs: new EventEmitter(), busy: true, idleTimer: undefined,
      stop() { controller.abort(); return server.done; },
    };
    const timer = setTimeoutImpl(() => server.stop(), Math.min(LISTEN_MS, timeoutMs));
    const cancelled = new Promise(resolve => signal.addEventListener("abort", () => {
      announce(undefined);
      resolve(undefined);
      clearTimeoutImpl(timer);
      clearTimeoutImpl(server.idleTimer);
    }, { once: true }));
    liveServers.add(server);
    server.done = (async () => {
      let port;
      try { port = await Promise.race([getFreePort(signal), cancelled]); } catch { return; }
      if (signal.aborted || shuttingDown || !Number.isInteger(port) || port < 1 || port > 65535) return;
      const url = `http://${HOST}:${port}`;
      const banner = `opencode server listening on ${url}`;
      const pending = { stdout: "", stderr: "" };
      let listening = false;
      // A successful TCP connect alone could belong to a different process that won the port race.
      // Accept only our child's complete announcement for the exact requested loopback endpoint.
      const readBanner = (channel, chunk) => {
        if (listening || signal.aborted) return;
        const lines = (pending[channel] + chunk).split("\n");
        pending[channel] = lines.pop().slice(-1024);
        for (const line of lines) {
          const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim().replace(/\/$/, "");
          if (clean !== banner) continue;
          listening = true;
          clearTimeoutImpl(timer);
          announce(url);
          break;
        }
      };
      return runProcess({
        executable: config.executable, cwd: config.cwd, env: { ...config.env, OPENCODE_SERVER_PASSWORD: password },
        args: ["serve", "--hostname", HOST, "--port", String(port), "--print-logs", "--log-level", "ERROR"],
        signal, timeoutMs: Infinity, collectStdout: false, collectStderr: false,
        maxStdoutBytes: Infinity, maxStderrBytes: Infinity,
        onStdout: chunk => readBanner("stdout", chunk),
        onStderr: chunk => { readBanner("stderr", chunk); server.logs.emit("data", chunk); },
        onExit: () => controller.abort(),
      });
    })().catch(() => ({ killConfirmed: false, stillAlive: [], killUnverified: true })).then(result => {
      controller.abort();
      liveServers.delete(server);
      // Even an unconfirmed stop leaves the pool: otherwise two such servers would block warm analysis for good.
      analysis.delete(server);
      return result;
    });
    return server;
  }

  async function acquire(config, { editScope, signal, remainingMs, runProcess }) {
    if (shuttingDown || signal.aborted || remainingMs() <= 0) return;
    const key = configKey(config);
    let server;
    if (config.mode === "edits") {
      server = editScope?.server;
      if (server && (server.key !== key || server.signal.aborted)) {
        await editScope.close();
        server = undefined;
      }
    } else {
      const idle = [...analysis].filter(entry => !entry.busy && !entry.signal.aborted);
      server = idle.find(entry => entry.key === key);
      if (!server && analysis.size >= MAX_ANALYSIS_SERVERS) {
        // Both servers can be executing models. Let an independent cold run keep its own deadline
        // and guard rather than killing another run or attributing its quota logs to this caller.
        if (!idle.length) return;
        // An evicted server whose stop is unconfirmed must not fail this caller: it runs cold instead.
        if ((await idle[0].stop())?.killConfirmed === false) return;
        // Another caller may have claimed the freed slot while the tree was being reaped.
        return acquire(config, { editScope, signal, remainingMs, runProcess });
      }
    }
    const timeLeft = remainingMs();
    if (shuttingDown || signal.aborted || timeLeft <= 0) return;
    if (!server) {
      server = start(config, key, runProcess, timeLeft);
      if (config.mode === "analysis") analysis.add(server);
      else if (editScope) editScope.server = server;
    }
    server.busy = true;
    clearTimeoutImpl(server.idleTimer);
    const cancel = () => server.stop();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const url = await server.ready;
      if (!url || server.signal.aborted || signal.aborted) {
        requireStopped(await server.stop());
        return;
      }
      return {
        url, password: server.password, signal: server.signal, logs: server.logs, stop: server.stop,
        release() {
          if (server.signal.aborted || (config.mode === "edits" && !editScope)) {
            return server.stop();
          }
          server.busy = false;
          if (config.mode === "analysis") {
            analysis.delete(server);
            analysis.add(server);
            server.idleTimer = setTimeoutImpl(() => server.stop(), IDLE_MS);
            server.idleTimer?.unref?.();
          }
        },
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  return { acquire };
}
