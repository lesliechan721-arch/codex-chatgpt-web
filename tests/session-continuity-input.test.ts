import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { parseRequest } from "../src/responses/parser";
import { assertContinuityCompiledInput, preflightContinuityInput } from "../src/adapters/chatgpt-web/continuity-input";
import * as tokens from "../src/adapters/chatgpt-web/input-tokens";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
for (const manual of [false, true]) {
  const modelId = manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol";
  const request = () => parseRequest({
    model: modelId,
    reasoning: { effort: "low" }, input: "Continue the authorized task.",
  });
  test(`${manual ? "manual" : "automatic"} initial input leaves capacity for the unknown real capability`, () => {
    const parsed = request();
    const { contextWindow } = resolveChatGptWebContextLimits(modelId, "low", capabilities);
    const inputEstimate = spyOn(tokens, "estimateCompiledChatGptWebInputTokens").mockReturnValue(contextWindow - 1);
    const messageEstimate = spyOn(tokens, "estimateCompiledChatGptWebMessageTokens").mockReturnValue(1);
    try {
      // A real compiled prompt at this exact count is legal. A preflight placeholder cannot
      // consume the last token and assume the not-yet-issued random capability costs the same.
      const compiled = compileChatGptWebPrompt(parsed, capabilities,
        `${manual ? "request" : "turn"}_${randomBytes(24).toString("base64url")}`,
        manual ? { manualControl: true } : {});
      expect(() => assertContinuityCompiledInput(compiled, parsed, capabilities)).not.toThrow();
      expect(() => preflightContinuityInput(parsed, capabilities)).toThrow();
    } finally { inputEstimate.mockRestore(); messageEstimate.mockRestore(); }
  });

  test(`${manual ? "manual" : "automatic"} byte reserve covers real 32-character capability variants`, () => {
    const parsed = request();
    const placeholder = `${manual ? "request" : "turn"}_${"0".repeat(32)}`;
    const options = manual ? { manualControl: true as const } : {};
    const initial = compileChatGptWebPrompt(parsed, capabilities, placeholder, options);
    const budget = tokens.estimateCompiledChatGptWebInputTokens(initial, parsed.modelId) + placeholder.length + 8;
    for (let index = 0; index < 32; index++) {
      const actual = compileChatGptWebPrompt(parsed, capabilities,
        `${manual ? "request" : "turn"}_${randomBytes(24).toString("base64url")}`, options);
      expect(actual.text.length).toBe(initial.text.length);
      expect(tokens.estimateCompiledChatGptWebInputTokens(actual, parsed.modelId)).toBeLessThanOrEqual(budget);
    }
  });
}
