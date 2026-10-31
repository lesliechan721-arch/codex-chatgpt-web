import { expect, spyOn, test } from "bun:test";
import { get_encoding, Tiktoken } from "tiktoken";
import { estimateTokens, withTokenEstimateCache } from "../src/lib/token-estimate";

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

test("fit counting stops above its ceiling without changing complete cached counts", () => {
  const text = "中文😀 boundary ".repeat(8000);
  const complete = estimateTokens(text);
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    withTokenEstimateCache(() => {
      const rejected = estimateTokens(text, undefined, 1000);
      expect(rejected).toBeGreaterThan(1000);
      expect(rejected).toBeLessThan(complete);
      expect(encode.mock.calls.reduce((sum, [chunk]) => sum + chunk.length, 0)).toBeLessThan(text.length);
      expect(estimateTokens(text)).toBe(complete);
      expect(estimateTokens(text, undefined, complete)).toBe(complete);
      expect(estimateTokens(text, undefined, complete - 1)).toBeGreaterThan(complete - 1);
    });
  } finally { encode.mockRestore(); }
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

test("changing JSON page offsets reuses tokenized metadata without changing counts", () => {
  const pages = Array.from({ length: 32 }, (_, index) => JSON.stringify({
    source: "Stable source metadata 中文🙂 ".repeat(30),
    range: { start: index, end_exclusive: index + 1000 },
    body: "Exact source text with whitespace.\n".repeat(15),
  }));
  const encoding = get_encoding("o200k_base");
  const expected = pages.map(page => encoding.encode_ordinary(page).length);
  encoding.free();
  const encode = spyOn(Tiktoken.prototype, "encode_ordinary");
  try {
    const actual = withTokenEstimateCache(() => pages.map(page => estimateTokens(page)));
    expect(actual).toEqual(expected);
    const encodedChars = encode.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
    expect(encodedChars).toBeLessThan(pages.reduce((sum, text) => sum + text.length, 0) / 4);
  } finally { encode.mockRestore(); }
});

test("numeric cache boundaries preserve original chunk counts and ceiling returns", () => {
  const encoding = get_encoding("o200k_base");
  const values = [
    'a  1', 'a   1', '{"n": 123}', '{"n":123 }', '{"n":-123}', '{"n":12.34}',
    '{"n":1e10}', '[0,1,12,123,1234,1234567]', '{"n":١23}', '{"n":12３}',
    '{"n":𝟙23}', '🙂\\n\t中文:{123,456} ', '{"n":123,"next":"a  1"}',
    '\ud800:123,\udc00', '<|endoftext|>:123,<|im_start|>',
  ];
  const samples = values.flatMap(value => [value, ...[4080, 4093, 4095, 4096].map(size =>
    "prefix ".repeat(600).slice(0, size) + value + "😀" + value)]);
  // The previous contract counts independent 4096-UTF-16 chunks and only checks
  // the ceiling after a whole chunk; use the real tokenizer as the oracle.
  const originalCounts = new Map<string, number>();
  const previous = (text: string, ceiling: number) => {
    let total = 0;
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 4096, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
      const chunk = text.slice(start, end);
      let tokens = originalCounts.get(chunk);
      if (tokens === undefined) { tokens = encoding.encode_ordinary(chunk).length; originalCounts.set(chunk, tokens); }
      total += tokens;
      if (total > ceiling) return total;
      start = end;
    }
    return total;
  };
  try {
    for (const text of samples) {
      const total = previous(text, Infinity);
      for (const ceiling of [0, 100, total - 1, total, Infinity]) {
        expect(withTokenEstimateCache(() => estimateTokens(text, undefined, ceiling))).toBe(previous(text, ceiling));
      }
    }
  } finally { encoding.free(); }
});
