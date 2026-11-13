import { spawn } from "node:child_process";
export const WINDOWS_COMMAND_LINE_LIMIT = 32000;

// libuv/CommandLineToArgvW escaping, measured in UTF-16 code units including NUL.
export function windowsCommandLineLength(executable, args) {
  const quote = value => {
    const s = String(value);
    if (s && !/[\s"]/.test(s)) return s;
    return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  };
  return [executable, ...args].map(quote).join(" ").length + 1;
}

export function defaultKillTree(pid) {
  if (process.platform === "win32") {
    const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
    child.on("error", () => { try { process.kill(pid, "SIGKILL"); } catch {} });
  } else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
}
