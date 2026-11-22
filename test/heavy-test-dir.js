import { after, beforeEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A retained lease lives as long as its bridge PID. Give each test its own machine directory.
const base = await mkdtemp(path.join(os.tmpdir(), "opencode-heavy-tests-"));
let sequence = 0;
process.env.BRIDGE_HEAVY_DIR = path.join(base, "0");
process.env.BRIDGE_HEAVY_SLOTS = "2";
beforeEach(() => {
  process.env.BRIDGE_HEAVY_DIR = path.join(base, String(++sequence));
  process.env.BRIDGE_HEAVY_SLOTS = "2";
});
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
