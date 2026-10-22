import { expect, test } from "bun:test";
import { buildResponseJSON } from "../src/bridge";
import { extractContinuityFinalResponseText, summarizeContinuityFinalResponse } from "../scripts/unified-task-continuity-final-response";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { redactContinuityEvidence, createContinuityFixture } from "../scripts/validate-unified-task-continuity";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("production builder keeps recovery commentary separate from the exact JSON final", () => {
  const expected = JSON.stringify({ tailValue: "UC" + "f".repeat(48) });
  for (const commentary of ["A new ChatGPT conversation was created with the current context.",
    "This task continues in a new ChatGPT conversation. The previous conversation can no longer perform project operations. ChatGPT's own activities may still be running.", "Model progress."]) {
    const response = buildResponseJSON([{ type: "text_delta", text: commentary, phase: "commentary" },
      { type: "assistant_boundary" }, { type: "text_delta", text: expected, phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
    expect(extractContinuityFinalResponseText(response)).toBe(expected);
    expect(JSON.parse(extractContinuityFinalResponseText(response))).toEqual(JSON.parse(expected));
    expect(summarizeContinuityFinalResponse(response, text => text).messages).toMatchObject([
      { phase: "commentary", bodyBytes: Buffer.byteLength(commentary) }, { phase: "final_answer", syntheticFinalText: expected }]);
  }
});

test("phase selection cannot hide malformed final, unknown body, missing or multiple answers or business output", () => {
  const response = () => buildResponseJSON([{ type: "text_delta", text: "Model non-JSON final.", phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant") as Record<string, any>;
  expect(() => JSON.parse(extractContinuityFinalResponseText(response()))).toThrow();
  for (const mutate of [
    (value: Record<string, any>) => { delete value.output[0].phase; },
    (value: Record<string, any>) => { value.output[0].phase = "unknown"; },
    (value: Record<string, any>) => { value.output = []; },
    (value: Record<string, any>) => { value.output.push(structuredClone(value.output[0])); },
    (value: Record<string, any>) => { value.output.push({ type: "function_call" }); },
    (value: Record<string, any>) => { value.output.push({ type: "compaction" }); },
    (value: Record<string, any>) => { value.status = "failed"; },
    (value: Record<string, any>) => { value.end_turn = false; },
  ]) { const value = response(); mutate(value); expect(() => extractContinuityFinalResponseText(value)).toThrow(); }
});

test("plain-text resource completion compares only the real final, even when commentary contains a decoy answer", () => {
  const expected = "Synthetic resource task completed.";
  const response = buildResponseJSON([{ type: "text_delta", text: 'Progress decoy: {"tailValue":"never use commentary as the answer"}', phase: "commentary" },
    { type: "assistant_boundary" }, { type: "text_delta", text: expected, phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(extractContinuityFinalResponseText(response)).toBe(expected);
});

test("public Responses preserves commentary phases and persists the actual final before a malformed JSON verdict", async () => {
  const config = defaultConfig("full"); config.browserHost = "launcher";
  for (const answer of ['{"tailValue":"synthetic-public-value"}', "A model-written non-JSON final."]) {
    const response = await responseRequest(new Request("http://continuity-final.invalid/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/gpt-6-sol-instant", stream: false, input: [{ type: "message", role: "user", content: "Isolated synthetic final phase fixture." }] }) }), config,
      () => ({ name: "local-phase-fixture", async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: "A new ChatGPT conversation was created with the current context.", phase: "commentary" });
        emit({ type: "assistant_boundary" }); emit({ type: "text_delta", text: answer, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      } }), { rememberState: false });
    expect(response.status).toBe(200);
    const envelope = await response.json() as Record<string, unknown>;
    const saved = JSON.parse(JSON.stringify(summarizeContinuityFinalResponse(envelope, redactContinuityEvidence)));
    expect(saved.messages).toMatchObject([{ phase: "commentary", projectNotice: "new-conversation" }, { phase: "final_answer", syntheticFinalText: answer }]);
    expect(extractContinuityFinalResponseText(envelope)).toBe(answer);
    if (answer.startsWith("{")) expect(JSON.parse(extractContinuityFinalResponseText(envelope)).tailValue).toBe("synthetic-public-value");
    else expect(() => JSON.parse(extractContinuityFinalResponseText(envelope))).toThrow();
  }
});

test("synthetic final evidence redacts actual opaque credentials and excludes reasoning, prompts and commentary body", () => {
  const opaque = "9a".repeat(24), token = "turn_" + "c".repeat(32);
  const response = { status: "completed", end_turn: true, output: [
    { type: "reasoning", content: [{ type: "reasoning_text", text: "private reasoning must not be copied" }], encrypted_content: "private ciphertext" },
    { type: "message", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "progress body must not be copied" }] },
    { type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify({ tailValue: "synthetic", authorization: opaque, token }) }] },
  ], prompt: "private prompt must not be copied" };
  const saved = JSON.stringify(summarizeContinuityFinalResponse(response, text => redactContinuityEvidence(text, [opaque, token])));
  for (const value of [opaque, token, "private reasoning", "private ciphertext", "private prompt", "progress body"]) expect(saved).not.toContain(value);
  expect(saved).toContain("[redacted-capability]"); expect(saved).toContain("synthetic");
  expect(extractContinuityFinalResponseText(response)).toContain(opaque); // Evidence redaction never alters the actual comparison input.
  response.output[2]!.content![0]!.text = "x".repeat(65_537);
  const bounded = summarizeContinuityFinalResponse(response, redactContinuityEvidence);
  expect(bounded.messages.at(-1)).toMatchObject({ bodyCaptured: false, syntheticFinalText: null, bodyBytes: 65_537 });
});

test("current fixture JSON survives the actual plain DOM to Markdown to Responses pipeline unchanged", () => {
  for (const entropy of ["0".repeat(48), "f".repeat(48), "0123456789abcdef".repeat(3)]) {
    const fixture = createContinuityFixture(entropy);
    const answer = JSON.stringify({ tailValue: fixture.tailValue });
    const html = `<p>${answer}</p>`;
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe([{ key: "fixture-final", tag: "p", html, text: answer, streamable: false }], 0);
    const markdown = buffer.finish().markdown;
    expect(chatGptHtmlToMarkdown(html)).toBe(answer); expect(markdown).toBe(answer);
    const response = buildResponseJSON([{ type: "text_delta", text: "A new ChatGPT conversation was created with the current context.", phase: "commentary" },
      { type: "assistant_boundary" }, { type: "text_delta", text: markdown, phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
    const final = extractContinuityFinalResponseText(response);
    expect(final).toBe(answer); expect(JSON.parse(final).tailValue).toBe(fixture.tailValue);
    expect(summarizeContinuityFinalResponse(response, redactContinuityEvidence).messages.at(-1)?.syntheticFinalText).toBe(answer);
  }
});

test("invalid Markdown escapes remain invalid JSON instead of being repaired or searched for a substring", () => {
  const malformed = String.raw`{"tail\_value":"UC\_synthetic"}`;
  const response = buildResponseJSON([{ type: "text_delta", text: malformed, phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(extractContinuityFinalResponseText(response)).toBe(malformed);
  expect(() => JSON.parse(extractContinuityFinalResponseText(response))).toThrow();
  const extra = buildResponseJSON([{ type: "text_delta", text: 'prefix {"tailValue":"UCsynthetic"}', phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(() => JSON.parse(extractContinuityFinalResponseText(extra))).toThrow();
});

test("actual Markdown code blocks and extra prose cannot replace the complete raw JSON final contract", () => {
  const fixture = createContinuityFixture("a".repeat(48));
  const answer = JSON.stringify({ tailValue: fixture.tailValue });
  for (const html of [`<pre><code class="language-json">${answer}</code></pre>`, `<p>prefix ${answer}</p>`, `<p>${answer} suffix</p>`]) {
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe([{ key: "non-raw-final", html, text: answer, streamable: false }], 0);
    const markdown = buffer.finish().markdown;
    const response = buildResponseJSON([{ type: "text_delta", text: markdown, phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
    expect(extractContinuityFinalResponseText(response)).toBe(markdown);
    expect(() => JSON.parse(extractContinuityFinalResponseText(response))).toThrow();
  }
});

test("literal JSON backslashes remain unchanged and are not stripped as Markdown escapes", () => {
  const originalValue = String.raw`UC\literal`;
  const answer = JSON.stringify({ tailValue: originalValue });
  const response = buildResponseJSON([{ type: "text_delta", text: answer, phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(extractContinuityFinalResponseText(response)).toBe(answer);
  expect(JSON.parse(extractContinuityFinalResponseText(response)).tailValue).toBe(originalValue);
  expect(summarizeContinuityFinalResponse(response, redactContinuityEvidence).messages[0]?.syntheticFinalText).toBe(answer);

  const html = `<p>${answer}</p>`, buffer = new ChatGptMarkdownBuffer();
  buffer.observe([{ key: "literal-backslash", tag: "p", html, text: answer, streamable: false }], 0);
  const converted = buffer.finish().markdown;
  expect(converted).toBe(chatGptHtmlToMarkdown(html));
  const fromDOM = buildResponseJSON([{ type: "text_delta", text: converted, phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(extractContinuityFinalResponseText(fromDOM)).toBe(converted);
  // The Markdown contract escapes literal backslashes; the machine consumer
  // must retain those exact bytes and reject a changed value, never repair it.
  expect(JSON.parse(extractContinuityFinalResponseText(fromDOM)).tailValue).not.toBe(originalValue);
  expect(summarizeContinuityFinalResponse(fromDOM, redactContinuityEvidence).messages[0]?.syntheticFinalText).toBe(converted);
});
