import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { contextSnapshotPriorityImageLocators, createContextSnapshot, restoreContextSnapshot, serializeContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";

test("default 32 MiB snapshot storage bounds nine 3 MiB historical PNGs and preserves the current image", () => {
  const valid = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  const padding = Buffer.alloc(3 * 1024 * 1024 - valid.length);
  padding.writeUInt32BE(padding.length - 12); padding.write("ruSt", 4, "ascii");
  // Independent fixture checksum from Python zlib: CRC32(b"ruSt" + bytes(3145648)).
  padding.writeUInt32BE(0xb1fc5917, padding.length - 4);
  const history = Buffer.concat([valid.subarray(0, -12), padding, valid.subarray(-12)]);
  expect(history.length).toBe(3 * 1024 * 1024);
  const historyUrl = `data:image/png;base64,${history.toString("base64")}`;
  const parsed = parseRequest({ model: "gpt-6", input: [
    ...Array.from({ length: 9 }, (_, index) => ({ type: "function_call_output", call_id: `old-${index}`, output: [{ type: "input_image", image_url: historyUrl }] })),
    { role: "user", content: [{ type: "input_text", text: "Current instruction remains complete" }, { type: "input_image", image_url: `data:image/png;base64,${valid.toString("base64")}` }] },
  ] });
  const snapshot = createContextSnapshot(parsed, { imageStoragePolicy: "bounded", priorityImageLocators: contextSnapshotPriorityImageLocators(parsed, { messageIndices: [9], rawInputIndices: [9] }) });
  const current = snapshot.targets.find(t => t.original_role === "user" && t.kind === "image")!;
  expect(current.read_ref).toBeString(); expect(Buffer.from(snapshot.getImage(current.read_ref!)!.bytes)).toEqual(valid);
  expect(snapshot.storage_bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  const historical = snapshot.targets.filter(t => t.original_role === "toolResult");
  expect(historical).toHaveLength(9);
  expect(historical.filter(t => t.read_ref)).toHaveLength(7);
  expect(historical.filter(t => !t.read_ref)).toHaveLength(2);
  expect(historical.filter(t => !t.read_ref).every(t => t.unavailable_reason!.includes("storage"))).toBe(true);
  expect(snapshot.getText(snapshot.targets.find(t => t.kind === "message_text")!.read_ref!)).toBe("Current instruction remains complete");
  const restored = restoreContextSnapshot(serializeContextSnapshot(snapshot));
  expect(restored.targets).toEqual(snapshot.targets);
  const readable = historical.find(t => t.read_ref)!;
  expect(Buffer.from(restored.getImage(readable.read_ref!)!.bytes)).toEqual(history);
  expect(() => createContextSnapshot(parsed)).toThrow("storage budget");
}, 30000);
