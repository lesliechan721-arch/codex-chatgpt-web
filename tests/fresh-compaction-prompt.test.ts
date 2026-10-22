import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { CompactionSourceCoverage, prepareFreshCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { assertContinuityCompiledInput } from "../src/adapters/chatgpt-web/continuity-input";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { compileChatGptWebPrompt, type CompiledChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

test("fresh and fallback Native compaction binds source reads to the configured plugin without business tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-fresh-prompt-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  let fresh: Awaited<ReturnType<typeof prepareFreshCompactionSource>> | undefined;
  try {
    const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [{ role: "user", content: "Summarize the completed migration." },
        { type: "function_call", call_id: "migration", name: "exec_command", arguments: '{"cmd":"inspect migration"}' },
        { type: "function_call_output", call_id: "migration", output: "The migration was already inspected." }] });
    parsed._compactionRequest = true;
    const snapshot = createContextSnapshot(parsed);
    const coverage = new CompactionSourceCoverage();
    coverage.prepare(snapshot, { historyRevision: 0, pageGeneration: "source-page", planId: "source-plan",
      bodyDigest: "a".repeat(64), manifestDigest: "b".repeat(64), pageTokens: 2_000, externalizedTargetIds: [] });
    coverage.markDelivered("source-plan");
    const appName = 'Custom "Migration" 插件';
    let admitted: CompiledChatGptWebPrompt | undefined;
    let selectedInput: CodexParsedRequest | undefined;
    fresh = await prepareFreshCompactionSource(parsed, broker, capabilities, {
      historyRevision: 0, ownerGeneration: "fresh-page", traceId: "fresh-prompt", sourceCoverage: coverage,
      contextPresentation: { appName },
      assertFullInput(compiled, input) {
        assertContinuityCompiledInput(compiled, input, capabilities);
        admitted = compiled;
        selectedInput = input;
      },
    });
    expect(selectedInput!.context.tools).toEqual([]);
    // Match the Native read-only branch in index.ts: a connector is attached for
    // source navigation while localToolsEnabled remains false and no turn token exists.
    const submitted = compileChatGptWebPrompt(selectedInput!, capabilities, undefined, { appName, compactionReadOnly: true });
    expect(submitted.text).toContain(`The selected local Codex plugin for this turn is ${JSON.stringify(appName)}.`);
    expect(submitted.text).toContain("Do not substitute another plugin for this local connection or send this turn's request identifiers to another plugin");
    expect(submitted.text).toContain("The compaction_token belongs only to this selected plugin. Never send it to another plugin.");
    expect(submitted.text).toContain("codex_context_list");
    expect(submitted.text).toContain("compaction_token");
    expect(submitted.text).toContain("Use only the three context reading tools with the independent compaction credential");
    expect(submitted.text).toContain("Do not execute business or ChatGPT-native tools");
    expect(submitted.text).not.toContain("For local work required by the task");
    expect(submitted.text).not.toContain("Pass turn_token");
    expect(submitted.turnToken).toBeUndefined();
    expect(admitted!.text).toBe(submitted.text);
    expect(estimateChatGptWebInputTokens(selectedInput!, capabilities, { appName, compactionReadOnly: true }))
      .toBe(estimateCompiledChatGptWebInputTokens(submitted, parsed.modelId));
    expect(estimateCompiledChatGptWebInputTokens(admitted!, parsed.modelId))
      .toBeGreaterThan(estimateChatGptWebInputTokens(selectedInput!, capabilities));
    expect(() => compileChatGptWebPrompt(selectedInput!, capabilities, `turn_${"a".repeat(32)}`, { appName, compactionReadOnly: true }))
      .toThrow("must not receive a local-tool capability token");
  } finally {
    await fresh?.cleanup();
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary browser-only input keeps its plugin-free capability contract", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Explain the supplied evidence." }] });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { appName: "Unavailable Local Plugin" });
  expect(compiled.text).not.toContain("Unavailable Local Plugin");
  expect(compiled.text).not.toContain("The selected local Codex plugin");
  expect(compiled.text).toContain("no local Codex bridge attached");
});
