import os from "node:os";
import path from "node:path";

/** Allowed workspace roots: OPENCODE_HELPER_ALLOWED_ROOTS (';' on Windows, ':' elsewhere) or the default Develop folder. */
export function configuredRoots({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const raw = env.OPENCODE_HELPER_ALLOWED_ROOTS ?? (platform === "win32" ? "C:\\Develop" : p.join(homedir, "Develop"));
  return raw.split(platform === "win32" ? ";" : ":").map((root) => root.trim()).filter(Boolean).map((root) => p.resolve(root));
}