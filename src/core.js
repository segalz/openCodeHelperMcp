import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 40_000;
export const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000;
export const EXIT_GRACE_MS = 1_000;
export const DEFAULT_VARIANT = "low";
export const PROVIDERS = Object.freeze([
  Object.freeze({ key: "nvidia", model: "nvidia/openai/gpt-oss-20b", title: "Analyze code with NVIDIA GPT-OSS", description: "Read-only code analysis using the fixed NVIDIA OpenAI GPT-OSS 20B model at low reasoning effort. Use this first." }),
  Object.freeze({ key: "mimo", model: "opencode/mimo-v2.5-free", title: "Analyze code with MiMo Free", description: "Read-only code analysis using the fixed OpenCode MiMo V2.5 Free model at low reasoning effort. Use this after NVIDIA GPT-OSS fails or is insufficient." }),
  Object.freeze({ key: "cloudflare", model: "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash", title: "Analyze code with Cloudflare GLM", description: "Read-only code analysis using the fixed Cloudflare Workers AI GLM 4.7 Flash model at low reasoning effort. Use this only after NVIDIA GPT-OSS and MiMo fail or are insufficient." }),
]);

export const analysisInputSchema = Object.freeze({
  directory: z.string().min(1).describe("Absolute workspace path under an allowed root."),
  prompt: z.string().min(1).max(12_000).describe("The focused code-analysis question."),
});

function validTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseOpenCodeNdjson(stdout) {
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (events.length === 0) return { error: "OpenCode returned no valid analysis." };
  const texts = [];
  for (const event of events) {
    if (event.error || /error|failed/i.test(event.type ?? "") || /error|failed/i.test(event.part?.type ?? "")) return { error: "OpenCode reported an analysis error." };
    const text = event.part?.type === "text" ? event.part.text : event.type === "text" ? event.text : event.result?.text;
    if (typeof text === "string" && text.trim()) texts.push(text.trim());
  }
  return texts.length > 0 ? { text: texts.at(-1) } : { error: "OpenCode returned no valid analysis." };
}

export function defaultKillProcessTree(child, { platform = process.platform, spawnImpl = defaultSpawn } = {}) {
  if (platform === "win32" && Number.isInteger(child.pid)) {
    const terminator = spawnImpl("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
    terminator.on("error", () => child.kill());
    return;
  }
  child.kill();
}

export function createOpenCodeRunner({
  spawnImpl = defaultSpawn, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  killProcessTreeImpl, env = process.env, platform = process.platform, execPath = process.execPath,
  timeoutMs = Number(env.OPENCODE_HELPER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), graceMs = EXIT_GRACE_MS,
} = {}) {
  const terminate = killProcessTreeImpl ?? ((child) => defaultKillProcessTree(child, { platform, spawnImpl }));
  return ({ directory, prompt, model, timeoutMs: requestTimeoutMs }) => {
    const executable = env.OPENCODE_BIN ?? "opencode";
    const args = ["run", "--dir", directory, "--model", model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format", "json", [
      "You are a read-only code analysis assistant.", "Do not create, edit, delete, rename, format, or apply files.", "Do not run commands that change the workspace or system state.", "Use search and read operations only.", "Never inspect node_modules, .git, dist, build, coverage, .next, or out unless the user explicitly asks about that exact directory.", "Prefer the smallest relevant files and directories; do not glob an entire workspace when a focused search will answer the question.", "Respond only in concise English Markdown. Use clear headings and short bullets. Do not use Hebrew, include a preamble, a reasoning trace, or code excerpts unless explicitly requested. Keep the answer within 120 words.", "\nUser request:", prompt,
    ].join("\n")];
    const effectiveTimeoutMs = Math.min(validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), validTimeout(requestTimeoutMs, Infinity));
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(executable, args, { cwd: directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PATH: [path.join(env.APPDATA ?? "", "npm"), path.dirname(execPath), env.PATH ?? ""].filter(Boolean).join(path.delimiter) } });
      } catch (error) {
        resolve({ error: `Could not start OpenCode: ${error.message}` });
        return;
      }
      let stdout = ""; let stderr = ""; let settled = false; let timedOut = false; let exitCode = null;
      let timeoutTimer; let graceTimer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timeoutTimer);
        clearTimeoutImpl(graceTimer);
        resolve(result);
      };
      const finishFromExit = () => {
        if (timedOut) return finish({ error: "OpenCode analysis timed out." });
        if (exitCode !== 0) return finish({ error: `OpenCode exited with code ${exitCode}. ${stderr.trim()}`.trim() });
        return finish(parseOpenCodeNdjson(stdout));
      };
      timeoutTimer = setTimeoutImpl(() => {
        timedOut = true;
        terminate(child);
        graceTimer = setTimeoutImpl(() => finish({ error: "OpenCode analysis timed out." }), graceMs);
      }, effectiveTimeoutMs);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => finish({ error: `Could not start OpenCode: ${error.message}` }));
      child.on("exit", (code) => { exitCode = code; graceTimer ??= setTimeoutImpl(finishFromExit, graceMs); });
      child.on("close", (code) => { exitCode = code; finishFromExit(); });
    });
  };
}

export async function runWithFallback({ directory, prompt, runner, timeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS, nowImpl = Date.now }) {
  const attempts = []; const deadline = nowImpl() + validTimeout(timeoutMs, DEFAULT_FALLBACK_TIMEOUT_MS);
  for (const provider of PROVIDERS) {
    const remainingMs = deadline - nowImpl();
    if (remainingMs <= 0) return { error: "all-providers-failed", attempts: [...attempts, { provider: provider.key, status: "deadline" }] };
    try {
      const result = await runner({ directory, prompt, model: provider.model, timeoutMs: remainingMs });
      if (result?.text) return { text: result.text, provider: provider.key, attempts };
      attempts.push({ provider: provider.key, status: result?.error === "OpenCode analysis timed out." ? "timeout" : "failed" });
    } catch { attempts.push({ provider: provider.key, status: "failed" }); }
  }
  return { error: "all-providers-failed", attempts };
}

export function registerAnalysisTools(server, { runner, isWithinAllowedRoot, resolvePath = path.resolve, isAbsolute = path.isAbsolute } = {}) {
  const validate = (directory) => !isAbsolute(directory) ? "The directory must be an absolute path." : !isWithinAllowedRoot(directory) ? "The directory is outside the helper's allowed roots." : null;
  const makeHandler = (provider) => async ({ directory, prompt }) => {
    const validationError = validate(directory);
    if (validationError) return { content: [{ type: "text", text: validationError }], isError: true };
    const result = await runner({ directory: resolvePath(directory), prompt, model: provider.model });
    return result.error ? { content: [{ type: "text", text: result.error }], isError: true } : { content: [{ type: "text", text: result.text }] };
  };
  for (const provider of PROVIDERS) server.registerTool(`analyze_code_${provider.key}`, { title: provider.title, description: provider.description, inputSchema: analysisInputSchema }, makeHandler(provider));
  server.registerTool("analyze_code", { title: "Analyze code with deterministic OpenCode fallback", description: "Read-only code analysis with fixed NVIDIA GPT-OSS, MiMo, then Cloudflare fallback. Use this first.", inputSchema: analysisInputSchema }, async ({ directory, prompt }) => {
    const validationError = validate(directory);
    if (validationError) return { content: [{ type: "text", text: validationError }], isError: true };
    const result = await runWithFallback({ directory: resolvePath(directory), prompt, runner });
    return result.error ? { content: [{ type: "text", text: "All OpenCode providers failed; direct Grok fallback is permitted." }], isError: true } : { content: [{ type: "text", text: result.text }] };
  });
}
