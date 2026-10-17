import { expect, spyOn, test } from "bun:test";
import { get_encoding, Tiktoken } from "tiktoken";
import { estimateTokens, withTokenEstimateCache } from "../src/lib/token-estimate";

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
    expect(encode).toHaveBeenCalledTimes(1);
  } finally { encode.mockRestore(); }
});

test("repeated chunks keep exact counts across changes, partial tails and Unicode boundaries", () => {
  const a = "a".repeat(4096);
  const b = "b".repeat(4096);
  expect(estimateTokens(a + a + b + b + "hello world"))
    .toBe(2 * estimateTokens(a) + 2 * estimateTokens(b) + 2);
  const unicode = "a".repeat(4095) + "😀";
  expect(estimateTokens(unicode.repeat(2)))
    .toBe(estimateTokens("a".repeat(4095)) + estimateTokens("😀" + "a".repeat(4094)) + estimateTokens("a😀"));
  expect(estimateTokens("hello world")).toBe(2);
  expect(estimateTokens("")).toBe(0);
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});

test("nested preparations reuse counts and release source chunks when they return", () => {
  const text = "shared preparation token count";
  const expected = estimateTokens(text);
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    withTokenEstimateCache(() => {
      expect(estimateTokens(text)).toBe(expected);
      withTokenEstimateCache(() => expect(estimateTokens(text)).toBe(expected));
      expect(estimateTokens(text)).toBe(expected);
    });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(estimateTokens(text)).toBe(expected);
    expect(encode).toHaveBeenCalledTimes(2);
  } finally { encode.mockRestore(); }
});

test("failed preparations release their cache without clearing an enclosing preparation", () => {
  const text = "failed preparation token count";
  const failure = new Error("preparation failed");
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    expect(() => withTokenEstimateCache(() => {
      estimateTokens(text);
      throw failure;
    })).toThrow(failure);
    estimateTokens(text);
    expect(encode).toHaveBeenCalledTimes(2);
    withTokenEstimateCache(() => {
      estimateTokens(text);
      expect(() => withTokenEstimateCache(() => {
        estimateTokens(text);
        throw failure;
      })).toThrow(failure);
      estimateTokens(text);
    });
    expect(encode).toHaveBeenCalledTimes(3);
    estimateTokens(text);
    expect(encode).toHaveBeenCalledTimes(4);
  } finally { encode.mockRestore(); }
});

test("chunk reuse preserves surrogate boundaries and distinguishes exact source text", () => {
  const prefix = "a".repeat(4_095);
  const encoding = get_encoding("o200k_base");
  const expected = ["😀", "😃"].map(suffix => encoding.encode_ordinary(prefix).length + encoding.encode_ordinary(suffix).length);
  encoding.free();
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    withTokenEstimateCache(() => {
      expect(estimateTokens(prefix + "😀")).toBe(expected[0]!);
      expect(estimateTokens(prefix + "😃")).toBe(expected[1]!);
      expect(estimateTokens(prefix + "😀")).toBe(expected[0]!);
    });
    expect(encode).toHaveBeenCalledTimes(3);
    expect(encode.mock.calls.map(([chunk]) => chunk)).toEqual([prefix, "😀", "😃"]);
  } finally { encode.mockRestore(); }
});

test("a preparation evicts old counts when it sees many distinct chunks", () => {
  const text = "first cache entry";
  const expected = estimateTokens(text);
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    withTokenEstimateCache(() => {
      expect(estimateTokens(text)).toBe(expected);
      for (let index = 0; index < 1_024; index++) estimateTokens(`distinct cache entry ${index}`);
      expect(estimateTokens(text)).toBe(expected);
    });
    expect(encode.mock.calls.filter(([chunk]) => chunk === text)).toHaveLength(2);
  } finally { encode.mockRestore(); }
});
