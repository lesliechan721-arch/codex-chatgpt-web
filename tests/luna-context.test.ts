import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { CHATGPT_LUNA_CHECKPOINT_MARKER, ChatGptLunaCheckpointStore, hashChatGptLunaAnswer } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CONTEXT_PROTOCOL_VERSION, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const browserOnly = { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false };
const full = { ...browserOnly, localToolsEnabled: true };
const model = "gpt-5.6-luna";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  chatGptTurnSessions.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function message(role: "user" | "assistant", text: string, turnId: string) {
  return { type: "message", id: `${turnId}-${role}`, role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId } };
}
function request(thread: string, turn: string, input: unknown[], effort = "low") {
  return parseRequest({ model, reasoning: { effort }, input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) } });
}
async function fixture(localToolsEnabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), "cgw-luna-context-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  await broker.listen();
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${root}`, chatgptWeb: {
    brokerSocketPath: broker.socketPath, lunaCheckpointStatePath: join(root, "checkpoint.json"),
    toolAuthorityMode: "delegated", localToolsEnabled, solAvailable: false, extraHighAvailable: false, proAvailable: false,
  } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  cleanups.push(async () => { taskUpdates.mockRestore(); await broker.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = createChatGptWebAdapter(provider, { broker });
  const run = async (parsed: ReturnType<typeof request>) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.find(event => event.type === "error")).toBeUndefined();
    expect(events.at(-1)?.type).toBe("done");
    return events.at(-1)! as Extract<AdapterEvent, { type: "done" }>;
  };
  return { root, broker, provider, worker, run };
}

for (const effort of ["low", "medium"] as const) test(`Full Luna ${effort} selects default navigation and keeps canonical usage above 180k`, async () => {
  const f = await fixture(true);
  const parsed = request(f.root, "current", [
    message("assistant", "OLD_ANSWER " + "word ".repeat(175_000), "previous"),
    message("user", "Apply the second option from the previous answer.", "current"),
  ], effort);
  const owner = await f.broker.register({ authorityMode: "delegated", threadId: f.root, turnId: "current", tools: [] });
  const send = new ContextSend(parsed, f.broker, full, "luna-default");
  try {
    const plan = await send.prepare(parsed, owner, {});
    expect(plan.navigationEnabled).toBe(true);
    expect(plan.compiled.text).not.toContain("OLD_ANSWER");
    expect(plan.compiled.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
    const usage = estimateChatGptWebUsage(parsed, {}, full);
    expect(usage.inputTokens).toBeGreaterThan(180_000);
    expect(usage.inputTokens).toBeGreaterThan(plan.costs.promptTokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
    expect(resolveChatGptWebContextLimits(model, effort, full)).toEqual({ contextWindow: 200_000, autoCompactTokenLimit: 180_000, effectiveContextWindowPercent: 90 });
    expect(resolveChatGptWebMessageTokenBudget(model, effort, full, 4096)).toBe(15_712);
  } finally { send.retire(); await f.broker.revoke(owner); }
}, 30_000);

for (const localTools of [false, true]) test(`Luna exact-parent checkpoint usage follows the configured capability (Full=${localTools})`, async () => {
  const f = await fixture(localTools);
  const old = message("user", "HISTORICAL_ORIGINAL " + "word ".repeat(5_000), "first");
  const answer = "Previous answer with the accepted plan.";
  const source = request(f.root, "first", [old]);
  const store = new ChatGptLunaCheckpointStore(f.provider.chatgptWeb!.lunaCheckpointStatePath);
  store.commit(source, { checkpoint: { version: 2, summary: "Accepted plan: inspect the remaining file." },
    answerHash: hashChatGptLunaAnswer(answer) }, answer);
  const parsed = request(f.root, "second", [old, message("assistant", answer, "first"), message("user", "Continue.", "second")]);
  let submitted = "";
  const run = spyOn(f.worker, "run").mockImplementation(async turn => {
    const compiled = await turn.prepare();
    submitted = compiled.text;
    expect(turn.captureLunaCheckpoint).toBe(localTools ? undefined : true);
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    await turn.onSendActivated?.();
    await turn.onSubmitted?.();
    turn.onTextDelta("Continued.");
    return "Continued.";
  });
  cleanups.push(async () => { run.mockRestore(); });
  const done = await f.run(parsed);
  const projected = localTools ? parsed : store.apply(parsed).parsed;
  expect(done.usage).toEqual(estimateChatGptWebUsage(projected, { answer: "Continued.", reasoning: [] }, localTools ? full : browserOnly));
  if (localTools) expect(submitted).not.toContain("Compressed Luna task history");
  else expect(submitted).toContain("Compressed Luna task history");
  if (!localTools) {
    expect(submitted).not.toContain("HISTORICAL_ORIGINAL");
    expect(done.usage!.inputTokens).toBeLessThan(estimateChatGptWebUsage(parsed, {}, browserOnly).inputTokens);
  }
});

test("Full Luna compacts without a Launcher through an independent read-only source", async () => {
  const f = await fixture(true);
  const parsed = request(f.root, "source-turn", [message("user", "SOURCE_ORIGINAL Preserve this recorded evidence.", "source-turn")]);
  let compactionToken: string | undefined;
  const run = spyOn(f.worker, "run").mockImplementation(async turn => {
    const compiled = await turn.prepare();
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    await turn.onSendActivated?.();
    await turn.onSubmitted?.();
    if (turn.compaction) {
      expect(turn.capabilities.localToolsEnabled).toBe(false);
      expect(turn.nativeConnector).toBe(true);
      expect(turn.captureLunaCheckpoint).toBeUndefined();
      expect(compiled.turnToken).toBeUndefined();
      expect(compiled.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
      expect(compiled.text).not.toContain("SOURCE_ORIGINAL");
      expect(compiled.text).toContain("Do not execute business or ChatGPT-native tools");
      const visible = compiled.text.replaceAll("\\n", "\n").replaceAll('\\"', '"');
      const entry = JSON.parse(/<codex_context_navigation_json>\n([^\n]+)/.exec(visible)![1]!);
      compactionToken = entry.first_call.arguments.compaction_token;
      const reply = await callTurnBroker<ContextPreparedReply>(f.broker.socketPath, {
        method: "context_query", token: compactionToken, contract: "native", credentialKind: "compaction",
        contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "search",
        contextArgs: { context_id: entry.context_id, query: "SOURCE_ORIGINAL" },
      });
      const result = reply.result as BrokerToolResult;
      expect(JSON.stringify(result)).toContain("SOURCE_ORIGINAL");
      await callTurnBroker(f.broker.socketPath, { method: "context_return", token: compactionToken,
        contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION,
        receiptId: reply.receiptId, sent: true });
      turn.onTextDelta("Checkpoint preserves the recorded evidence.");
      return "Checkpoint preserves the recorded evidence.";
    }
    turn.onTextDelta("Source accepted.");
    return "Source accepted.";
  });
  cleanups.push(async () => { run.mockRestore(); });
  await f.run(parsed);
  const compact = structuredClone(parsed); compact._compactionRequest = true;
  await f.run(compact);
  expect(compactionToken).toBeDefined();
  expect(run).toHaveBeenCalledTimes(2);
  await expect(callTurnBroker(f.broker.socketPath, { method: "context_query", token: compactionToken,
    contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION,
    contextMethod: "list", contextArgs: { context_id: "retired", view: "overview" } })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
}, 30_000);
