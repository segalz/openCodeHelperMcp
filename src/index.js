import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createModelCatalog, createOpenCodeRunner, registerAnalysisTools, resolvePathWithinAllowedRoots } from "./core.js";
import { registerEditTools } from "./edits.js";

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
