import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLOUDFLARE_MODEL = "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash";
const MIMO_MODEL = "opencode/mimo-v2.5-free";
const NEMOTRON_MODEL = "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const DEFAULT_VARIANT = "low";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ALLOWED_ROOT = "C:\\Develop";

function configuredRoots() {
  const value = process.env.OPENCODE_HELPER_ALLOWED_ROOTS ?? DEFAULT_ALLOWED_ROOT;
  return value
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
}

function isWithinAllowedRoot(directory) {
  const resolved = path.resolve(directory);
  return configuredRoots().some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function runOpenCode({ directory, prompt, model }) {
  const executable = process.env.OPENCODE_BIN ?? "opencode";
  const timeoutMs = Number(process.env.OPENCODE_HELPER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const args = [
    "run",
    "--dir",
    directory,
    "--model",
    model,
    "--variant",
    DEFAULT_VARIANT,
    "--agent",
    "plan",
    [
      "You are a read-only code analysis assistant.",
      "Do not create, edit, delete, rename, format, or apply files.",
      "Do not run commands that change the workspace or system state.",
      "Use search and read operations only.",
      "Never inspect node_modules, .git, dist, build, coverage, .next, or out unless the user explicitly asks about that exact directory.",
      "Prefer the smallest relevant files and directories; do not glob an entire workspace when a focused search will answer the question.",
      "Return a concise answer with relevant files, symbols, and evidence.",
      "\nUser request:",
      prompt,
    ].join("\n"),
  ];

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: directory,
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error: `Could not start OpenCode: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ error: "OpenCode analysis timed out." });
        return;
      }
      if (code !== 0) {
        resolve({ error: `OpenCode exited with code ${code}. ${stderr.trim()}`.trim() });
        return;
      }
      resolve({ text: stdout.trim() || "OpenCode returned no analysis." });
    });
  });
}

const server = new McpServer({
  name: "opencode-helper",
  version: "0.1.0",
});

function registerAnalysisTool({ name, title, description, model }) {
  server.registerTool(name, {
    title,
    description,
    inputSchema: {
      directory: z.string().min(1).describe("Absolute workspace path under an allowed root."),
      prompt: z.string().min(1).max(12_000).describe("The focused code-analysis question."),
    },
  }, async ({ directory, prompt }) => {
    if (!path.isAbsolute(directory)) {
      return { content: [{ type: "text", text: "The directory must be an absolute path." }], isError: true };
    }
    if (!isWithinAllowedRoot(directory)) {
      return { content: [{ type: "text", text: "The directory is outside the helper's allowed roots." }], isError: true };
    }
    const result = await runOpenCode({ directory: path.resolve(directory), prompt, model });
    return result.error
      ? { content: [{ type: "text", text: result.error }], isError: true }
      : { content: [{ type: "text", text: result.text }] };
  });
}

registerAnalysisTool({
  name: "analyze_code_cloudflare",
  title: "Analyze code with Cloudflare GLM",
  description: "Read-only code analysis using the fixed Cloudflare Workers AI GLM 4.7 Flash model at low reasoning effort. Use this first.",
  model: CLOUDFLARE_MODEL,
});

registerAnalysisTool({
  name: "analyze_code_mimo",
  title: "Analyze code with MiMo Free",
  description: "Read-only code analysis using the fixed OpenCode MiMo V2.5 Free model at low reasoning effort. Use this after Cloudflare GLM fails or is insufficient.",
  model: MIMO_MODEL,
});

registerAnalysisTool({
  name: "analyze_code_nemotron",
  title: "Analyze code with NVIDIA Nemotron",
  description: "Read-only code analysis using the fixed NVIDIA Nemotron 3 Nano Omni model at low reasoning effort. Use this after MiMo fails or is insufficient.",
  model: NEMOTRON_MODEL,
});

const transport = new StdioServerTransport();
await server.connect(transport);
