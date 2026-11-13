import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "./safety.js";

export const guardSchema = z.object({
  maxRepeatedFailures: z.number().int().min(2).max(20).default(3),
  window: z.number().int().min(3).max(50).default(10),
  maxToolCalls: z.number().int().min(10).max(1000).default(150),
  maxInputTokens: z.number().int().min(10000).max(20000000).default(1500000),
}).strict().refine(o => o.window >= o.maxRepeatedFailures, "window must be at least maxRepeatedFailures");
const normalizedPath = s => s.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
const stable = v => v && typeof v === "object" ? Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function extractTarget(tool, input = {}) {
  for (const key of ["patchText", "patch", "input"]) {
    if (typeof input?.[key] !== "string") continue;
    const paths = [...input[key].matchAll(/^\*{3}\s*(?:Update|Add|Delete) File:\s*(.+)$/gm)].map(m => normalizedPath(m[1]));
    if (paths.length) return { target: [...new Set(paths)].sort().join(","), paths };
  }
  if (["bash", "execute_command", "run_commands"].includes(tool) && typeof input.command === "string") return { target: input.command.trim().replace(/\s+/g, " ").toLowerCase(), paths: [] };
  for (const key of ["filePath", "file_path", "path", "file", "target_file"]) if (typeof input?.[key] === "string") { const target = normalizedPath(input[key]); return { target, paths: [target] }; }
  for (const key of ["filePaths", "paths", "files"]) if (Array.isArray(input?.[key]) && input[key].length && input[key].every(p => typeof p === "string")) { const paths = [...new Set(input[key].map(normalizedPath))].sort(); return { target: paths.join(","), paths }; }
  return { target: createHash("sha256").update(stable(input) ?? "{}").digest("hex").slice(0, 12), paths: [] };
}

/** Cline's sliding-window policy over normalized OpenCode terminal events. */
export function createGuard(options = {}) {
  const limits = guardSchema.parse(options), window = [], files = new Set(), errors = [], seen = new Set();
  let totalToolCalls = 0, totalInputTokens = 0, lastAssistantText, trip;
  const snapshot = () => ({ ...trip, window: limits.window, totalToolCalls, totalInputTokens, lastErrors: [...errors], filesTouched: [...files], ...(lastAssistantText ? { lastAssistantText } : {}), observation: "Terminal tool results and per-step usage; limits can overshoot by an active tool/step." });
  const stop = (kind, data = {}) => { trip = { kind, ...data }; return snapshot(); };
  return {
    snapshot,
    observe(event) {
      if (trip) return snapshot();
      if (event.type === "text") { lastAssistantText = redactSecrets(event.text).slice(-400); return null; }
      if (event.id) { const key = `${event.sessionID ?? ""}:${event.type}:${event.id}`; if (seen.has(key)) return null; seen.add(key); }
      if (event.type === "usage") {
        totalInputTokens += event.usage.inputTokens;
        return totalInputTokens > limits.maxInputTokens ? stop("budget_exceeded") : null;
      }
      if (event.type !== "tool") return null;
      const tool = String(event.tool ?? "tool").toLowerCase(), { target, paths } = extractTarget(tool, event.input);
      totalToolCalls++;
      const exit = event.metadata?.exit ?? event.metadata?.exitCode;
      const bashFailure = tool === "bash" && (event.metadata?.timeout === true || (typeof exit === "number" && exit !== 0) || /Command exited with code [1-9]\d*\b/.test(event.output ?? ""));
      const failed = event.status === "error" || bashFailure;
      const signature = `${tool}:${target}`;
      window.push({ signature, failed }); if (window.length > limits.window) window.shift();
      if (failed) { errors.push(redactSecrets(String(event.error ?? event.output ?? "Tool failed")).slice(-300)); if (errors.length > 3) errors.shift(); }
      else if (/write|edit|patch/.test(tool)) paths.forEach(p => files.add(redactSecrets(p)));
      if (totalToolCalls > limits.maxToolCalls) return stop("budget_exceeded", { tool, target: redactSecrets(target) });
      const count = window.filter(e => e.failed && e.signature === signature).length;
      return failed && count >= limits.maxRepeatedFailures ? stop("loop_detected", { tool, target: redactSecrets(target), count }) : null;
    },
  };
}
