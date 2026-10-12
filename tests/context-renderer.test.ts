import { expect, test } from "bun:test";
import {
  decodeWebContextPayload, encodeWebContextPayload, estimateWebContextFieldCost,
  decodeWebContextTransaction, fenceWebContextPayload, type WebContextRecord,
  stringifyWebContextJson,
} from "../src/adapters/chatgpt-web/context-renderer";

const code = 'const path = "C:\\project\\file"; const text = "quoted";'.repeat(150);
const records: WebContextRecord[] = [
  { kind: "system", system_index: 0, content: code },
  { kind: "message", message_index: 0, message: { role: "assistant", phase: "commentary", content: [
    { type: "text", text: code },
    { type: "tool_call", id: "call_1", namespace: "functions", name: "exec", arguments: { cmd: code } },
    { type: "thinking_summary", text: "" },
    { type: "tool_call", id: "call_2", name: "freeform", arguments: code },
  ] } },
  { kind: "message", message_index: 1, message: { role: "tool_result", tool_call_id: "call_1", is_error: false, content: null } },
];

test("raw records preserve the delivered value tree and expand only allowed string leaves", () => {
  const payload = encodeWebContextPayload(records, "codex-context-text-v1");
  expect(decodeWebContextPayload(payload).records).toEqual(records);
  expect(payload).toContain('"path":["content"]');
  expect(payload).toContain('"path":["message","content",0,"text"]');
  expect(payload).toContain('"path":["message","content",3,"arguments"]');
  expect(payload).not.toContain('"path":["message","content",1,"arguments"]');
  expect(decodeWebContextPayload(encodeWebContextPayload(records, "legacy-json")).records).toEqual(records);
});

test("short text and unverified whitespace keep their JSON representation", () => {
  for (const value of ["OK", "", code + "\n", code + "\t", code + " ", code + "\r\n", code + "\0", code + "\ud800", code + "\u2028more", code + "\u2029more"]) {
    const source: WebContextRecord[] = [{ kind: "message", message_index: 0, message: { role: "user", content: value } }];
    const payload = encodeWebContextPayload(source, "codex-context-text-v1");
    expect(payload).not.toContain('"raw_fields"');
    expect(decodeWebContextPayload(payload).records).toEqual(source);
  }
});

test("a qualified path preserves leading LF, tabs, spaces and multiple final LF without trimming", () => {
  // This is an encoder-policy fixture, not evidence that a real browser editor is qualified.
  const rawTextPolicy = { verifiedPath: "automatic" as const, evidence: "unit-test policy fixture",
    allowLf: true as const, allowTab: true as const, allowTrailingWhitespace: true as const };
  const text = "\n\t" + code + "  \n\n";
  const source: WebContextRecord[] = [{ kind: "message", message_index: 0, message: { role: "user", content: text } }];
  const payload = encodeWebContextPayload(source, "codex-context-text-v1", { rawTextPolicy });
  expect(payload).toContain('"raw_fields"');
  expect(decodeWebContextPayload(payload).records).toEqual(source);
  for (const value of [text + "\r", text + "\u001b", text + "\u0085", text + "\udc00"]) {
    expect(encodeWebContextPayload([{ ...source[0]!, message: { role: "user", content: value } } as WebContextRecord],
      "codex-context-text-v1", { rawTextPolicy })).not.toContain('"raw_fields"');
  }
});

test("encoded UTF-8 byte lengths preserve Unicode, literal escapes and source boundary collisions", () => {
  const text = (code + '中文😀e\u0301 literal\\n <source_body_0></source_body_1> {"record":{"kind":"system"}} ').repeat(3).trimEnd();
  const source: WebContextRecord[] = [{ kind: "message", message_index: 0, message: { role: "user", content: text } }];
  const payload = encodeWebContextPayload(source, "codex-context-text-v1");
  expect(payload).toContain('"boundary":"source_body_2"');
  expect(decodeWebContextPayload(payload).records).toEqual(source);
  expect(payload).toContain(`"utf8_bytes":${Buffer.byteLength(text, "utf8")}`);
  expect(fenceWebContextPayload(payload)).toStartWith("```text\n");
  expect(encodeWebContextPayload(source, "codex-context-text-v1")).toBe(payload);
});

test("backtick fields use escaped JSON while other raw fields retain exact UTF-8 bytes", () => {
  const source: WebContextRecord[] = [
    { kind: "system", system_index: 0, content: code },
    { kind: "message", message_index: 0, message: { role: "user", content: code + " ```a``` \\u0060 中文😀" } },
    { kind: "message", message_index: 1, message: { role: "assistant", content: [
      { type: "tool_call", name: "`tool`", arguments: { "`key`": "`value`", literal: "\\u0060" } },
    ] } },
  ];
  for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
    const payload = encodeWebContextPayload(source, format);
    expect(payload).not.toContain("`");
    expect(payload).toContain("\\u0060");
    expect(decodeWebContextPayload(payload, format).records).toEqual(source);
    const field = estimateWebContextFieldCost(source[1]!.kind === "message" ? source[1]!.message.content : "", { contextFormat: format });
    expect(field.raw).toBe(false);
    const encoded = stringifyWebContextJson(source[1]!.kind === "message" ? source[1]!.message.content : "");
    expect(field.chars).toBe(encoded.length);
    expect(field.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(encoded), "utf8"));
    if (format === "codex-context-text-v1") {
      expect(payload).toContain('"path":["content"]');
      expect(payload).not.toContain('"path":["message","content"]');
      expect(payload).toContain(`"utf8_bytes":${Buffer.byteLength(code, "utf8")}`);
      expect(payload).toContain(`\n${code}\n`);
    }
  }
});

