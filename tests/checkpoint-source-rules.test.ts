import { expect } from "bun:test";
import { performanceTest } from "./helpers/performance-test";
import { continuityInstructionSelection, requestCarriedChatGptInstructionRevision } from "../src/adapters/chatgpt-web/environment-instruction";
import { continuitySourceRepresentationDigest } from "../src/adapters/chatgpt-web/continuity-source";
import {
  checkpointSourceDecision, checkpointSourceIdentity, checkpointSourceItem, checkpointSourceMarker,
  checkpointSourceRequest, checkpointSourceView, changedCheckpointSource,
} from "./helpers/checkpoint-source-fixture";

const test = performanceTest(import.meta.path);
function rejectSource(input: unknown[], record: ReturnType<typeof checkpointSourceView>) {
  try { checkpointSourceDecision(input, record); throw new Error("Changed source was accepted"); }
  catch (error) { expect(error).toMatchObject({ code: "continuity_source_unproven", status: 409, retryable: false }); }
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

for (const manual of [false, true]) test(`T5 source rules: structured source key order ${manual}`, () => {
  const original = checkpointSourceItem(false, true), record = checkpointSourceView(original), marker = checkpointSourceMarker();
  const reordered = checkpointSourceDecision([marker, reverseKeys(original)], record);
  expect(reordered).toMatchObject({ action: "admit", commit: "commit-one", work: "source", primary: [1], carried: true });
  expect(checkpointSourceDecision([marker, original], record)).toEqual(reordered);
  const content = original.content as Array<Record<string, unknown>>;
  for (const changed of [[...content].reverse(), [{ ...content[0], text: "Changed source instruction." }, content[1]]]) {
    rejectSource([marker, { ...original, content: changed }], record);
  }
  expect(checkpointSourceDecision([marker, original], record)).toEqual(reordered);
});

for (const manual of [false, true]) for (const parent of [false, true]) for (const change of ["role", "content", "turn"] as const) {
  test(`T5 source rules: changed source ${change} ${manual} parent ${parent}`, () => {
    const original = checkpointSourceItem(parent), record = checkpointSourceView(original), marker = checkpointSourceMarker();
    rejectSource([changedCheckpointSource(original, change), marker], record);
    expect(checkpointSourceDecision([original, marker], record)).toMatchObject({ action: "admit", commit: "commit-one", work: "source", primary: [0] });
  });
}
for (const manual of [false, true]) for (const field of ["author", "recipient"] as const) {
  test(`T5 source rules: changed parent ${field} ${manual}`, () => {
    const original = checkpointSourceItem(true), record = checkpointSourceView(original), marker = checkpointSourceMarker();
    const changed = changedCheckpointSource(original, field);
    expect(requestCarriedChatGptInstructionRevision(checkpointSourceRequest([changed, marker]), checkpointSourceIdentity.turnId)).toBeUndefined();
    // The selector alone still selects this checkpoint. The shared primary check rejects it.
    rejectSource([changed, marker], record);
    expect(checkpointSourceDecision([original, marker], record)).toMatchObject({ action: "admit", primary: [0] });
  });
}

test("T5 source rules: request positions keep the existing cache boundaries and read current source content", () => {
  const original = checkpointSourceItem(), parsed = checkpointSourceRequest([original]);
  const input = (parsed._rawBody as { input: unknown[] }).input;
  const positions = continuityInstructionSelection(parsed, input)!;
  const first = requestCarriedChatGptInstructionRevision(parsed, checkpointSourceIdentity.turnId)!;
  const digest = continuitySourceRepresentationDigest(parsed, first);
  expect(continuityInstructionSelection(parsed, input)).toBe(positions);
  (input[0] as Record<string, unknown>).content = "Changed in the same selected item.";
  expect(continuitySourceRepresentationDigest(parsed, requestCarriedChatGptInstructionRevision(parsed, checkpointSourceIdentity.turnId)!)).not.toBe(digest);
  const replacement = structuredClone(input);
  expect(continuityInstructionSelection(parsed, replacement)).not.toBe(positions);
  const byInput = continuityInstructionSelection(parsed, replacement);
  parsed._continuityScope = "another-scope";
  expect(continuityInstructionSelection(parsed, replacement)).not.toBe(byInput);
  const byScope = continuityInstructionSelection(parsed, replacement);
  parsed._compactionRequest = true;
  expect(continuityInstructionSelection(parsed, replacement)).not.toBe(byScope);
  expect(continuityInstructionSelection(checkpointSourceRequest([original]), input)).not.toBe(positions);
});
