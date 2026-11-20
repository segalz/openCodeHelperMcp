/** Send periodic MCP progress notifications while a synchronous tool call runs. */
export async function withProgressHeartbeat(extra, work, { intervalMs = 15_000 } = {}) {
  const progressToken = extra?._meta?.progressToken;
  // Any string (the empty string too) or number is a valid MCP progress token.
  const hasToken = typeof progressToken === "string" || typeof progressToken === "number";
  if (!hasToken || typeof extra?.sendNotification !== "function") return work();

  const stepMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000;
  const started = performance.now();
  let progress = 0;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    progress += 1;
    const elapsedSec = Math.round((performance.now() - started) / 1000);
    const message = `still running, ${elapsedSec} s elapsed`;
    try {
      Promise.resolve(extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      })).catch(() => {});
    } catch {
      // Ignore notification errors so they never affect the tool call.
    }
  }, stepMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    done = true;
    clearInterval(timer);
  }
}
