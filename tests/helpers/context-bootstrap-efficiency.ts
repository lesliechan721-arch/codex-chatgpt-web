import { parseRequest } from "../../src/responses/parser";
import { CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL } from "../../src/chatgpt-web-models";

/** Fixed, public stress inputs. Unknown assistant metadata deliberately stays required.
 * Defined before the pagination A/B run; these are not captured HTTP requests. */
export function bootstrapEfficiencyFixture(pairs: 46 | 105) {
  const input: unknown[] = [{ role: "user", content: "Inspect the recorded evidence. Preserve all requirements.\n" }];
  for (let index = 0; index < pairs; index++) input.push(
    { type: "function_call", call_id: `call-${index}`, name: "recorded_tool", arguments: JSON.stringify({ index }) },
    { type: "function_call_output", call_id: `call-${index}`, output: index % 3 === 0 ? "OK\t  \n"
      : `Source ${index}: 中文🙂 \\n\n`.repeat(300) },
    { type: "message", role: "assistant", phase: "commentary",
      internal_chat_message_metadata_passthrough: { turn_id: `turn-${index}`, content_item_kinds: ["unknown"] },
      content: [{ type: "output_text", text: `Evidence ${index}: preserve original order. 中文🙂\n`.repeat(35) }] },
  );
  input.push({ role: "user", content: "Apply the exact earlier design.\nApply the exact earlier design.\n" });
  return parseRequest({ model: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, reasoning: { effort: "low" },
    instructions: "Preserve user requirements and read the exact earlier design before acting.\n".repeat(300), input });
}
