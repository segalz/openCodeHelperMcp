import { StringDecoder } from "node:string_decoder";

export const MAX_EVENT_LINE_BYTES = 256 * 1024;
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
export const emptyUsage = () => ({ inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0, steps: 0 });

/** Terminal tool/step events are unique observations, not deltas or snapshots. */
export function createEventStream({ onEvent = () => {}, onFatal = () => {}, maxLineBytes = MAX_EVENT_LINE_BYTES } = {}) {
  const decoder = new StringDecoder("utf8"), tools = new Set(), steps = new Set();
  let pending = "", sessionID, messageID, legacyText, fatal, eventCount = 0, ended = false;
  const messages = new Set();
  let halted = false;
  const emit = event => { if (onEvent(event) === false) halted = true; };
  const texts = new Map(), usage = emptyUsage(), toolErrors = [];
  const fail = detail => { if (!fatal) { fatal = detail; onFatal(detail); } };
  function accept(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) || fatal) return;
    eventCount++;
    if (event.sessionID) {
      if (sessionID && sessionID !== event.sessionID) return fail("OpenCode changed session ID within a run.");
      sessionID = event.sessionID;
    }
    const part = event.part;
    if (event.error || event.type === "error") {
      const error = event.error;
      return fail(typeof error === "string" ? error : error?.data?.message ?? error?.message ?? JSON.stringify(error ?? event));
    }
    if (part?.messageID && !messages.has(part.messageID)) { messages.add(part.messageID); messageID = part.messageID; texts.clear(); legacyText = undefined; }
    if (event.type === "tool_use" && part?.type === "tool" && ["completed", "error"].includes(part.state?.status)) {
      const id = part.callID ?? part.id;
      if (!id) return fail("OpenCode tool event has no call or part ID.");
      if (tools.has(id)) return;
      tools.add(id);
      const tool = { type: "tool", id, sessionID, tool: part.tool, ...part.state };
      if (tool.status === "error") { toolErrors.push(String(tool.error ?? "Tool failed")); if (toolErrors.length > 10) toolErrors.shift(); }
      emit(tool);
    } else if (event.type === "step_finish" && part?.type === "step-finish") {
      if (!part.id) return fail("OpenCode usage event has no step ID.");
      if (steps.has(part.id)) return;
      steps.add(part.id);
      if (!part.tokens) return;
      const tokens = part.tokens;
      const delta = { inputTokens: number(tokens.input) + number(tokens.cache?.read) + number(tokens.cache?.write), uncachedInputTokens: number(tokens.input), cacheReadTokens: number(tokens.cache?.read), cacheWriteTokens: number(tokens.cache?.write), outputTokens: number(tokens.output), reasoningTokens: number(tokens.reasoning), cost: number(part.cost), steps: 1 };
      for (const key of Object.keys(usage)) usage[key] += delta[key];
      emit({ type: "usage", id: part.id, sessionID, usage: delta });
    } else {
      const text = part?.type === "text" ? part.text : event.type === "text" ? event.text : event.result?.text;
      if (typeof text !== "string" || !text.trim()) return;
      if (part?.messageID && part.messageID !== messageID) return;
      if (part?.messageID) texts.set(part.id ?? "text", text.trim());
      else legacyText = text.trim(); // Preserve legacy synthetic/older CLI output.
      emit({ type: "text", text });
    }
  }
  function line(raw) {
    if (Buffer.byteLength(raw) > maxLineBytes) return fail("OpenCode event line exceeded the size limit.");
    if (!raw.trim()) return;
    try { accept(JSON.parse(raw)); } catch { if (/^\s*[\[{]/.test(raw)) fail("Malformed OpenCode JSON event."); }
  }
  function feed(text) {
    pending += text;
    let pos;
    while (!fatal && !halted && (pos = pending.indexOf("\n")) >= 0) { const raw = pending.slice(0, pos); pending = pending.slice(pos + 1); line(raw); }
    if (Buffer.byteLength(pending) > maxLineBytes) fail("OpenCode event line exceeded the size limit.");
    if (fatal || halted) pending = "";
  }
  return {
    write(chunk) { if (!ended && !fatal && !halted) feed(typeof chunk === "string" ? chunk : decoder.write(chunk)); },
    end() { if (!ended) { ended = true; feed(decoder.end()); if (pending && !fatal) line(pending); pending = ""; } return this.snapshot(); },
    snapshot() {
      const text = texts.size ? [...texts.values()].join("\n\n") : legacyText;
      return { ...(fatal ? { error: "OpenCode reported an analysis error.", detail: fatal } : text ? { text } : { error: "OpenCode returned no valid analysis.", ...(toolErrors.length ? { detail: toolErrors.at(-1) } : {}) }), sessionID, usage: { ...usage }, usageReported: usage.steps > 0, toolCalls: tools.size, toolErrors: [...toolErrors], eventCount };
    },
  };
}
