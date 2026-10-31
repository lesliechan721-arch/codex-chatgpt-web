import { get_encoding, type Tiktoken } from "tiktoken";

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON/base64 can contain far more tokens than prose
 * of the same length. Count with the tokenizer used by the GPT-5 generation instead.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;
// At most 4 MiB of UTF-16 chunk contents, released when a synchronous preparation returns.
const MAX_CACHED_TOKENIZER_CHUNKS = 512;
// o200k_base tokenizes numbers separately. Require adjacent non-whitespace JSON
// punctuation: splitting arbitrary numbers can change its trailing-space matches.
const JSON_INTEGER = /(?<=[,:])[0-9]+(?=[,}\]])/g;
let tokenizer: Tiktoken | undefined;
let preparationChunks: Map<string, number> | undefined;

/** Share exact chunk counts across a synchronous preparation, including nested compilations. */
export function withTokenEstimateCache<T>(prepare: () => T): T {
  if (preparationChunks) return prepare();
  preparationChunks = new Map();
  try { return prepare(); }
  finally { preparationChunks = undefined; }
}

function chatGptTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

function cachedTokens(text: string, encoding: Tiktoken, chunks: Map<string, number>): number {
  if (!text) return 0;
  let tokens = chunks.get(text);
  if (tokens === undefined) {
    tokens = encoding.encode_ordinary(text).length;
    if (chunks.size >= MAX_CACHED_TOKENIZER_CHUNKS) chunks.delete(chunks.keys().next().value!);
  } else chunks.delete(text);
  chunks.set(text, tokens);
  return tokens;
}

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 * Fit checks may stop once the count exceeds tokenCeiling. Omit it for full accounting.
 */
export function estimateTokens(text: string, modelId?: string, tokenCeiling = Infinity): number {
  void modelId;
  if (!text) return 0;

  const encoding = chatGptTokenizer();
  const chunks = preparationChunks ?? new Map<string, number>();
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        end -= 1;
      }
    }
    const chunk = text.slice(start, end);
    // Page offsets vary during packing. Reuse the stable text around those
    // integers without changing the original chunk's token sequence or count.
    let offset = 0;
    for (const match of chunk.matchAll(JSON_INTEGER)) {
      count += cachedTokens(chunk.slice(offset, match.index), encoding, chunks)
        + cachedTokens(match[0], encoding, chunks);
      offset = match.index + match[0].length;
    }
    count += cachedTokens(chunk.slice(offset), encoding, chunks);
    // Keep the existing ceiling behavior: finish the whole original chunk first.
    if (count > tokenCeiling) return count;
    start = end;
  }
  return count;
}
