import { createHash, randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { parseRequest } from "../../responses/parser";
import { contextSourceParserModel } from "./context-source-parser";
import type { CodexMessage, CodexParsedRequest, CodexToolCall } from "../../types";
import { CONTEXT_LIMITS } from "./context-budget";
import { hasNativeChatGptInstruction } from "./environment";
import { assertDecodableContextJpeg, assertDecodableContextWebp } from "./context-image-codec";
import type { ContextLocator, ContextSource, ContextSourceEvidence, ContextTarget, FixedContextImage } from "./context-types";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const sourceKinds = ["system", "user", "developer", "skill", "summary", "assistant", "tool", "agent_message", "delegation"];
const targetKinds = ["message_text", "tool_arguments", "tool_result", "image"];
const completeness = ["complete", "truncated", "unknown"];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

// Local validation ceilings bound compressed-image expansion and parser work. They are
// resource ceilings, not model limits. No validation changes the original encoded bytes.
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_IMAGE_RASTER_BYTES = 64 * 1024 * 1024;
const MAX_WEBP_FRAMES = 256;
const invalidImage = (): never => { throw new Error("Invalid or unsupported fixed context image"); };
function dimensions(width: number, height: number): void {
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) invalidImage();
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes: Buffer): void {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalidImage();
  let offset = 8, width = 0, height = 0, bitDepth = 0, color = 0, interlace = 0;
  let header = false, palette = false, dataEnded = false, end = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalidImage();
    const length = bytes.readUInt32BE(offset), next = offset + length + 12;
    if (next > bytes.length) invalidImage();
    const name = bytes.subarray(offset + 4, offset + 8).toString("ascii"), data = bytes.subarray(offset + 8, next - 4);
    if (!/^[A-Za-z]{4}$/.test(name) || crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) invalidImage();
    if (!header && name !== "IHDR") invalidImage();
    if (name === "IHDR") {
      if (header || length !== 13) invalidImage();
      header = true; width = data.readUInt32BE(0); height = data.readUInt32BE(4); dimensions(width, height);
      bitDepth = data[8]!; color = data[9]!; interlace = data[12]!;
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) invalidImage();
    } else if (name === "PLTE") {
      if (palette || compressed.length || !length || length % 3 || length > 768 || color === 0 || color === 4 || color === 3 && length / 3 > 2 ** bitDepth) invalidImage();
      palette = true;
    } else if (name === "IDAT") {
      if (dataEnded || color === 3 && !palette) invalidImage();
      compressed.push(data);
    } else if (name === "IEND") {
      if (length || !compressed.length || next !== bytes.length) invalidImage();
      end = true;
    } else {
      if (compressed.length) dataEnded = true;
      if (name[0] === name[0]!.toUpperCase()) invalidImage(); // Unknown critical format.
    }
    offset = next;
  }
  if (!end) invalidImage();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.flatMap(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!)), count = Math.max(0, Math.ceil((height - y!) / dy!));
    return columns && count ? [{ count, stride: 1 + Math.ceil(columns * channels[color]! * bitDepth / 8) }] : [];
  });
  const expected = rows.reduce((sum, row) => sum + row.count * row.stride, 0);
  if (!expected || expected > MAX_IMAGE_RASTER_BYTES) invalidImage();
  // Node's inflater checks zlib termination/checksum and caps output before allocation
  // can exceed the admitted raster. The extra byte detects excess decompressed data.
  const raster = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
  if (raster.length !== expected) invalidImage();
  let rowOffset = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++, rowOffset += row.stride) if (raster[rowOffset]! > 4) invalidImage();
}
function validateJpeg(bytes: Buffer): void {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  let offset = 2, frame = false, quantization = false, huffman = false, scan = false, progressive = false;
  const quantizationTables = new Set<number>(), dcTables = new Set<number>(), acTables = new Set<number>(), initializedComponents = new Set<number>();
  const acSymbols = new Map<number, readonly number[]>();
  const components = new Map<number, number>();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (!frame || !quantization || !huffman || !scan || initializedComponents.size !== components.size || offset !== bytes.length) invalidImage(); assertDecodableContextJpeg(bytes); return; }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) invalidImage();
    if (offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset), next = offset + length;
    if (length < 2 || next > bytes.length) invalidImage();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 11 || bytes[offset + 2] !== 8) invalidImage();
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      const count = bytes[offset + 7]!;
      if (![1, 3, 4].includes(count) || length !== 8 + count * 3) invalidImage(); frame = true; progressive = marker === 0xc2;
      let blocks = 0;
      for (let index = 0; index < count; index++) {
        const at = offset + 8 + index * 3, id = bytes[at]!, sampling = bytes[at + 1]!, table = bytes[at + 2]!;
        const horizontal = sampling >>> 4, vertical = sampling & 15;
        if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || table > 3) invalidImage();
        blocks += horizontal * vertical; components.set(id, table);
      }
      if (blocks > 10) invalidImage();
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalidImage();
    if (marker === 0xdb) {
      let at = offset + 2;
      while (at < next) {
        const type = bytes[at++]!, precision = type >>> 4, table = type & 15;
        if (precision > 1 || table > 3 || at + 64 * (precision + 1) > next) invalidImage();
        for (let index = 0; index < 64; index++, at += precision + 1) if (!(precision ? bytes.readUInt16BE(at) : bytes[at])) invalidImage();
        quantizationTables.add(table);
      }
      if (!quantizationTables.size) invalidImage(); quantization = true;
    }
    if (marker === 0xc4) {
      let at = offset + 2;
      while (at < next) {
        const type = bytes[at++]!, kind = type >>> 4, table = type & 15;
        if (kind > 1 || table > 3 || at + 16 > next) invalidImage();
        let symbols = 0, available = 1;
        for (let bits = 0; bits < 16; bits++) { const count = bytes[at++]!; symbols += count; available = available * 2 - count; if (available <= 0) invalidImage(); }
        if (!symbols || symbols > 256 || at + symbols > next) invalidImage();
        const values: number[] = [];
        for (let index = 0; index < symbols; index++) {
          const value = bytes[at++]!;
          if (!kind && value > 11 || kind && (value & 15) > 10) invalidImage();
          values.push(value);
        }
        if (kind) acSymbols.set(table, values);
        (kind ? acTables : dcTables).add(table);
      }
      if (!dcTables.size && !acTables.size) invalidImage(); huffman = true;
    }
    offset = next;
    if (marker === 0xda) {
      if (!frame || !quantization || !huffman || length < 8) invalidImage();
      const count = bytes[next - length + 2]!, scanStart = bytes[next - 3]!, scanEnd = bytes[next - 2]!, approximation = bytes[next - 1]!;
      if (!count || count > components.size || length !== 6 + count * 2 || scanStart > scanEnd || scanEnd > 63
        || !progressive && (scanStart !== 0 || scanEnd !== 63 || approximation !== 0)
        || progressive && (scanStart === 0 && scanEnd !== 0 || scanStart > 0 && count !== 1 || approximation >>> 4 > 13 || (approximation & 15) > 13)) invalidImage();
      const seen = new Set<number>();
      for (let index = 0; index < count; index++) {
        const at = next - length + 3 + index * 2, id = bytes[at]!, tables = bytes[at + 1]!, quantizationTable = components.get(id);
        if (seen.has(id) || quantizationTable === undefined || !quantizationTables.has(quantizationTable)
          || tables >>> 4 > 3 || (tables & 15) > 3 || (!progressive || scanStart === 0 && approximation >>> 4 === 0) && !dcTables.has(tables >>> 4)
          || (!progressive || scanStart > 0) && !acTables.has(tables & 15)) invalidImage();
        // Zero-size AC symbols 0x10..0xe0 are progressive EOBRUN codes. Table
        // definitions may precede SOF, so validate the referenced table at its scan.
        if (!progressive && acSymbols.get(tables & 15)!.some(value => (value & 15) === 0 && value !== 0 && value !== 0xf0)
          || progressive && scanStart > 0 && approximation >>> 4 > 0 && acSymbols.get(tables & 15)!.some(value => (value & 15) > 1)) invalidImage();
        seen.add(id);
        if (!progressive || scanStart === 0 && approximation >>> 4 === 0) {
          if (initializedComponents.has(id)) invalidImage(); initializedComponents.add(id);
        } else if (!initializedComponents.has(id)) invalidImage();
      }
      scan = true;
      let entropy = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropy++; continue; }
        let after = offset + 1; while (bytes[after] === 0xff) after++;
        if (after >= bytes.length) invalidImage();
        if (bytes[after] === 0 || bytes[after]! >= 0xd0 && bytes[after]! <= 0xd7) { offset = after + 1; entropy++; continue; }
        break;
      }
      if (!entropy) invalidImage();
    }
  }
  invalidImage();
}
function validateGif(bytes: Buffer): void {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) invalidImage();
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8); dimensions(width, height);
  let offset = 13, frames = 0, totalPixels = 0;
  if (bytes[10]! & 0x80) offset += 3 * (2 ** ((bytes[10]! & 7) + 1));
  const blocks = (): Buffer => {
    const values: Buffer[] = [];
    for (;;) { if (offset >= bytes.length) invalidImage(); const count = bytes[offset++]!; if (!count) break;
      if (offset + count > bytes.length) invalidImage(); values.push(bytes.subarray(offset, offset + count)); offset += count; }
    return Buffer.concat(values);
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) { if (!frames || offset !== bytes.length) invalidImage(); return; }
    if (marker === 0x21) { if (offset >= bytes.length) invalidImage(); offset++; blocks(); continue; }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalidImage();
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2), w = bytes.readUInt16LE(offset + 4), h = bytes.readUInt16LE(offset + 6), flags = bytes[offset + 8]!;
    dimensions(w, h); if (left + w > width || top + h > height || (totalPixels += w * h) > MAX_IMAGE_PIXELS) invalidImage();
    offset += 9; if (flags & 0x80) offset += 3 * (2 ** ((flags & 7) + 1));
    if (offset >= bytes.length) invalidImage();
    const minimum = bytes[offset++]!; if (minimum < 2 || minimum > 8) invalidImage();
    const compressed = blocks(), clear = 1 << minimum, end = clear + 1;
    let bit = 0, size = minimum + 1, next = end + 1, previous = -1, count = 0, cleared = false, ended = false;
    const lengths = new Uint32Array(4096); lengths.fill(1, 0, clear);
    while (bit + size <= compressed.length * 8) {
      let code = 0; for (let i = 0; i < size; i++, bit++) code |= ((compressed[bit >>> 3]! >>> (bit & 7)) & 1) << i;
      if (code === clear) { size = minimum + 1; next = end + 1; previous = -1; cleared = true; continue; }
      if (!cleared) invalidImage();
      if (code === end) { ended = true; break; }
      if (code > next || code === next && previous < 0 || code >= 4096) invalidImage();
      const length = code === next ? lengths[previous]! + 1 : lengths[code]!;
      if (!length || (count += length) > w * h) invalidImage();
      if (previous >= 0 && next < 4096) { lengths[next++] = lengths[previous]! + 1; if (next === 1 << size && size < 12) size++; }
      previous = code;
    }
    if (!ended || count !== w * h) invalidImage(); frames++;
  }
  invalidImage();
}
function validateWebp(bytes: Buffer): void {
  if (bytes.length < 26 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) invalidImage();
  interface FrameSize { width: number; height: number }
  let frames = 0, decodedPixels = 0, canvas: FrameSize | undefined, canvasFlags = 0, animated = false, animationControl = false, topImage = false, topAlpha = false, imageAlpha = false;
  const accountFrame = (size: FrameSize): void => {
    dimensions(size.width, size.height); decodedPixels += size.width * size.height;
    if (decodedPixels > MAX_IMAGE_PIXELS || ++frames > MAX_WEBP_FRAMES) invalidImage();
  };
  const chunks = (start: number, end: number, expectedFrame?: FrameSize): FrameSize | undefined => {
    let image: FrameSize | undefined, alpha = false;
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) invalidImage();
      const name = bytes.subarray(offset, offset + 4).toString("ascii"), length = bytes.readUInt32LE(offset + 4), data = offset + 8, next = data + length + (length & 1);
      if (next > end || length & 1 && bytes[next - 1] !== 0) invalidImage();
      if (name === "VP8 " || name === "VP8L") {
        if (image || !expectedFrame && (animated || topImage)) invalidImage();
        if (name === "VP8 ") {
          if (length < 11 || bytes[data]! & 1 || !bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalidImage();
          image = { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
          const partition = bytes.readUIntLE(data, 3) >>> 5; if (!partition || partition + 10 > length) invalidImage();
        } else {
          if (alpha || length < 6 || bytes[data] !== 0x2f) invalidImage(); const packed = bytes.readUInt32LE(data + 1);
          if (packed >>> 29) invalidImage(); image = { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
          imageAlpha ||= (packed & 0x10000000) !== 0;
        }
        accountFrame(image);
        const expected = expectedFrame ?? canvas;
        if (expected && (image.width !== expected.width || image.height !== expected.height)) invalidImage();
        if (!expectedFrame) topImage = true;
      } else if (name === "ALPH") {
        if (alpha || image || !length || !expectedFrame && (!canvas || animated || topAlpha)) invalidImage();
        if (bytes[data]! & 0xc0 || (bytes[data]! & 3) > 1 || (bytes[data]! >>> 4 & 3) > 1) invalidImage();
        alpha = true; if (!expectedFrame) topAlpha = true;
        imageAlpha = true;
      } else if (name === "VP8X") {
        if (expectedFrame || canvas || offset !== 12 || length !== 10 || bytes[data]! & 0xc1 || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) invalidImage();
        canvas = { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
        dimensions(canvas.width, canvas.height); canvasFlags = bytes[data]!; animated = (canvasFlags & 2) !== 0;
      } else if (name === "ANIM") {
        if (expectedFrame || !animated || !canvas || animationControl || frames || length !== 6) invalidImage(); animationControl = true;
      } else if (name === "ANMF") {
        if (expectedFrame || !animated || !animationControl || !canvas || length < 24) invalidImage();
        const frameCanvas = canvas!; // Fixed before descending into frame chunks.
        const left = bytes.readUIntLE(data, 3) * 2, top = bytes.readUIntLE(data + 3, 3) * 2;
        const rectangle = { width: bytes.readUIntLE(data + 6, 3) + 1, height: bytes.readUIntLE(data + 9, 3) + 1 };
        dimensions(rectangle.width, rectangle.height);
        if (bytes[data + 15]! & 0xfc || left + rectangle.width > frameCanvas.width || top + rectangle.height > frameCanvas.height) invalidImage();
        const inner = chunks(data + 16, data + length, rectangle);
        if (!inner) invalidImage();
      } else if (expectedFrame && ["ICCP", "EXIF", "XMP "].includes(name)) invalidImage();
      offset = next;
    }
    if (alpha && !image) invalidImage();
    if (expectedFrame) {
      if (!image) invalidImage();
      // An animation frame is decoded as a standalone extended image, preserving
      // its ALPH chunk and verifying actual decoded dimensions against ANMF.
      const extended = Buffer.alloc(18); extended.write("VP8X"); extended.writeUInt32LE(10, 4); extended[8] = alpha ? 0x10 : 0;
      extended.writeUIntLE(expectedFrame.width - 1, 12, 3); extended.writeUIntLE(expectedFrame.height - 1, 15, 3);
      const header = Buffer.alloc(12); header.write("RIFF"); header.writeUInt32LE(end - start + extended.length + 4, 4); header.write("WEBP", 8);
      assertDecodableContextWebp(Buffer.concat([header, extended, bytes.subarray(start, end)]), expectedFrame);
    }
    return image;
  };
  chunks(12, bytes.length);
  if (!frames || animated && (!animationControl || topImage)) invalidImage();
  if (canvas && imageAlpha !== ((canvasFlags & 0x10) !== 0)) invalidImage();
  if (!animated) { if (frames !== 1 || !topImage) invalidImage(); assertDecodableContextWebp(bytes, canvas); }
}

/** Shared by fixation/restore and attachment fallback. All four formats undergo
 * bounded pixel-stream decoding plus structural checks; original bytes stay unchanged. */
export function assertSupportedContextImage(bytes: Uint8Array, mimeType: string): void {
  try {
    // Attachment consumers also use this validator above the smaller MCP-image ceiling.
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CONTEXT_LIMITS.maxStorageBytes || !IMAGE_MIMES.has(mimeType)) invalidImage();
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (mimeType === "image/png") validatePng(buffer);
    else if (mimeType === "image/jpeg") validateJpeg(buffer);
    else if (mimeType === "image/gif") validateGif(buffer);
    else validateWebp(buffer);
  } catch { invalidImage(); }
}

/** Sorted object keys; array order and strings remain unchanged. No string is parsed/re-encoded. */
export function deterministicContextJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (record(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])]));
    return v;
  };
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new Error("Context source has no JSON representation");
  return result;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

