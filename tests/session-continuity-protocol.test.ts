import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  continuityCurrentInstructionInput, extractChatGptTurnIdentity,
} from "../src/adapters/chatgpt-web/environment";
import { chatGptContinuityInstructionPayloadDigest, continuityInstructionIdentity } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";

interface CapturedRequest {
  label: string;
  replay?: boolean;
  body: { input: Array<Record<string, any>>; [key: string]: any };
}

// Real Codex 0.159.2 wire bodies; these tests replay selection, not a live ChatGPT page.
const capture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol.json"), "utf8")) as {
  captured: CapturedRequest[];
};
const request = (label: string) => {
  const recorded = capture.captured.find(value => value.label === label && !value.replay)!;
  const parsed = parseRequest({ ...structuredClone(recorded.body), model: "gpt-5.6-sol" });
  parsed._conversationPolicy = "continuity-first";
  return parsed;
};
const previous = () => {
  const parsed = request("ordinary");
  return { instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: extractChatGptTurnIdentity(parsed).turnId };
};

test("real Codex new turn retains request-wide developer instructions created in the earlier turn", () => {
  const parsed = request("new-turn");
  const prior = previous();
  const selected = continuityCurrentInstructionInput(parsed, prior);
  expect(JSON.stringify(selected)).toContain("SYSTEM_MARKER");
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  expect(JSON.stringify(selected)).toContain("NEW_TURN_MARKER");
  expect(JSON.stringify(selected)).not.toContain("ORDINARY_MARKER");
  expect(JSON.stringify(selected)).not.toContain("FINAL_MARKER");
  const baseline = chatGptContinuityInstructionPayloadDigest(parsed, prior);
  const raw = parsed._rawBody as CapturedRequest["body"];
  const developer = raw.input.find(item => item.role === "developer" && item.content?.some((part: any) => part.text?.includes("DEVELOPER_MARKER")))!;
  developer.content[0].text = "Changed current developer instruction.";
  expect(chatGptContinuityInstructionPayloadDigest(parsed, prior)).not.toBe(baseline);
});

// Derived variants add native kinds supported by this Codex version; they are not captures.
for (const [kind, layout] of [
  ["plugins.instructions", "merged"], ["plugins.usage_instructions", "merged"], ["apps.instructions", "merged"],
  ["multi_agent.mode_instructions", "standalone"], ["multi_agent.role_instructions", "standalone"],
  ["multi_agent.usage_hint", "standalone"], ["skills.catalog", "merged"], ["skills.instructions", "merged"],
  ["cloud_skills.instructions", "merged"], ["memories.instructions", "merged"], ["plugins.recommendations", "merged"],
  ["environments.instructions", "merged"], ["persistent_mode.instructions", "merged"],
  ["token_budget.context_window", "standalone"], ["token_budget.context_window_guidance", "merged"],
  ["tools.deferred_namespaces", "merged"], ["git_attribution.instructions", "merged"],
  ["managed_config.developer_instructions", "standalone"], ["model_switch.instructions", "merged"],
] as const) test(`derived native prefix retains ${kind} and compares its payload`, () => {
  const parsed = request("new-turn");
  const raw = parsed._rawBody as CapturedRequest["body"];
  const developer = raw.input.find(item => item.role === "developer"
    && item.content?.some((part: any) => part.text?.includes("DEVELOPER_MARKER")))!;
  const prior = previous();
  const part = { type: "input_text", text: "NATIVE_EXTRA_MARKER: Keep this instruction." };
  let prefix = developer;
  if (layout === "standalone") {
    prefix = { type: "message", role: "developer", id: "native-prefix", content: [part],
      internal_chat_message_metadata_passthrough: { turn_id: prior.nativeTurnId, content_item_kinds: [kind] } };
    raw.input.splice(raw.input.indexOf(developer) + 1, 0, prefix);
  } else if (kind === "model_switch.instructions") {
    developer.content.unshift(part);
    developer.internal_chat_message_metadata_passthrough.content_item_kinds.unshift(kind);
  } else {
    developer.content.push(part);
    developer.internal_chat_message_metadata_passthrough.content_item_kinds.push(kind);
  }
  const selected = continuityCurrentInstructionInput(parsed, prior);
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  expect(JSON.stringify(selected)).toContain("NATIVE_EXTRA_MARKER");
  expect(selected.find(item => (item as { id?: string }).id === prefix.id)).toEqual(prefix);
  expect(selected.map(item => (item as { id?: string }).id)).toEqual(layout === "standalone"
    ? ["item_2", "item_3", "native-prefix", "item_4", "item_12"]
    : ["item_2", "item_3", "item_4", "item_12"]);
  const baseline = chatGptContinuityInstructionPayloadDigest(parsed, prior);
  part.text = "Changed required native instruction.";
  expect(chatGptContinuityInstructionPayloadDigest(parsed, prior)).not.toBe(baseline);
});

