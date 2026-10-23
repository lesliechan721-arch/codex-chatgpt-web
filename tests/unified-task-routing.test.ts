import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute, resolveChatGptWebHistoryLimits, resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { chatGptWebExecutionNamespace, chatGptWebLegacyExecutionScopes, createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptContinuityInstructionPayloadDigest, continuityInstructionIdentity } from "../src/adapters/chatgpt-web/turn-execution";
import { renderApiKeyCodexConfig } from "../src/api-key-codex-config";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function provider(): CodexProviderConfig {
  const root = mkdtempSync(join(tmpdir(), "cgw-task-routing-")); roots.push(root);
  return { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: {
    browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
    continuityStateDirectory: join(root, "task-state"), localToolsEnabled: true,
    solAvailable: true, toolAuthorityMode: "delegated", experimentalFreshConversationPerTurn: false,
  } };
}
function request(turn = "turn") {
  const parsed = parseRequest({ model: "chatgpt-web/gpt-6-sol", stream: false,
    reasoning: { effort: "high" }, _conversationPolicy: "recoverable",
    metadata: { conversationPolicy: "recoverable" },
    input: [{ type: "message", role: "user", id: `instruction-${turn}`, content: "Continue the accepted task.",
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: turn }) },
  });
  expect(parsed._conversationPolicy).toBeUndefined();
  routeChatGptWebRequest(parsed, { ...defaultConfig("full"), browserHost: "launcher", proAvailable: true });
  return parsed;
}

test("public route owns task policy and missing Launcher evidence cannot downgrade it", () => {
  const parsed = request();
  expect(parsed._conversationPolicy).toBe("task");
  const config = provider(); delete config.chatgptWeb!.browserHostDescriptorPath;
  expect(() => createChatGptWebAdapter(config)).toThrow("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  expect(parsed._conversationPolicy).toBe("task");
});

test("removed mode names cannot be exported into a new client configuration", () => {
  expect(() => renderApiKeyCodexConfig({ port: 17841, catalogPath: "/tmp/catalog.json",
    model: "chatgpt-web-continuity/gpt-6-sol", reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43),
  })).toThrow("chatgpt-web/gpt-6-sol");
});

test("an ordinary live owner without durable dispatch evidence cannot be adopted from client history", async () => {
  const sessions = new ChatGptTurnSessions();
  let complete!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { complete = resolve; });
  const source = request(); delete source._conversationPolicy;
  const session = sessions.getOrCreate("ordinary-owner", () => ({ mode: "read-only", browser,
    physicalSettlement: browser.then(() => {}), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: source, cancel: () => complete("Settled ordinary response."),
  }), "trace", "owner", "turn", "thread");
  expect(() => sessions.assertTaskAdoptionEvidence(request())).toThrow("durable execution-generation and dispatch evidence");
  expect(session.runtime.continuityBinding).toBeUndefined();
  complete("Settled ordinary response.");
  await session.physicalSettlement;
  await session.browserOutcome;
  expect(() => sessions.assertTaskAdoptionEvidence(request())).toThrow("terminal execution evidence");
  expect(() => sessions.assertTaskAdoptionEvidence(request("new-turn"))).not.toThrow();
  sessions.clear();
});

test("all public routes use the account and model history tier", () => {
  const capabilities = { ...defaultConfig("full"), browserHost: "launcher" as const, proAvailable: true, extraHighAvailable: true };
  expect(availableChatGptWebModelRoutes(capabilities)).toHaveLength(6);
  for (const slug of [...availableChatGptWebModelRoutes(capabilities).map(route => route.slug), "chatgpt-web/zero-risk", "chatgpt-web/zero-risk-pro"]) {
    const manual = slug.includes("zero-risk");
    const config = { ...capabilities, browserInteractionMode: manual ? "manual" as const : "automatic" as const,
      zeroRiskProEnabled: slug.endsWith("zero-risk-pro") };
    const route = requireChatGptWebModelRoute(slug, config);
    const window = slug === "chatgpt-web/zero-risk" || slug === "chatgpt-web/gpt-6-sol-instant" ? 300_000
      : slug === "chatgpt-web/gpt-6-sol" ? 500_000 : 600_000;
    expect(resolveChatGptWebHistoryLimits(route, config)).toMatchObject({ contextWindow: window, autoCompactTokenLimit: window * 0.9 });
    expect(resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
      route.interactionMode === "automatic" ? route.modelFamily : undefined).contextWindow).toBe(window);
  }
});

test("Fresh, timeout, and presentation changes do not alter execution identity", () => {
  const config = provider(); const namespace = chatGptWebExecutionNamespace(config);
  const changed = structuredClone(config);
  Object.assign(changed.chatgptWeb!, { experimentalFreshConversationPerTurn: true,
    experimentalSkillAttachments: true, headed: false, useSavedChats: true, turnTimeoutMs: 1000, proAvailable: true });
  expect(chatGptWebExecutionNamespace(changed)).toBe(namespace);
  const reordered = { ...config, chatgptWeb: Object.fromEntries(Object.entries(config.chatgptWeb!).reverse()) };
  expect(chatGptWebExecutionNamespace(reordered)).toBe(namespace);
  for (const change of [{ browserHostDescriptorPath: "/tmp/another-account.json" }, { toolAuthorityMode: "verified-environment" as const }, { appName: "another-connector" }]) {
    expect(chatGptWebExecutionNamespace({ ...config, chatgptWeb: { ...config.chatgptWeb, ...change } })).not.toBe(namespace);
  }
});

for (const fresh of [false, true]) test(`unknown legacy page clears its stop before configuration checks with Fresh=${fresh}`, async () => {
  const config = provider(); const parsed = request();
  const directory = config.chatgptWeb!.continuityStateDirectory!;
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory);
  const namespace = createHash("sha256").update(JSON.stringify({ baseUrl: config.baseUrl, chatgptWeb: config.chatgptWeb })).digest("hex");
  const scope = continuityDigest([namespace, parsed.modelId, parsed._chatgptModelFamily ?? null, parsed.options.reasoning ?? null]);
  const thread = continuityDigest("thread"); const work = continuityDigest("existing-work");
  store.admitWork({ thread, scope, owner: continuityProcessInstance(), logicalWorkId: work,
    instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: "turn",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(parsed), snapshotDigest: continuityDigest(parsed.context),
    createPage: true, dispatchProtocolComplete: true });
  store.stopWork(thread, { scope }, work, "user-stop");
  expect(store.get(thread)!.works[work]!.stopReason).toBe("user-stop");
  Object.assign(config.chatgptWeb!, { experimentalFreshConversationPerTurn: fresh });
  expect(chatGptWebLegacyExecutionScopes(config, parsed)).toContain(scope);
  // This routing fixture has no Launcher descriptor. The old stop must not hide
  // that current configuration error or survive as a future recovery gate.
  await expect(createChatGptWebAdapter(config).preflight!(parsed, { headers: new Headers() })).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(store.get(thread)).toBeUndefined();
});