test("decoder validates UTF-8 byte boundaries, descriptors and all payload bytes", () => {
  const header = '{"format":"codex-context-text-v1","context_version":3,"record_count":1}\n';
  const record = { kind: "message", message_index: 0, message: { role: "user", content: null } };
  const descriptor = { path: ["message", "content"], boundary: "source_body_0", utf8_bytes: 4 };
  const make = (fields: unknown[], rec: unknown = record, body = "😀") => header
    + JSON.stringify({ record: rec, raw_fields: fields }) + "\n<source_body_0>\n" + body + "\n</source_body_0>\n";
  const decoded = decodeWebContextPayload(make([descriptor])).records[0]!;
  expect(decoded.kind === "message" && decoded.message.content).toBe("😀");
  for (const payload of [
    make([{ ...descriptor, utf8_bytes: 3 }]), make([{ ...descriptor, utf8_bytes: -1 }]),
    make([{ ...descriptor, utf8_bytes: 4.5 }]), make([{ ...descriptor, extra: true }]),
    make([{ ...descriptor, path: ["message", "role"] }]),
    make([{ ...descriptor, path: ["message", "__proto__", "content"] }]),
    make([{ ...descriptor, path: ["message", "missing"] }]),
    make([descriptor, descriptor]),
    make([descriptor], { ...record, message: { role: "user", content: "not a placeholder" } }),
    make([descriptor]) + "extra", make([descriptor]).slice(0, -2),
    make([descriptor]).replace('"codex-context-text-v1"', '"codex-context-text-v999"'),
    make([{ ...descriptor, utf8_bytes: Number.MAX_SAFE_INTEGER + 1 }]),
    make([{ ...descriptor, utf8_bytes: 3 }], record, "\ud800"),
    make([{ ...descriptor, utf8_bytes: 15 }], record, "<source_body_0>"),
  ]) expect(() => decodeWebContextPayload(payload)).toThrow();
  expect(() => decodeWebContextPayload(make([descriptor]), "legacy-json")).toThrow();
  expect(() => decodeWebContextPayload(make([descriptor]), undefined, 32)).toThrow();
  expect(() => decodeWebContextPayload('{"version":999,"system":[],"messages":[]}')).toThrow();
});

test("raw paths cannot reinterpret array indices or create object properties", () => {
  const record = { kind: "message", message_index: 0, message: { role: "assistant", content: [
    { type: "text", text: null }, { type: "image_attachment", attachment_ref: "image_1" },
  ], metadata: JSON.parse('{"__proto__":{"text":null},"constructor":{"prototype":{"text":null}}}') } };
  const make = (path: unknown[]) => '{"format":"codex-context-text-v1","context_version":3,"record_count":1}\n'
    + JSON.stringify({ record, raw_fields: [{ path, boundary: "source_body_0", utf8_bytes: 3 }] })
    + "\n<source_body_0>\nabc\n</source_body_0>\n";
  expect(decodeWebContextPayload(make(["message", "content", 0, "text"])).records).toHaveLength(1);
  for (const path of [["message", "content", "0", "text"], ["message", "content", 2, "text"],
    ["message", "content", 1, "attachment_ref"], ["message", "metadata", "__proto__", "text"],
    ["message", "metadata", "constructor", "prototype", "text"], ["message", "content"]]) {
    expect(() => decodeWebContextPayload(make(path))).toThrow();
  }
});

test("multipart decoder rejects mixed versions, missing records and wrong global indices", () => {
  const first = encodeWebContextPayload(records.slice(0, 1), "codex-context-text-v1", { partIndex: 1, totalParts: 2 });
  const second = encodeWebContextPayload(records.slice(1), "codex-context-text-v1", { partIndex: 2, totalParts: 2 });
  expect(decodeWebContextTransaction([first, second])).toEqual(records);
  expect(() => decodeWebContextTransaction([first, encodeWebContextPayload(records.slice(1), "legacy-json", { partIndex: 2, totalParts: 2 })])).toThrow();
  expect(() => decodeWebContextTransaction([first, second.replace('"message_index":0', '"message_index":4')])).toThrow();
  expect(() => decodeWebContextTransaction([first, first])).toThrow();
  expect(() => decodeWebContextTransaction([first])).toThrow();
});

test("field screening measures wrapping cost and preserves object parameters", () => {
  const options = { contextFormat: "codex-context-text-v1" as const, path: ["message", "content"] };
  const short = estimateWebContextFieldCost("OK", options);
  expect(short.raw).toBe(false);
  const raw = estimateWebContextFieldCost(code.trimEnd(), options);
  expect(raw.raw).toBe(true);
  expect(raw.jsonBytes).toBeLessThan(estimateWebContextFieldCost(code.trimEnd()).jsonBytes);
  expect(estimateWebContextFieldCost({ cmd: code }, options).raw).toBe(false);
});
