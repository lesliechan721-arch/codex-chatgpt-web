import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Reuse codecs shipped in the installed Playwright 1.62 distribution. jpeg-js is
// exported by its utilsBundle; libwebp's ABI is verified before instantiation.
// The installed package's webp_codec.LICENSE covers libwebp and Emscripten.
// Only this fixed dependency asset is read; task data cannot supply a path.
const codecRequire = createRequire(import.meta.url);
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_CODEC_MEMORY = 128 * 1024 * 1024;
interface JpegCodec { decode(bytes: Uint8Array, options: Record<string, unknown>): { width: number; height: number; data: Uint8Array } }
let jpeg: JpegCodec | undefined;
export function assertDecodableContextJpeg(bytes: Uint8Array): void {
  jpeg ??= (codecRequire("playwright-core/lib/utilsBundle") as { jpegjs: JpegCodec }).jpegjs;
  if (typeof jpeg?.decode !== "function") throw new Error("Installed JPEG codec is unavailable");
  const result = jpeg.decode(bytes, { tolerantDecoding: false, maxResolutionInMP: MAX_PIXELS / 1_000_000,
    maxMemoryUsageInMB: MAX_CODEC_MEMORY / (1024 * 1024), useTArray: true, formatAsRGBA: true });
  if (!result.width || !result.height || result.width * result.height > MAX_PIXELS || result.data.length !== result.width * result.height * 4) throw new Error("JPEG decoding failed");
}

interface WebpCodec {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  freeImage(pointer: number): void;
  decode(pointer: number, size: number, width: number, height: number): number;
}
let webp: WebpCodec | undefined;
function webpCodec(): WebpCodec {
  if (webp) return webp;
  const wasmPath = join(dirname(codecRequire.resolve("playwright-core/lib/coreBundle")), "webp_codec.wasm");
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
  if (imports.length !== 5 || imports.some(i => i.module !== "a" || !["a", "b", "c", "d", "e"].includes(i.name) || i.kind !== "function")
    || exports.length !== 8 || exports.some(e => !["f", "g", "h", "i", "j", "k", "l", "m"].includes(e.name) || e.kind !== (e.name === "f" ? "memory" : "function"))) throw new Error("Installed WebP codec ABI is unsupported");
  let memory: WebAssembly.Memory;
  const abort = () => { throw new Error("WebP decoding failed"); };
  const instance = new WebAssembly.Instance(module, { a: {
    a: abort, c: abort, d: () => {}, e: abort,
    b: (requested: number) => {
      if (!Number.isSafeInteger(requested) || requested < 0 || requested > MAX_CODEC_MEMORY) return 0;
      try { const extra = Math.ceil((requested - memory.buffer.byteLength) / 65536); if (extra > 0) memory.grow(extra); return 1; } catch { return 0; }
    },
  } });
  const api = instance.exports as unknown as { f: WebAssembly.Memory; g(): void; i: WebpCodec["decode"]; j: WebpCodec["freeImage"]; k: WebpCodec["malloc"]; l: WebpCodec["free"] };
  memory = api.f;
  if (memory.buffer.byteLength > MAX_CODEC_MEMORY) throw new Error("Installed WebP codec exceeds the memory limit");
  api.g();
  webp = { memory, decode: api.i, freeImage: api.j, malloc: api.k, free: api.l };
  return webp;
}

/** Full libwebp pixel decoding; decoded pixels stay private and are discarded. */
export function assertDecodableContextWebp(bytes: Uint8Array, expected?: { width: number; height: number }): void {
  const codec = webpCodec();
  let input = 0, sizes = 0, output = 0;
  try {
    input = codec.malloc(bytes.length); sizes = codec.malloc(8);
    if (!input || !sizes) throw new Error("WebP decoding exceeds the memory limit");
    new Uint8Array(codec.memory.buffer).set(bytes, input);
    output = codec.decode(input, bytes.length, sizes, sizes + 4);
    if (!output) throw new Error("WebP decoding failed");
    const view = new DataView(codec.memory.buffer), width = view.getUint32(sizes, true), height = view.getUint32(sizes + 4, true);
    if (!width || !height || width * height > MAX_PIXELS || output + width * height * 4 > codec.memory.buffer.byteLength) throw new Error("WebP decoded pixels exceed the limit");
    if (expected && (width !== expected.width || height !== expected.height)) throw new Error("WebP decoded pixels do not match the frame rectangle");
  } finally {
    if (output) codec.freeImage(output);
    if (sizes) codec.free(sizes);
    if (input) codec.free(input);
  }
}