interface TextPayload { target_id: string; type: "text"; text: string }
interface ImagePayload { target_id: string; type: "image"; mime_type: string; data: string; visual_token_reserve: number }
/** Private owner IPC only. Contains actual task source data; never return this from MCP. */
export interface ContextSnapshotWire {
  version: 1;
  context_id: string;
  sources: readonly ContextSource[];
  targets: readonly ContextTarget[];
  payloads: readonly (TextPayload | ImagePayload)[];
}

export interface ContextSnapshotOptions {
  fixedImages?: readonly FixedContextImage[];
  provenanceByMessage?: ReadonlyMap<number, ContextSourceEvidence>;
  maxStorageBytes?: number;
  /** Normal sends can bound optional history before selecting full/resume. Complete
   * compaction sources retain strict storage admission (the default). */
  imageStoragePolicy?: "complete" | "bounded";
  priorityImageLocators?: readonly FixedContextImage["locator"][];
}

/** Caller supplies producer-proven candidate indices in canonical coordinates.
 * Priority affects storage only; it neither selects a plan nor grants required status.
 * Newest candidate instruction images precede older instruction/history images. */
export function contextSnapshotPriorityImageLocators(parsed: CodexParsedRequest, selected: {
  messageIndices?: readonly number[]; rawInputIndices?: readonly number[];
} = {}): readonly FixedContextImage["locator"][] {
  const result: FixedContextImage["locator"][] = [];
  const messages = selected.messageIndices ?? parsed.context.messages.map((_, index) => index);
  if (messages.some(index => !Number.isSafeInteger(index) || index < 0 || index >= parsed.context.messages.length)) throw new Error("Invalid context priority message mapping");
  for (const index of [...messages].sort((a, b) => b - a)) if (["user", "developer", "agentMessage"].includes(parsed.context.messages[index]!.role)) result.push({ message_index: index });
  const inputs = record(parsed._rawBody) && Array.isArray(parsed._rawBody.input) ? parsed._rawBody.input : [];
  const rawIndices = selected.rawInputIndices ?? inputs.map((_, index) => index);
  if (rawIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= inputs.length)) throw new Error("Invalid context priority raw mapping");
  const strictDelegations = new Set(rawIndices.filter(index => {
    const item = inputs[index];
    return record(item) && ["function_call_output", "agent_message"].includes(String(item.type)) && hasNativeChatGptInstruction(parsed, [item]);
  }));
  const selectedMessages = new Set(messages.map(index => parsed.context.messages[index]!)), verifiedRawMessages = new Set<number>();
  if (strictDelegations.size) {
    const raw = rawFields(parsed);
    for (const mapping of [raw.messages, raw.results]) for (const [message, entry] of mapping) if (selectedMessages.has(message)) verifiedRawMessages.add(entry.index);
  }
  for (const index of rawIndices) {
    const item = inputs[index];
    if (record(item) && (item.role === "system" && (item.type === "message" || item.type === undefined)
      || verifiedRawMessages.has(index) && strictDelegations.has(index))) result.push({ raw_input_index: index });
  }
  return Object.freeze(result.map(locator => Object.freeze(locator)));
}