test("real Codex compact continuation retains the base prefix and the complete current AGENTS group", () => {
  const parsed = request("continue");
  const raw = parsed._rawBody as CapturedRequest["body"];
  const checkpointIndex = raw.input.findIndex(item => item.type === "compaction");
  expect(checkpointIndex).toBeGreaterThan(0);
  const source = request("new-turn");
  const selected = continuityCurrentInstructionInput(parsed, {
    instructionIdentity: continuityInstructionIdentity(source), nativeTurnId: extractChatGptTurnIdentity(source).turnId,
    trustedLowerBound: checkpointIndex,
  });
  expect(JSON.stringify(selected)).toContain("SYSTEM_MARKER");
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  expect(JSON.stringify(selected)).toContain("# AGENTS.md instructions");
  expect(JSON.stringify(selected)).toContain("CONTINUE_MARKER");
  expect(JSON.stringify(selected)).not.toContain("ORDINARY_MARKER");
  expect(JSON.stringify(selected)).not.toContain("NEW_TURN_MARKER");
});

test("synthetic deletion of old history keeps the real client's complete owned new-turn input", () => {
  const parsed = request("new-turn");
  const raw = parsed._rawBody as CapturedRequest["body"];
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  raw.input = raw.input.filter(item => item.role === "developer" || item.role === "system"
    || item.type === "additional_tools" || item.internal_chat_message_metadata_passthrough?.turn_id === turnId);
  const selected = continuityCurrentInstructionInput(parsed, previous());
  expect(JSON.stringify(selected)).toContain("SYSTEM_MARKER");
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  expect(JSON.stringify(selected)).toContain("NEW_TURN_MARKER");
  expect(JSON.stringify(selected)).not.toContain("ORDINARY_MARKER");
});

test("real Codex steering retains the current window's persistent developer and AGENTS group", () => {
  const steering = capture.captured.filter(value => value.label === "steering" && !value.replay);
  const parsed = parseRequest({ ...structuredClone(steering[1]!.body), model: "gpt-5.6-sol" });
  parsed._conversationPolicy = "continuity-first";
  const first = parseRequest({ ...structuredClone(steering[0]!.body), model: "gpt-5.6-sol" });
  first._conversationPolicy = "continuity-first";
  const selected = continuityCurrentInstructionInput(parsed, {
    instructionIdentity: continuityInstructionIdentity(first), nativeTurnId: extractChatGptTurnIdentity(first).turnId,
    trustedLowerBound: steering[1]!.body.input.findIndex(item => item.type === "compaction"),
  });
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  expect(JSON.stringify(selected)).toContain("AGENTS_MARKER");
  const currentId = continuityInstructionIdentity(parsed);
  expect(selected.some(item => (item as { id?: string }).id === currentId)).toBe(true);
  expect(selected.some(item => (item as { id?: string }).id === continuityInstructionIdentity(first))).toBe(false);
});

for (const withAgents of [true, false]) test(withAgents
  ? "real API-key continuation preserves the complete untagged native window group"
  : "derived API-key continuation accepts a complete native window with only environment context", () => {
  const api = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol-api-key.json"), "utf8")) as typeof capture;
  const continued = api.captured.find(value => value.label === "continue" && !value.replay)!;
  const source = parseRequest({ ...structuredClone(api.captured.find(value => value.label === "new-turn")!.body), model: "gpt-5.6-sol" });
  source._conversationPolicy = "continuity-first";
  const body = structuredClone(continued.body);
  if (!withAgents) {
    for (const item of body.input) {
      if (item.content?.some?.((part: any) => part.text?.startsWith("<environment_context>"))) {
        item.content = item.content.filter((part: any) => !part.text?.startsWith("# AGENTS.md instructions"));
      }
    }
  }
  const parsed = parseRequest({ ...body, model: "gpt-5.6-sol" });
  parsed._conversationPolicy = "continuity-first";
  const checkpointIndex = continued.body.input.findIndex(item => item.content?.some?.((part: any) => part.text?.startsWith("Another language model")));
  expect(checkpointIndex).toBeGreaterThan(0);
  const selected = continuityCurrentInstructionInput(parsed, {
    instructionIdentity: continuityInstructionIdentity(source), nativeTurnId: extractChatGptTurnIdentity(source).turnId,
    trustedLowerBound: checkpointIndex,
  });
  expect(JSON.stringify(selected)).toContain("SYSTEM_MARKER");
  expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
  if (withAgents) expect(JSON.stringify(selected)).toContain("AGENTS_MARKER");
  else expect(JSON.stringify(selected)).not.toContain("AGENTS_MARKER");
  expect(JSON.stringify(selected)).toContain("CONTINUE_MARKER");
  expect(JSON.stringify(selected)).not.toContain("NEW_TURN_MARKER");
});
