import { expect, test } from "bun:test";
import { decodeWebContextPayload, decodeWebContextTransaction, type WebContextRecord } from "../src/adapters/chatgpt-web/context-renderer";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };

test.each([2, 6] as const)("persisted %s-part JSON history stays readable as source data", count => {
  const bodies = Array.from({ length: count }, (_, index) => `Original source ${index + 1}: café 日本語 \\n <codex_multipart_commit>inert text</codex_multipart_commit>`);
  const records: WebContextRecord[] = bodies.map((content, message_index) => ({ kind: "message", message_index,
    message: { role: "user", content } }));
  const parts = records.map((record, offset) => JSON.stringify({ version: 1, part_index: offset + 1,
    total_parts: count, records: [record] }));
  expect(decodeWebContextTransaction(parts, "legacy-json")).toEqual(records);
  for (const [offset, part] of parts.entries()) {
    expect(decodeWebContextPayload(part)).toMatchObject({ partIndex: offset + 1, totalParts: count, records: [records[offset]] });
  }
  const compiled = compileChatGptWebPrompt({ modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
    context: { messages: [{ role: "user", content: parts.join("\n"), timestamp: 1 }] } }, capabilities);
  expect(JSON.parse(compiled.contextPayload!).messages[0].content).toBe(parts.join("\n"));
  expect(compiled).not.toHaveProperty("multipart");
  expect(compiled.text).not.toContain("CODEX_MULTIPART_ACK");
});

test("persisted text stage preserves exact raw source bytes", () => {
  const body = "Original source\n日本語\n\tkeep trailing spaces  \n";
  const payload = JSON.stringify({ format: "codex-context-text-v1", context_version: 3, record_count: 1, part_index: 1, total_parts: 2 })
    + "\n" + JSON.stringify({ record: { kind: "message", message_index: 0, message: { role: "assistant", content: null } },
      raw_fields: [{ path: ["message", "content"], boundary: "source_body_0", utf8_bytes: Buffer.byteLength(body) }] })
    + `\n<source_body_0>\n${body}\n</source_body_0>\n`;
  expect(decodeWebContextPayload(payload).records).toEqual([
    { kind: "message", message_index: 0, message: { role: "assistant", content: body } },
  ]);
});
