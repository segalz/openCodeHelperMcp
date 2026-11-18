import assert from "node:assert/strict";
import test from "node:test";
import { createEventStream } from "../src/events.js";

// Plan S2 (review item A5): the final answer must survive a later message that carries no text.
const line = event => JSON.stringify(event) + "\n";
const text = (messageID, id, value) => line({ type: "text", sessionID: "ses_1", part: { type: "text", messageID, id, text: value } });
const tool = (messageID, id) => line({ type: "tool_use", sessionID: "ses_1", part: { type: "tool", messageID, id, callID: id, tool: "read", state: { status: "completed" } } });
const step = (messageID, id, reason = "stop") => line({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", messageID, id, reason, tokens: { input: 1, output: 1 } } });

test("S2: a later message with only a tool call and a step keeps the earlier answer", () => {
  const stream = createEventStream();
  stream.write(text("msg_1", "prt_1", "Final answer from message one"));
  stream.write(step("msg_1", "stp_1", "tool-calls"));
  stream.write(tool("msg_2", "call_1"));
  stream.write(step("msg_2", "stp_2"));
  assert.equal(stream.end().text, "Final answer from message one");
});

test("S2: a later message that does bring text still replaces the earlier text", () => {
  const stream = createEventStream();
  stream.write(text("msg_1", "prt_1", "Planning notes"));
  stream.write(tool("msg_2", "call_1"));
  stream.write(text("msg_2", "prt_2", "The real final answer"));
  stream.write(step("msg_2", "stp_1"));
  assert.equal(stream.end().text, "The real final answer");
});

test("S2: a message with only a step and no text keeps the earlier answer", () => {
  const stream = createEventStream();
  stream.write(text("msg_1", "prt_1", "Answer"));
  stream.write(step("msg_2", "stp_1"));
  assert.equal(stream.end().text, "Answer");
});

// Review of S2 (Sonnet): text from an earlier message followed by tool-only messages is narration, not a final answer.
test("S2 review: text followed by a tool call in a later message is not final", () => {
  const stream = createEventStream();
  stream.write(text("msg_1", "prt_1", "Let me look at the config first"));
  stream.write(tool("msg_2", "call_1"));
  stream.write(step("msg_2", "stp_1", "tool-calls"));
  const out = stream.end();
  assert.equal(out.text, "Let me look at the config first");
  assert.equal(out.textIsFinal, false);
});

test("S2 review: text followed only by a step-only message is final", () => {
  const stream = createEventStream();
  stream.write(text("msg_1", "prt_1", "The answer"));
  stream.write(step("msg_1", "stp_1", "tool-calls"));
  stream.write(step("msg_2", "stp_2"));
  assert.equal(stream.end().textIsFinal, true);
});

test("S2 review: a tool call inside the same message as the text keeps it final", () => {
  const stream = createEventStream();
  stream.write(tool("msg_1", "call_1"));
  stream.write(text("msg_1", "prt_1", "Done after reading"));
  stream.write(step("msg_1", "stp_1"));
  assert.equal(stream.end().textIsFinal, true);
});
