import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createModelCatalog, createOpenCodeRunner, registerAnalysisTools, resolvePathWithinAllowedRoots, shutdownAnalysis } from "./core.js";
import { registerEditTools, shutdownEdits } from "./edits.js";
import { shutdownJobObjects } from "./jobobject.js";
import { sweepOldSnapshots } from "./snapshot.js";
import { configuredRoots } from "./roots.js";

async function resolveAllowedPath(directory) {
  return resolvePathWithinAllowedRoots(directory, configuredRoots());
}

const runner = createOpenCodeRunner();
const catalog = createModelCatalog({ runner });
const server = new McpServer({ name: "opencode-helper", version: "0.2.0" });
registerAnalysisTools(server, { runner, catalog, resolveAllowedPath });
registerEditTools(server, { runner, catalog, resolveAllowedPath });
await server.connect(new StdioServerTransport());
void sweepOldSnapshots().catch(() => {});

// A client exit or restart must not leave a half-done edit in the checkout with the lock released by
// process death: abort in-flight edits so they restore and release the shared lock, then exit.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([
    shutdownAnalysis(30_000), // Close admission and stop pooled servers before edit recovery.
    shutdownEdits(120_000),
  ]);
  shutdownJobObjects();
  process.exit(0);
};
process.stdin.on("end", () => { void shutdown(); });
process.stdin.on("close", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
