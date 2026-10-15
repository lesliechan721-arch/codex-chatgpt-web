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

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 */
export function estimateTokens(text: string, modelId?: string): number {
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
    let tokens = chunks.get(chunk);
    if (tokens === undefined) {
      tokens = encoding.encode_ordinary(chunk).length;
      if (chunks.size >= MAX_CACHED_TOKENIZER_CHUNKS) chunks.delete(chunks.keys().next().value!);
    } else {
      chunks.delete(chunk);
    }
    chunks.set(chunk, tokens);
    count += tokens;
    start = end;
  }
  return count;
}
