import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createModelCatalog, createOpenCodeRunner, registerAnalysisTools, resolvePathWithinAllowedRoots } from "./core.js";
import { registerEditTools, shutdownEdits } from "./edits.js";
import { shutdownJobObjects } from "./jobobject.js";

const DEFAULT_ALLOWED_ROOT = "C:\\Develop";

function configuredRoots() {
  return (process.env.OPENCODE_HELPER_ALLOWED_ROOTS ?? DEFAULT_ALLOWED_ROOT)
    .split(";").map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
}

async function resolveAllowedPath(directory) {
  return resolvePathWithinAllowedRoots(directory, configuredRoots());
}

const runner = createOpenCodeRunner();
const catalog = createModelCatalog({ runner });
const server = new McpServer({ name: "opencode-helper", version: "0.2.0" });
registerAnalysisTools(server, { runner, catalog, resolveAllowedPath });
registerEditTools(server, { runner, catalog, resolveAllowedPath });
await server.connect(new StdioServerTransport());

// A client exit or restart must not leave a half-done edit in the checkout with the lock released by
// process death: abort in-flight edits so they restore and release the shared lock, then exit.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownEdits(120_000).catch(() => {});
  shutdownJobObjects();
  process.exit(0);
};
process.stdin.on("end", () => { void shutdown(); });
process.stdin.on("close", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
