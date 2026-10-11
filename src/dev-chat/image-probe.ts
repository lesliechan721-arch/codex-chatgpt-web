import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const DEV_IMAGE_PROBE_TOOL_NAME = "mcp__dev_simulator__image_probe";

export const DEV_IMAGE_PROBE_TOOL = {
  type: "function",
  name: DEV_IMAGE_PROBE_TOOL_NAME,
  description: "Return one fixed, inert PNG fixture as an actual image for DEV MCP image-consumption tests. Read the image itself; metadata does not describe its visual contents. Repeating an image_id returns identical bytes. No user files are read.",
  parameters: {
    type: "object",
    properties: { image_id: { type: "integer", enum: [1, 2, 3] } },
    required: ["image_id"],
    additionalProperties: false,
  },
} as const;

const WIDTH = 720;
const HEIGHT = 240;
const SCALE = 16;
const GAP = 24;
const DIGITS = [
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
] as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

/** Rasterize fixture answers only into pixels, with no PNG text chunks or filename hints. */
function fixturePng(code: string): Buffer {
  const stride = WIDTH + 1;
  const raster = Buffer.alloc(stride * HEIGHT, 255);
  for (let row = 0; row < HEIGHT; row += 1) raster[row * stride] = 0;
  const left = (WIDTH - (code.length * 5 * SCALE + (code.length - 1) * GAP)) / 2;
  const top = (HEIGHT - 7 * SCALE) / 2;
  for (let digit = 0; digit < code.length; digit += 1) {
    const glyph = DIGITS[Number(code[digit])]!;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row]!.length; col += 1) {
        if (glyph[row]![col] !== "1") continue;
        const x = left + digit * (5 * SCALE + GAP) + col * SCALE;
        const y = top + row * SCALE;
        for (let dy = 0; dy < SCALE; dy += 1) {
          const start = (y + dy) * stride + 1 + x;
          raster.fill(0, start, start + SCALE);
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // Grayscale, 8 bits per pixel; no palette or ancillary chunks.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raster, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface DevImageProbeMetadata {
  image_id: 1 | 2 | 3;
  mime_type: "image/png";
  width: number;
  height: number;
  image_bytes: number;
  content_digest: string;
}

const fixtures = ["482731", "915406", "637258"].map((code, index) => {
  const png = fixturePng(code);
  const metadata: Readonly<DevImageProbeMetadata> = Object.freeze({
    image_id: (index + 1) as 1 | 2 | 3,
    mime_type: "image/png",
    width: WIDTH,
    height: HEIGHT,
    image_bytes: png.length,
    content_digest: `sha256:${createHash("sha256").update(png).digest("hex")}`,
  });
  return Object.freeze({ metadata, imageUrl: `data:image/png;base64,${png.toString("base64")}` });
});

export function createDevImageProbe(input: unknown): {
  metadata: Readonly<DevImageProbeMetadata>;
  image: { type: "input_image"; image_url: string; detail: "original" };
} {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error("DEV image probe requires a JSON object with image_id 1, 2, or 3");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== "image_id") {
    throw new Error("DEV image probe accepts only image_id");
  }
  const imageId = (input as Record<string, unknown>).image_id;
  if (imageId !== 1 && imageId !== 2 && imageId !== 3) {
    throw new Error("DEV image probe image_id must be the integer 1, 2, or 3");
  }
  const fixture = fixtures[imageId - 1]!;
  return {
    metadata: fixture.metadata,
    image: { type: "input_image", image_url: fixture.imageUrl, detail: "original" },
  };
}
