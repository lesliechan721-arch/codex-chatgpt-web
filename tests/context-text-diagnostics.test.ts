import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRequest } from "../src/responses/parser";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { contextTextReadReceipt, isContextTextReadReceipt } from "../src/adapters/chatgpt-web/context-text-result";
import { contextTextReadDiagnostic, isContextTextReadDiagnostic } from "../src/adapters/chatgpt-web/context-text-diagnostics";
import { recordLiveTextTransport } from "../scripts/validate-context-rendering";

function receipt() {
  const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: [
    { role: "user", content: "private first source 中文😀" }, { role: "user", content: "private final source tail" },
  ] }));
  return contextTextReadReceipt(new ContextNavigator({ snapshot, scopeId: "diagnostic-source", purpose: "normal" })
    .read({ context_id: snapshot.context_id, reads: snapshot.targets.map(target => ({ read_ref: target.read_ref! })) }));
}

test("the live observer persists hashed transport facts without retaining a usable receipt or source references", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-safe-diagnostic-"));
  try {
    const original = receipt(), pages: Record<string, unknown>[] = [{ transportConfirmed: false }];
    recordLiveTextTransport(pages, original);
    const path = join(directory, "evidence.json"); writeFileSync(path, JSON.stringify({ pages }), { mode: 0o600 });
    const encoded = readFileSync(path, "utf8"), stored = JSON.parse(encoded).pages[0];
    expect(stored.transportConfirmed).toBe(true);
    expect(isContextTextReadDiagnostic(stored.transportReceipt)).toBe(true);
    expect(isContextTextReadReceipt(stored.transportReceipt)).toBe(false);
    expect(stored.transportReceipt.result_digest).toBe(original.result_digest);
    expect(stored.transportReceipt.items).toHaveLength(2);
    for (const [index, item] of original.items.entries()) {
      expect(encoded).not.toContain(item.read_ref);
      expect(stored.transportReceipt.items[index].read_ref_digest).toBe(createHash("sha256").update(item.read_ref).digest("hex"));
      expect(stored.transportReceipt.items[index].range).toEqual(item.range);
    }
    for (const value of ['"read_ref"', '"cursor"', '"body"', '"turn_token"', '"compaction_token"', "private first source", "private final source"]) {
      expect(encoded).not.toContain(value);
    }
    expect(isContextTextReadReceipt(original)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("diagnostic projection requires a valid full receipt and loading rejects unknown or corrupt observation fields", () => {
  const original = receipt(), safe = contextTextReadDiagnostic(original);
  expect(isContextTextReadDiagnostic(safe)).toBe(true);
  for (const field of ["read_ref", "cursor", "body", "turn_token"]) {
    expect(() => contextTextReadDiagnostic({ ...original, [field]: "private-marker" })).toThrow("Invalid context transport receipt");
    expect(isContextTextReadDiagnostic({ ...safe, [field]: "private-marker" })).toBe(false);
    const nested = structuredClone(safe) as any; nested.items[1][field] = "private-marker";
    expect(isContextTextReadDiagnostic(nested)).toBe(false);
  }
  const malformed = structuredClone(safe); malformed.items[1]!.body_utf8_bytes = 0;
  expect(isContextTextReadDiagnostic(malformed)).toBe(false);
  expect(isContextTextReadDiagnostic({ ...safe, items: new Array(1), content_blocks: 2 })).toBe(false);
});
