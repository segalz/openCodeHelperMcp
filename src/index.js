import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOpenCodeRunner, registerAnalysisTools, resolvePathWithinAllowedRoots } from "./core.js";

const DEFAULT_ALLOWED_ROOT = "C:\\Develop";

function configuredRoots() {
  return (process.env.OPENCODE_HELPER_ALLOWED_ROOTS ?? DEFAULT_ALLOWED_ROOT)
    .split(";").map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
}

async function resolveAllowedPath(directory) {
  return resolvePathWithinAllowedRoots(directory, configuredRoots());
}

const server = new McpServer({ name: "opencode-helper", version: "0.1.0" });
registerAnalysisTools(server, { runner: createOpenCodeRunner(), resolveAllowedPath });
await server.connect(new StdioServerTransport());
