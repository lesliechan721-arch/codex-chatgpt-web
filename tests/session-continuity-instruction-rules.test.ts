import { expect } from "bun:test";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { continuityCurrentInstructionInput } from "../src/adapters/chatgpt-web/environment";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { performanceTest } from "./helpers/performance-test";

const test = performanceTest(import.meta.path);

// The selected predecessor is input to the production rule. These cases do not
// claim a persisted checkpoint or grant a writer; Adapter tests retain that boundary.
for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) for (const trailing of [false, true]) {
  test(`instruction rules: ${manual ? "Zero Risk" : "Automatic"} ${entry} rejects ${trailing ? "trailing" : "leading"} anonymous current instruction`, () => {
    const first = { type: "message", role: "user", id: "msg-turn-first", content: "First continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
    const current = { type: "message", role: "user", id: "current-task", content: "Current task.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } };
    const anonymous = { type: "message", role: "user", content: "Required current constraint without identity." };
    const base = entry === "initial" ? [] : entry === "ordinary" ? [first,
      { type: "message", role: "assistant", content: "Completed response 1." }]
      : [{ type: "compaction", encrypted_content: encodeCompactionSummary("Committed checkpoint summary.") }];
    const previous = entry === "initial" ? undefined : {
      instructionIdentity: "msg-turn-first", nativeTurnId: "turn-first",
      ...(entry === "checkpoint" ? { trustedLowerBound: 0 } : {}),
    };
    const request = (input: unknown[]) => {
      const parsed = parseRequest({ model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol", stream: false,
        input, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-instruction-rules", turn_id: "turn-next" }) } });
      parsed._conversationPolicy = "task";
      return parsed;
    };
    const input = [...base, ...(trailing ? [current, anonymous] : [anonymous, current])];
    expect(() => continuityCurrentInstructionInput(request(input), previous)).toThrow(expect.objectContaining({ code: "continuity_source_unproven" }));
    const changed = input.map(item => item === anonymous ? { ...anonymous, content: "Conflicting anonymous constraint." } : item);
    expect(() => continuityCurrentInstructionInput(request(changed), previous)).toThrow(expect.objectContaining({ code: "continuity_source_unproven" }));
    expect(continuityCurrentInstructionInput(request([...base, current]), previous)).toEqual([current]);
  });
}