export class ContextSnapshot {
  readonly context_id: string;
  readonly sources: readonly ContextSource[];
  readonly targets: readonly ContextTarget[];
  readonly storage_bytes: number;
  readonly #texts = new Map<string, string>();
  readonly #images = new Map<string, { mime_type: string; bytes: Uint8Array; visual_token_reserve: number }>();
  readonly #wire: ContextSnapshotWire;
  readonly #sourcesById = new Map<string, ContextSource>();
  readonly #targetsById = new Map<string, ContextTarget>();
  readonly #targetsByReadRef = new Map<string, ContextTarget>();

  /** Use createContextSnapshot or restoreContextSnapshot; this constructor validates the wire. */
  constructor(wire: ContextSnapshotWire, maxStorageBytes = CONTEXT_LIMITS.maxStorageBytes) {
    validateWire(wire, maxStorageBytes);
    this.#wire = freeze(structuredClone(wire));
    this.context_id = wire.context_id;
    this.sources = this.#wire.sources;
    this.targets = this.#wire.targets;
    this.storage_bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
    for (const source of this.sources) this.#sourcesById.set(source.source_id, source);
    for (const target of this.targets) { this.#targetsById.set(target.target_id, target); if (target.read_ref) this.#targetsByReadRef.set(target.read_ref, target); }
    for (const payload of wire.payloads) {
      const ref = this.#targetsById.get(payload.target_id)!.read_ref!;
      if (payload.type === "text") this.#texts.set(ref, payload.text);
      else this.#images.set(ref, { mime_type: payload.mime_type, bytes: Uint8Array.from(Buffer.from(payload.data, "base64")),
        visual_token_reserve: payload.visual_token_reserve });
    }
    Object.freeze(this);
  }
  getSource(id: string): ContextSource | undefined { return this.#sourcesById.get(id); }
  getTarget(id: string): ContextTarget | undefined { return this.#targetsById.get(id); }
  getTargetByReadRef(ref: string): ContextTarget | undefined { return this.#targetsByReadRef.get(ref); }
  getText(readRef: string): string | undefined { return this.#texts.get(readRef); }
  getImage(readRef: string): { mime_type: string; bytes: Uint8Array; visual_token_reserve: number } | undefined {
    const image = this.#images.get(readRef);
    return image ? { ...image, bytes: image.bytes.slice() } : undefined;
  }
  /** Returns independent plain JSON data, suitable for trusted owner IPC. */
  toWire(): ContextSnapshotWire { return structuredClone(this.#wire); }
}

export function serializeContextSnapshot(snapshot: ContextSnapshot): ContextSnapshotWire { return snapshot.toWire(); }
export function restoreContextSnapshot(wire: unknown, options: { maxStorageBytes?: number } = {}): ContextSnapshot {
  validateWire(wire, options.maxStorageBytes ?? CONTEXT_LIMITS.maxStorageBytes);
  return new ContextSnapshot(wire as ContextSnapshotWire, options.maxStorageBytes);
}

function normalizedContext(parsed: CodexParsedRequest): string {
  return deterministicContextJson({ system: parsed.context.systemPrompt ?? [], messages: parsed.context.messages.map(message => {
    const { timestamp: _timestamp, ...visible } = message;
    return visible;
  }) });
}

function shellArguments(item: Record<string, unknown>): Record<string, unknown> {
  const command = record(item.action) && Array.isArray(item.action.command) ? item.action.command : [];
  return command.length > 0 ? { command } : {};
}

/** Parser can skip encrypted blocks. Position refers to the resulting canonical part,
 * while the stored raw index always refers to the original input content array. */
function inputBlockLocations(item: Record<string, unknown>): Array<{ block: Record<string, unknown>; raw_index: number }> {
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((block, raw_index) => record(block)
    && ["input_text", "text", "input_image", "input_file"].includes(String(block.type)) ? [{ block, raw_index }] : []);
}

/** Raw fields are reachable only when they map to canonical visible fields. Position is
 * sufficient only after the entire parser projection matches. Otherwise require unique IDs. */
function rawFields(parsed: CodexParsedRequest): {
  calls: Map<CodexToolCall, { item: Record<string, unknown>; index: number }>;
  results: Map<CodexMessage, { item: Record<string, unknown>; index: number }>;
  messages: Map<CodexMessage, { item: Record<string, unknown>; index: number }>;
  systems: Array<{ item: Record<string, unknown>; index: number; system_index?: number }>;
} {
  const calls = new Map<CodexToolCall, { item: Record<string, unknown>; index: number }>();
  const results = new Map<CodexMessage, { item: Record<string, unknown>; index: number }>();
  const messages = new Map<CodexMessage, { item: Record<string, unknown>; index: number }>();
  const systems: Array<{ item: Record<string, unknown>; index: number; system_index?: number }> = [];
  if (!record(parsed._rawBody) || !Array.isArray(parsed._rawBody.input)) return { calls, results, messages, systems };
  const raw = parsed._rawBody.input.flatMap((item, index) => record(item) ? [{ item, index }] : []);
  let same = false;
  let rawParsed: CodexParsedRequest | undefined;
  try { rawParsed = parseRequest(parsed._rawBody); same = normalizedContext(rawParsed) === normalizedContext(parsed); } catch { /* unverified raw input */ }
  const sameSystems = rawParsed && deterministicContextJson(rawParsed.context.systemPrompt ?? []) === deterministicContextJson(parsed.context.systemPrompt ?? []);
  let systemIndex = typeof parsed._rawBody.instructions === "string" && parsed._rawBody.instructions.length > 0 ? 1 : 0;
  for (const entry of raw) if (entry.item.role === "system" && (entry.item.type === "message" || entry.item.type === undefined)) {
    let single: CodexParsedRequest;
    try { single = parseRequest({ model: contextSourceParserModel(parsed), input: [entry.item] }); } catch { continue; }
    const flat = single.context.systemPrompt?.[0];
    if (sameSystems) {
      systems.push({ ...entry, ...(flat !== undefined ? { system_index: systemIndex++ } : {}) });
    } else if (flat !== undefined) {
      const matches = (parsed.context.systemPrompt ?? []).flatMap((text, index) => text === flat ? [index] : []);
      if (matches.length === 1) systems.push({ ...entry, system_index: matches[0] });
      else if (Array.isArray(entry.item.content) && entry.item.content.some(p => record(p) && p.type === "input_image")) throw new Error("System image source cannot be uniquely verified");
    } else if (Array.isArray(entry.item.content) && entry.item.content.some(p => record(p) && p.type === "input_image")) throw new Error("System image source cannot be uniquely verified");
  }
  const parsedCalls = parsed.context.messages.flatMap(m => m.role === "assistant" ? m.content.filter((p): p is CodexToolCall => p.type === "toolCall") : []);
  const rawCalls = raw.filter(({ item }) => ["function_call", "custom_tool_call", "local_shell_call", "tool_search_call"].includes(String(item.type)));
  if (same && parsedCalls.length === rawCalls.length) parsedCalls.forEach((call, i) => calls.set(call, rawCalls[i]!));
  else for (const call of parsedCalls) {
    const candidates = rawCalls.filter(({ item }) => (item.call_id ?? item.id) === call.id
      && (item.name ?? (item.type === "tool_search_call" ? "tool_search" : item.type === "local_shell_call" ? "shell" : undefined)) === call.name
      && (item.namespace ?? undefined) === call.namespace);
    const canonicalCount = parsedCalls.filter(c => c.id === call.id).length;
    if (canonicalCount === 1 && candidates.length === 1) {
      const candidate = candidates[0]!;
      const field = candidate.item.type === "custom_tool_call" ? candidate.item.input : candidate.item.arguments;
      let projection: unknown = field;
      if (typeof field === "string" && candidate.item.type === "function_call") {
        try { projection = JSON.parse(field); } catch { projection = {}; }
        if (!record(projection)) projection = {};
      }
      if (candidate.item.type === "custom_tool_call") projection = { input: typeof field === "string" ? field : "" };
      if (candidate.item.type === "local_shell_call") projection = shellArguments(candidate.item);
      if (candidate.item.type === "tool_search_call") projection = record(field) ? field : {};
      if (deterministicContextJson(projection ?? {}) === deterministicContextJson(call.arguments)) calls.set(call, candidate);
    }
  }
  const parsedResults = parsed.context.messages.filter(m => m.role === "toolResult");
  const rawResults = raw.filter(({ item }) => ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type)));
  if (same && parsedResults.length === rawResults.length) parsedResults.forEach((m, i) => results.set(m, rawResults[i]!));
  else if (rawParsed) for (const m of parsedResults) {
    const candidates = rawResults.filter(({ item }) => item.call_id === m.toolCallId);
    const parsedMatches = rawParsed.context.messages.filter(r => r.role === "toolResult" && r.toolCallId === m.toolCallId
      && deterministicContextJson(r.content) === deterministicContextJson(m.content));
    if (candidates.length === 1 && parsedMatches.length === 1 && parsedResults.filter(r => r.toolCallId === m.toolCallId).length === 1) results.set(m, candidates[0]!);
  }
  const messageSignature = (message: CodexMessage) => {
    const { timestamp: _timestamp, ...visible } = message;
    return deterministicContextJson(visible);
  };
  const canonicalMessages = new Map<string, CodexMessage[]>();
  for (const message of parsed.context.messages) {
    const signature = messageSignature(message);
    const matching = canonicalMessages.get(signature) ?? []; matching.push(message); canonicalMessages.set(signature, matching);
  }
  const rawMessages = new Map<string, Array<{ item: Record<string, unknown>; index: number }>>();
  // Message metadata cannot be inferred from XML/text. Check the actual parser projection.
  for (const entry of raw) {
    if (!(entry.item.type === "agent_message" || ["compaction", "compaction_summary", "context_compaction"].includes(String(entry.item.type))
      || entry.item.type === "message" || (!entry.item.type && entry.item.role))) continue;
    let single: CodexParsedRequest;
    try { single = parseRequest({ model: contextSourceParserModel(parsed), input: [entry.item] }); } catch { continue; }
    for (const candidate of single.context.messages) {
      const signature = messageSignature(candidate);
      const matches = rawMessages.get(signature) ?? []; matches.push(entry); rawMessages.set(signature, matches);
    }
  }
  for (const [signature, entries] of rawMessages) {
    const canonical = canonicalMessages.get(signature);
    if (entries.length === 1 && canonical?.length === 1) messages.set(canonical[0]!, entries[0]!);
    else if (same && canonical?.length === entries.length) {
      // The full parser projection proves the occurrence order even for equal messages.
      canonical.forEach((message, index) => messages.set(message, entries[index]!));
    }
  }
  return { calls, results, messages, systems };
}

export function createContextSnapshot(parsed: CodexParsedRequest, options: ContextSnapshotOptions = {}): ContextSnapshot {
  const sources: ContextSource[] = [];
  const targets: ContextTarget[] = [];
  const payloads: (TextPayload | ImagePayload)[] = [];
  const targetCounts = new Map<string, number>();
  const raw = rawFields(parsed);
  let observedBytes = 0;
  const maxStorage = options.maxStorageBytes ?? CONTEXT_LIMITS.maxStorageBytes;
  const fixedMatches = new Map<FixedContextImage, string[]>();
  const pendingImages: Array<{ target: ContextTarget; fixed?: FixedContextImage; imageUrl?: string; detail?: string }> = [];
  if (options.imageStoragePolicy !== undefined && !["complete", "bounded"].includes(options.imageStoragePolicy)) throw new Error("Invalid context image storage policy");
  const priorities = options.priorityImageLocators ?? contextSnapshotPriorityImageLocators(parsed);
  for (const locator of priorities) {
    requireShape(locator, ["message_index", "content_index", "system_index", "raw_input_index", "raw_content_index"]);
    if (!Object.keys(locator).length || Object.values(locator).some(v => !Number.isSafeInteger(v) || (v as number) < 0)) throw new Error("Invalid context priority image locator");
  }
  for (const image of options.fixedImages ?? []) {
    requireShape(image.locator, ["message_index", "content_index", "system_index", "raw_input_index", "raw_content_index"]);
    if (!Object.keys(image.locator).length || Object.values(image.locator).some(v => !Number.isSafeInteger(v) || (v as number) < 0)) throw new Error("Invalid fixed context image locator");
    assertSupportedContextImage(image.bytes, image.mime_type);
    if (image.bytes.length > CONTEXT_LIMITS.maxImageBytes) throw new Error("Fixed context image exceeds the MCP image limit");
  }
  const addSource = (base: Omit<ContextSource, "source_id" | "source_index">): ContextSource => {
    const source = { ...base, source_id: `s_${sources.length + 1}`, source_index: sources.length + 1 };
    sources.push(source);
    return source;
  };
  const addTarget = (source: ContextSource, kind: ContextTarget["kind"], locator: ContextLocator, fields: Partial<ContextTarget>,
    text?: string, imageUrl?: string, detail?: string): void => {
    const targetIndex = (targetCounts.get(source.source_id) ?? 0) + 1; targetCounts.set(source.source_id, targetIndex);
    const target: ContextTarget = { ...source, target_id: `t_${targets.length + 1}`, target_index: targetIndex,
      kind, locator, tool_name: null, namespace: null, call_id: null, read_ref: null, encoding: null, utf8_bytes: null,
      mime_type: null, image_bytes: null, content_digest: null, visual_token_reserve: null, label: "", label_source: "unavailable",
      unavailable_reason: null, error_status: "unknown", relation: { state: "not_applicable", call_count: 0, result_count: 0, related_target_ids: [] }, ...fields };
    if (text !== undefined) {
      if (/[\uD800-\uDFFF]/u.test(text)) throw new Error("Context text is not valid Unicode");
      target.read_ref = opaque("read"); target.encoding ??= "utf-8";
      target.utf8_bytes = Buffer.byteLength(text, "utf8"); target.content_digest = digest(text);
      target.label = Array.from(text).slice(0, CONTEXT_LIMITS.labelChars).join(""); target.label_source = "excerpt";
      payloads.push({ target_id: target.target_id, type: "text", text }); observedBytes += target.utf8_bytes;
    } else if (kind === "image") {
      const matches = (options.fixedImages ?? []).filter(image => Object.entries(image.locator).every(([k, v]) => locator[k as keyof ContextLocator] === v));
      if (matches.length > 1) throw new Error("Ambiguous fixed context image source");
      const fixed = matches[0];
      if (fixed) { const matched = fixedMatches.get(fixed) ?? []; matched.push(target.target_id); fixedMatches.set(fixed, matched); }
      target.unavailable_reason = "Image source is not fixed in a supported representation"; target.label = "Unavailable image";
      pendingImages.push({ target, ...(fixed ? { fixed } : {}), ...(imageUrl ? { imageUrl } : {}), ...(detail ? { detail } : {}) });
    }
    targets.push(target);
    if (observedBytes > maxStorage) throw new Error("Context snapshot storage budget exceeded");
  };
  const addRawSystem = (entry: { item: Record<string, unknown>; index: number; system_index?: number }): void => {
    const locator: ContextLocator = { ...(entry.system_index !== undefined ? { system_index: entry.system_index } : {}), raw_input_index: entry.index, field: "content" };
    const source = addSource({ source_kind: "system", original_role: "system", origin: null, provenance: "verified_raw", source_completeness: "unknown", locator });
    if (typeof entry.item.content === "string") { addTarget(source, "message_text", { ...locator }, {}, entry.item.content); return; }
    let textOffset = 0;
    for (const [blockIndex, block] of (Array.isArray(entry.item.content) ? entry.item.content : []).entries()) {
      if (!record(block)) continue;
      const blockLocator = { ...locator, raw_content_index: blockIndex };
      if (["text", "input_text"].includes(String(block.type)) && typeof block.text === "string") {
        addTarget(source, "message_text", { ...blockLocator, text_start: textOffset, text_end_exclusive: textOffset + block.text.length }, {}, block.text);
        textOffset += block.text.length;
      } else if (block.type === "input_image") addTarget(source, "image", blockLocator, {}, undefined, typeof block.image_url === "string" ? block.image_url : undefined, String(block.detail ?? "auto"));
      else if (block.type === "input_file") {
        const text = `[file: ${block.file_id ?? block.filename ?? "?"}]`;
        addTarget(source, "message_text", { ...blockLocator, text_start: textOffset, text_end_exclusive: textOffset + text.length }, {}, text); textOffset += text.length;
      }
    }
  };
  const emittedSystems = new Set<number>();
  for (const [index, text] of (parsed.context.systemPrompt ?? []).entries()) {
    const matching = raw.systems.find(s => s.system_index === index);
    if (matching) {
      for (const entry of raw.systems) if (entry.index <= matching.index && !emittedSystems.has(entry.index)) { addRawSystem(entry); emittedSystems.add(entry.index); }
      continue;
    }
    const source = addSource({ source_kind: "system", original_role: "system", origin: null, provenance: "parsed", source_completeness: "unknown",
      locator: { system_index: index, field: "systemPrompt" } });
    addTarget(source, "message_text", { ...source.locator }, {}, text);
  }
  for (const entry of raw.systems) if (!emittedSystems.has(entry.index)) addRawSystem(entry);
  for (const [messageIndex, message] of parsed.context.messages.entries()) {
    const rawMessage = raw.messages.get(message) ?? raw.results.get(message);
    const evidence = options.provenanceByMessage?.get(messageIndex);
    const summary = rawMessage && ["compaction", "compaction_summary", "context_compaction"].includes(String(rawMessage.item.type));
    const delegation = rawMessage && (message.role === "toolResult" || message.role === "agentMessage") && hasNativeChatGptInstruction(parsed, [rawMessage.item]);
    const source = addSource({ source_kind: evidence?.source_kind ?? (summary ? "summary" : delegation ? "delegation" : message.role === "toolResult" ? "tool"
      : message.role === "agentMessage" ? "agent_message" : message.role === "user" && message.origin === "codex_skill" ? "skill" : message.role),
      original_role: message.role, origin: message.role === "user" ? message.origin ?? null : null,
      ...(message.role === "agentMessage" ? { author: message.author ?? null, recipient: message.recipient ?? null } : {}),
      provenance: evidence?.restored ? "verified_restoration" : rawMessage ? "verified_raw" : "parsed",
      source_completeness: evidence?.source_completeness ?? "unknown", locator: { message_index: messageIndex,
        ...(rawMessage ? { raw_input_index: rawMessage.index } : {}), field: message.role === "toolResult" ? "output" : "content" } });
    const relationFields = message.role === "toolResult" ? { call_id: message.toolCallId || null,
      error_status: (typeof rawMessage?.item.is_error === "boolean" ? rawMessage.item.is_error ? "error" : "not_error" : "unknown") as ContextTarget["error_status"] } : {};
    const resultItem = raw.results.get(message);
    if (message.role === "toolResult" && resultItem && Array.isArray(resultItem.item.output)) {
      let canonicalIndex = 0, textOffset = 0;
      for (const [blockIndex, block] of resultItem.item.output.entries()) {
        if (!record(block)) continue;
        let text: string | undefined;
        if (["input_text", "text", "output_text"].includes(String(block.type)) && typeof block.text === "string") text = block.text;
        else if (block.type === "refusal" && typeof block.refusal === "string") text = `[refusal: ${block.refusal}]`;
        else if (block.type === "encrypted_content") text = "[encrypted content omitted]";
        const isImage = block.type === "input_image";
        if (text === undefined && !isImage) continue;
        const locator: ContextLocator = { ...source.locator, raw_content_index: blockIndex,
          ...(typeof message.content === "string" ? { text_start: textOffset, text_end_exclusive: textOffset + (text?.length ?? 0) }
            : text !== undefined || typeof block.image_url === "string" ? { content_index: canonicalIndex } : {}) };
        if (text !== undefined) { addTarget(source, "tool_result", locator, relationFields, text); textOffset += text.length; }
        else addTarget(source, "image", locator, relationFields, undefined, typeof block.image_url === "string" ? block.image_url : undefined, String(block.detail ?? "auto"));
        if (text !== undefined || typeof block.image_url === "string") canonicalIndex++;
      }
      if (canonicalIndex === 0 && resultItem.item.output.length === 0) addTarget(source, "tool_result", { ...source.locator, text_start: 0, text_end_exclusive: 0 }, relationFields, "");
      continue;
    }
    if (typeof message.content === "string") {
      const rawParts = rawMessage ? inputBlockLocations(rawMessage.item) : [];
      if (rawParts.length === 1 && rawParts[0]!.block.type === "input_image") {
        const { block, raw_index } = rawParts[0]!;
        addTarget(source, "image", { ...source.locator, raw_content_index: raw_index }, relationFields, undefined,
          typeof block.image_url === "string" ? block.image_url : undefined, String(block.detail ?? "auto"));
        continue;
      }
      addTarget(source, message.role === "toolResult" ? "tool_result" : "message_text", { ...source.locator }, relationFields, message.content);
      continue;
    }
    for (const [contentIndex, part] of message.content.entries()) {
      const rawPartLocation = rawMessage ? inputBlockLocations(rawMessage.item)[contentIndex] : undefined;
      const locator: ContextLocator = { ...source.locator, content_index: contentIndex,
        ...(rawPartLocation ? { raw_content_index: rawPartLocation.raw_index } : {}) };
      const rawInputPart = rawPartLocation?.block;
      if (part.type === "text" && record(rawInputPart) && rawInputPart.type === "input_image") addTarget(source, "image", locator, relationFields, undefined,
        typeof rawInputPart.image_url === "string" ? rawInputPart.image_url : undefined, String(rawInputPart.detail ?? "auto"));
      else if (part.type === "text") addTarget(source, message.role === "toolResult" ? "tool_result" : "message_text", locator, relationFields, part.text);
      else if (part.type === "image") {
        const rawPart = rawInputPart;
        const originalDetail = record(rawPart) && rawPart.type === "input_image" && typeof rawPart.detail === "string" ? rawPart.detail : part.detail;
        addTarget(source, "image", locator, relationFields, undefined, part.imageUrl, originalDetail);
      }
      else if (part.type === "thinking") addTarget(source, "message_text", { ...locator, field: "thinking" }, {}, part.thinking);
      else if (part.type === "toolCall") {
        const original = raw.calls.get(part);
        const field = original?.item.type === "custom_tool_call" ? "input" : "arguments";
        const input = original?.item.type === "local_shell_call" ? shellArguments(original.item) : original?.item[field];
        let text: string | undefined, encoding: ContextTarget["encoding"] = "deterministic-json";
        if (typeof input === "string") {
          if (evidence?.restored && evidence.tool_arguments_encoding === "deterministic-json") text = deterministicContextJson(part.arguments);
          else { text = input; encoding = "utf-8"; }
        }
        else if (record(input) || Array.isArray(input)) text = deterministicContextJson(input);
        else if (!parsed._rawBody || original?.item.type === "local_shell_call" || original?.item.type === "tool_search_call") text = deterministicContextJson(part.arguments);
        // Never publish parser's {} as the original when raw field correspondence is unproven.
        addTarget(source, "tool_arguments", { message_index: messageIndex, content_index: contentIndex,
          ...(original ? { raw_input_index: original.index } : {}), field }, { call_id: part.id || null, tool_name: part.name || null,
          namespace: part.namespace || null, encoding, provenance: evidence?.restored ? "verified_restoration" : original ? "verified_raw" : source.provenance,
          unavailable_reason: text === undefined ? "Original tool argument field could not be uniquely verified" : null }, text);
      }
    }
  }
  for (const image of options.fixedImages ?? []) if (Object.keys(image.locator).length === 0 || fixedMatches.get(image)?.length !== 1) {
    throw new Error("Fixed context image locator must identify exactly one source image");
  }
  applyRelations(targets);
  const wire: ContextSnapshotWire = { version: 1, context_id: opaque("context"), sources, targets, payloads };
  let wireBytes = Buffer.byteLength(JSON.stringify(wire));
  if (!Number.isSafeInteger(maxStorage) || maxStorage < 1 || wireBytes > maxStorage) throw new Error("Context snapshot storage budget exceeded");
  const priority = (target: ContextTarget): number => {
    const index = priorities.findIndex(locator => Object.entries(locator).every(([key, value]) => target.locator[key as keyof ContextLocator] === value));
    return index >= 0 ? index : priorities.length;
  };
  if (options.imageStoragePolicy === "bounded") pendingImages.sort((a, b) => priority(a.target) - priority(b.target) || b.target.source_index - a.target.source_index || a.target.target_index - b.target.target_index);
  for (const pending of pendingImages) {
    const { target, fixed, imageUrl, detail } = pending;
    let bytes: Uint8Array | undefined, mime: string | undefined;
    const before = Buffer.byteLength(JSON.stringify(target));
    const reserve = fixed?.visual_token_reserve ?? chatGptWebImageTokenReserve(detail);
    const inline = imageUrl ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(imageUrl) : undefined;
    const encodedBytes = fixed ? Math.ceil(fixed.bytes.length / 3) * 4 : inline?.[2]?.length;
    if (options.imageStoragePolicy === "bounded" && encodedBytes !== undefined && encodedBytes > maxStorage - wireBytes) {
      target.unavailable_reason = "Image exceeds fixed-source storage budget";
      wireBytes += Buffer.byteLength(JSON.stringify(target)) - before;
      continue;
    }
    if (fixed) { bytes = fixed.bytes.slice(); mime = fixed.mime_type; }
    else if (inline && inline[2]!.length <= Math.ceil(CONTEXT_LIMITS.maxImageBytes / 3) * 4) {
      const decoded = Buffer.from(inline[2]!, "base64");
      if (decoded.toString("base64") === inline[2]) { bytes = decoded; mime = inline[1]; }
    }
    if (bytes && mime) { try { assertSupportedContextImage(bytes, mime); } catch { bytes = undefined; } }
    if (!bytes || !mime || !bytes.length || bytes.length > CONTEXT_LIMITS.maxImageBytes || !Number.isSafeInteger(reserve) || reserve <= 0) continue;
    const previous = { ...target };
    Object.assign(target, { read_ref: opaque("read"), mime_type: mime, image_bytes: bytes.length, visual_token_reserve: reserve,
      content_digest: digest(bytes), label: `${mime} (${bytes.length} bytes)`, label_source: "image_metadata", unavailable_reason: null });
    const payload: ImagePayload = { target_id: target.target_id, type: "image", mime_type: mime, data: Buffer.from(bytes).toString("base64"), visual_token_reserve: reserve };
    const delta = Buffer.byteLength(JSON.stringify(target)) - before + Buffer.byteLength(JSON.stringify(payload)) + (payloads.length ? 1 : 0);
    if (wireBytes + delta > maxStorage) {
      if (options.imageStoragePolicy !== "bounded") throw new Error("Context snapshot storage budget exceeded");
      Object.assign(target, previous, { unavailable_reason: "Image exceeds fixed-source storage budget" });
      wireBytes += Buffer.byteLength(JSON.stringify(target)) - before;
    } else { payloads.push(payload); wireBytes += delta; }
  }
  return new ContextSnapshot(wire, maxStorage);
}

function applyRelations(targets: ContextTarget[]): void {
  const groups = new Map<string, { calls: ContextTarget[]; results: ContextTarget[] }>();
  for (const target of targets) if (target.call_id) {
    const group = groups.get(target.call_id) ?? { calls: [], results: [] };
    groups.set(target.call_id, group);
    if (target.kind === "tool_arguments") group.calls.push(target);
    if (target.original_role === "toolResult") group.results.push(target);
  }
  for (const { calls, results } of groups.values()) {
    const resultCount = new Set(results.map(t => t.source_id)).size;
    const state = calls.length > 1 || resultCount > 1 ? "ambiguous" : calls.length === 1 && resultCount === 1 ? "paired" : "missing";
    for (const target of [...calls, ...results]) {
      target.relation = { state, call_count: calls.length, result_count: resultCount,
        related_target_ids: state === "paired" ? (target.kind === "tool_arguments" ? results : calls).map(t => t.target_id) : [] };
      if (target.original_role === "toolResult") {
        target.tool_name = calls.length === 1 ? calls[0]!.tool_name : null;
        target.namespace = calls.length === 1 ? calls[0]!.namespace : null;
      }
    }
  }
  for (const target of targets) if ((target.kind === "tool_arguments" || target.original_role === "toolResult") && !target.call_id) {
    target.relation = { state: "missing", call_count: 0, result_count: 0, related_target_ids: [] };
  }
}

function requireShape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error("Invalid context snapshot wire format");
}
function validateLocator(value: unknown): asserts value is ContextLocator {
  requireShape(value, ["system_index", "message_index", "content_index", "raw_input_index", "raw_content_index", "text_start", "text_end_exclusive", "field"]);
  if (!["systemPrompt", "content", "arguments", "input", "output", "thinking"].includes(String(value.field))) throw new Error("Invalid context source locator");
  if (value.system_index !== undefined && value.message_index !== undefined
    || value.system_index === undefined && value.message_index === undefined && (value.raw_input_index === undefined || value.field !== "content")) throw new Error("Invalid context source locator");
  for (const [key, v] of Object.entries(value)) if (key !== "field" && (!Number.isSafeInteger(v) || (v as number) < 0)) throw new Error("Invalid context source locator");
  if ((value.text_start !== undefined) !== (value.text_end_exclusive !== undefined)
    || value.text_start !== undefined && (value.text_end_exclusive as number) < (value.text_start as number)) throw new Error("Invalid context source text range");
}
function validString(value: unknown, nullable = false, limit = 1024): boolean { return nullable && value === null || typeof value === "string" && Buffer.byteLength(value) <= limit; }
function validateWire(value: unknown, maxStorageBytes: number): asserts value is ContextSnapshotWire {
  if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 1) throw new Error("Invalid context storage budget");
  requireShape(value, ["version", "context_id", "sources", "targets", "payloads"]);
  if (value.version !== 1 || typeof value.context_id !== "string" || !/^context_[0-9a-f]{32}$/.test(value.context_id)
    || !Array.isArray(value.sources) || !Array.isArray(value.targets) || !Array.isArray(value.payloads)) throw new Error("Invalid context snapshot wire format");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxStorageBytes) throw new Error("Context snapshot storage budget exceeded");
  const sourceKeys = ["source_id", "source_index", "source_kind", "original_role", "origin", "author", "recipient", "provenance", "source_completeness", "locator"];
  const targetKeys = [...sourceKeys, "target_id", "target_index", "kind", "tool_name", "namespace", "call_id", "read_ref", "encoding", "utf8_bytes", "mime_type", "image_bytes",
    "content_digest", "visual_token_reserve", "label", "label_source", "unavailable_reason", "error_status", "relation"];
  for (const [i, s] of value.sources.entries()) {
    requireShape(s, sourceKeys);
    if (s.source_id !== `s_${i + 1}` || s.source_index !== i + 1 || !sourceKinds.includes(String(s.source_kind)) || !validString(s.original_role)
      || !validString(s.origin, true) || !["parsed", "verified_raw", "verified_restoration"].includes(String(s.provenance)) || !completeness.includes(String(s.source_completeness))) throw new Error("Invalid context source record");
    validateLocator(s.locator);
    if (s.author !== undefined && !validString(s.author, true) || s.recipient !== undefined && !validString(s.recipient, true)) throw new Error("Invalid context agent provenance");
  }
  const sourcesById = new Map(value.sources.map((s: ContextSource) => [s.source_id, s]));
  const counts = new Map<string, number>(), refs = new Set<string>();
  let previousSourceIndex = 0;
  for (const [i, t] of value.targets.entries()) {
    requireShape(t, targetKeys);
    const source = sourcesById.get(t.source_id as string);
    const next = (counts.get(String(t.source_id)) ?? 0) + 1; counts.set(String(t.source_id), next);
    if (!source || t.target_id !== `t_${i + 1}` || t.target_index !== next || t.source_index !== source.source_index
      || t.source_kind !== source.source_kind || t.original_role !== source.original_role || t.origin !== source.origin || t.author !== source.author || t.recipient !== source.recipient
      || t.source_index < previousSourceIndex || !targetKinds.includes(String(t.kind))
      || !completeness.includes(String(t.source_completeness)) || !["parsed", "verified_raw", "verified_restoration"].includes(String(t.provenance))) throw new Error("Invalid context target record");
    for (const key of ["tool_name", "namespace", "call_id", "mime_type", "unavailable_reason"] as const) if (!validString(t[key], true)) throw new Error("Invalid context target metadata");
    if (!validString(t.label, false, CONTEXT_LIMITS.labelChars * 4) || !["excerpt", "image_metadata", "unavailable"].includes(String(t.label_source))
      || !["error", "not_error", "unknown"].includes(String(t.error_status)) || ![null, "utf-8", "deterministic-json"].includes(t.encoding as null)) throw new Error("Invalid context target metadata");
    for (const key of ["utf8_bytes", "image_bytes", "visual_token_reserve"] as const) if (t[key] !== null && (!Number.isSafeInteger(t[key]) || (t[key] as number) < 0)) throw new Error("Invalid context payload size");
    if (t.content_digest !== null && (typeof t.content_digest !== "string" || !/^[0-9a-f]{64}$/.test(t.content_digest))) throw new Error("Invalid context digest");
    if (t.read_ref !== null) {
      if (typeof t.read_ref !== "string" || !/^read_[0-9a-f]{32}$/.test(t.read_ref) || refs.has(t.read_ref)) throw new Error("Invalid context read reference");
      refs.add(t.read_ref);
    }
    validateLocator(t.locator);
    previousSourceIndex = t.source_index as number;
    if (t.locator.system_index === undefined && t.locator.message_index === undefined && t.original_role !== "system") throw new Error("Invalid raw-only context locator");
    requireShape(t.relation, ["state", "call_count", "result_count", "related_target_ids"]);
    if (!["paired", "missing", "ambiguous", "not_applicable"].includes(String(t.relation.state)) || !Number.isSafeInteger(t.relation.call_count)
      || !Number.isSafeInteger(t.relation.result_count) || !Array.isArray(t.relation.related_target_ids)) throw new Error("Invalid context relation");
  }
  const originalTargets = value.targets;
  const relationCopy = structuredClone(originalTargets) as ContextTarget[]; applyRelations(relationCopy);
  if (relationCopy.some((t, i) => deterministicContextJson(t.relation) !== deterministicContextJson(originalTargets[i].relation)
    || t.tool_name !== originalTargets[i].tool_name || t.namespace !== originalTargets[i].namespace)) throw new Error("Invalid context tool relation");
  const seen = new Set<string>();
  const targetsById = new Map(value.targets.map((t: ContextTarget) => [t.target_id, t]));
  for (const p of value.payloads) {
    requireShape(p, p.type === "text" ? ["target_id", "type", "text"] : ["target_id", "type", "mime_type", "data", "visual_token_reserve"]);
    const target = targetsById.get(p.target_id as string);
    if (!target?.read_ref || seen.has(String(p.target_id))) throw new Error("Invalid context payload reference");
    seen.add(String(p.target_id));
    if (p.type === "text") {
      if (target.kind === "image" || typeof p.text !== "string" || /[\uD800-\uDFFF]/u.test(p.text) || target.utf8_bytes !== Buffer.byteLength(p.text) || target.content_digest !== digest(p.text)
        || target.encoding === null || target.mime_type !== null || target.image_bytes !== null || target.visual_token_reserve !== null) throw new Error("Invalid context text payload");
    } else if (p.type === "image") {
      if (target.kind !== "image" || target.encoding !== null || target.utf8_bytes !== null || !IMAGE_MIMES.has(String(p.mime_type)) || typeof p.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)
        || !Number.isSafeInteger(p.visual_token_reserve) || (p.visual_token_reserve as number) <= 0) throw new Error("Invalid context image payload");
      const bytes = Buffer.from(p.data, "base64");
      if (bytes.length < 1 || bytes.length > CONTEXT_LIMITS.maxImageBytes || bytes.toString("base64") !== p.data || target.image_bytes !== bytes.length
        || target.mime_type !== p.mime_type || target.content_digest !== digest(bytes) || target.visual_token_reserve !== p.visual_token_reserve) throw new Error("Invalid context image payload");
      assertSupportedContextImage(bytes, String(p.mime_type));
    } else throw new Error("Invalid context payload type");
  }
  if (value.targets.some((t: ContextTarget) => t.read_ref !== null && !seen.has(t.target_id))) throw new Error("Missing fixed context payload");
}
