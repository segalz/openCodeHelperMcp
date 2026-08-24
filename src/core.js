import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_VARIANT = "low";
export const PROVIDERS = Object.freeze([
  Object.freeze({ key: "cloudflare", model: "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash", title: "Analyze code with Cloudflare GLM", description: "Read-only code analysis using the fixed Cloudflare Workers AI GLM 4.7 Flash model at low reasoning effort. Use this first." }),
  Object.freeze({ key: "mimo", model: "opencode/mimo-v2.5-free", title: "Analyze code with MiMo Free", description: "Read-only code analysis using the fixed OpenCode MiMo V2.5 Free model at low reasoning effort. Use this after Cloudflare GLM fails or is insufficient." }),
  Object.freeze({ key: "nemotron", model: "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", title: "Analyze code with NVIDIA Nemotron", description: "Read-only code analysis using the fixed NVIDIA Nemotron 3 Nano Omni model at low reasoning effort. Use this after MiMo fails or is insufficient." }),
]);

export const analysisInputSchema = Object.freeze({
  directory: z.string().min(1).describe("Absolute workspace path under an allowed root."),
  prompt: z.string().min(1).max(12_000).describe("The focused code-analysis question."),
});

export function createOpenCodeRunner({
  spawnImpl = defaultSpawn, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  env = process.env, platform = process.platform, execPath = process.execPath,
  timeoutMs = Number(env.OPENCODE_HELPER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
} = {}) {
  return ({ directory, prompt, model }) => {
    const windowsNpmBin = env.APPDATA ? path.join(env.APPDATA, "npm") : env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : null;
    const openCodePowerShellScript = platform === "win32" && windowsNpmBin ? path.join(windowsNpmBin, "opencode.ps1") : null;
    const executable = env.OPENCODE_BIN ?? (openCodePowerShellScript ? path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "opencode");
    const args = ["run", "--dir", directory, "--model", model, "--variant", DEFAULT_VARIANT, "--agent", "plan", "--format", "json", [
      "You are a read-only code analysis assistant.", "Do not create, edit, delete, rename, format, or apply files.", "Do not run commands that change the workspace or system state.", "Use search and read operations only.", "Never inspect node_modules, .git, dist, build, coverage, .next, or out unless the user explicitly asks about that exact directory.", "Prefer the smallest relevant files and directories; do not glob an entire workspace when a focused search will answer the question.", "Return a concise answer with relevant files, symbols, and evidence.", "\nUser request:", prompt,
    ].join("\n")];
    const childArgs = openCodePowerShellScript && !env.OPENCODE_BIN ? ["-NoProfile", "-NonInteractive", "-File", openCodePowerShellScript, ...args] : args;
    return new Promise((resolve) => {
      const child = spawnImpl(executable, childArgs, { cwd: directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PATH: [path.join(env.APPDATA ?? "", "npm"), path.dirname(execPath), env.PATH ?? ""].filter(Boolean).join(path.delimiter) } });
      let stdout = ""; let stderr = ""; let timedOut = false;
      const timer = setTimeoutImpl(() => { timedOut = true; child.kill(); }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeoutImpl(timer); resolve({ error: `Could not start OpenCode: ${error.message}` }); });
      child.on("close", (code) => { clearTimeoutImpl(timer); if (timedOut) return resolve({ error: "OpenCode analysis timed out." }); if (code !== 0) return resolve({ error: `OpenCode exited with code ${code}. ${stderr.trim()}`.trim() }); return resolve({ text: stdout.trim() || "OpenCode returned no analysis." }); });
    });
  };
}

export async function runWithFallback({ directory, prompt, runner }) {
  const attempts = [];
  for (const provider of PROVIDERS) {
    try {
      const result = await runner({ directory, prompt, model: provider.model });
      if (result?.text && result.text !== "OpenCode returned no analysis.") return { text: result.text, provider: provider.key, attempts };
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
  server.registerTool("analyze_code", { title: "Analyze code with deterministic OpenCode fallback", description: "Read-only code analysis with fixed Cloudflare, MiMo, then NVIDIA fallback. Use this first.", inputSchema: analysisInputSchema }, async ({ directory, prompt }) => {
    const validationError = validate(directory);
    if (validationError) return { content: [{ type: "text", text: validationError }], isError: true };
    const result = await runWithFallback({ directory: resolvePath(directory), prompt, runner });
    return result.error ? { content: [{ type: "text", text: "All OpenCode providers failed; direct Grok fallback is permitted." }], isError: true } : { content: [{ type: "text", text: result.text }] };
  });
}
