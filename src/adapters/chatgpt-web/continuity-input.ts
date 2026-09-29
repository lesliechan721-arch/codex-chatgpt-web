import {
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest } from "../../types";
import { assertChatGptWebInputWithinLimits, chatGptPromptFilePayloads } from "./browser-worker";
import { continuityError } from "./continuity-errors";
import { estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "./input-tokens";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import {
  CHATGPT_MAX_INPUT_IMAGES, compileChatGptWebPrompt, countChatGptContextImages,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/** Validate the selected message only. Canonical history remains intact for usage and replay. */
export function assertContinuityCompiledInput(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  capabilityReserveTokens = 0,
): void {
  try {
    if (compiled.multipart || countChatGptContextImages(parsed.context.messages) > CHATGPT_MAX_INPUT_IMAGES) {
      throw continuityError("continuity_input_limit");
    }
    const inputTokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) + capabilityReserveTokens;
    if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
      const { contextWindow } = resolveChatGptWebContextLimits(parsed.modelId, "low", capabilities);
      if (compiled.text.length > 1_000_000 || inputTokens >= contextWindow) throw continuityError("continuity_input_limit");
      return;
    }
    // Use the existing byte/count checks as well as the original model/composer boundaries.
    // Nothing is uploaded here; the returned buffers are not retained by the preflight.
    chatGptPromptFilePayloads(compiled);
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
    assertChatGptWebInputWithinLimits(
      inputTokens, estimateCompiledChatGptWebMessageTokens(compiled, parsed.modelId) + capabilityReserveTokens,
      parsed.modelId, mode.effort, capabilities, compiled.text.length,
    );
  } catch {
    throw continuityError("continuity_input_limit");
  }
}

export function preflightContinuityInput(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
  retainedContinuity = false,
): void {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const placeholder = `${manual ? "request" : "turn"}_${"0".repeat(32)}`;
  const compiled = compileChatGptWebPrompt(parsed, capabilities, placeholder, {
      ...(manual ? { manualControl: true } : { experimentalSkillAttachments }),
      ...(retainedContinuity ? { retainedContinuity: true } : {}),
    });
  // Both Broker capabilities have 32 base64url characters. Charge each entire ASCII token
  // again, plus its short JSON/text boundary, rather than assuming zero runs tokenize like
  // random capability text. The real prompt is still checked before any browser submission.
  const occurrences = compiled.text.split(placeholder).length - 1;
  assertContinuityCompiledInput(compiled, parsed, capabilities, occurrences * (placeholder.length + 8));
}
