import { expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../../src/adapters/chatgpt-web/browser-worker";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityLease } from "../../src/adapters/chatgpt-web/continuity-contract";
import { ContinuityRegistrationStore } from "../../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../../src/adapters/chatgpt-web/continuity-recovery-store";
import { callTurnBroker, TurnBroker } from "../../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../../src/adapters/chatgpt-web/turn-execution";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../../src/launcher-browser-host";
import { CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint, defaultConfig } from "../../src/config";
import { compactRequest, responseRequest } from "../../src/server";
import type { CodexProviderConfig } from "../../src/types";
import { createChatGptWebAdapter } from "./chatgpt-web-adapter";

/** Public route + actual Adapter/Broker; only the browser transport is simulated. */
export function retainedTaskFixture(experimentalBiggerContext = false) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-retained-task-"));
  const statePath = join(root, "continuity");
  const registrations = new ContinuityRegistrationStore(statePath);
  registrations.initialize();
  const store = new ContinuityRecoveryStore(statePath);
  const pages = new Map<string, { continuity: ContinuityLease; state: "running" | "ready" }>();
  const submissions: Array<{ turn: BrowserTurn; prompt: string }> = [];
  const processIdentity = continuityProcessInstance();
  // Protocol fixture identity does not prove that a real Launcher process exists.
  const launcherInstance = { pid: process.pid, startIdentity: processIdentity.startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : processIdentity.startIdentity, instanceId: "a".repeat(64) };
  const controlToken = "a".repeat(43);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${controlToken}`) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/v1/turn/continuity-capacity") return Response.json({ ok: true, executionProtocol: 1, available: true });
    const body = await request.json() as { conversationKey: string; expected: ContinuityLease; recovery?: unknown };
    if (path.startsWith("/v1/turn/continuity-") && body.recovery) {
      const retired = path.endsWith("retire");
      const preparing = path.endsWith("prepare");
      return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, launcherInstance,
        ...(preparing ? { preparationExpected: body.expected } : {}),
        state: retired ? "retired" : preparing ? "prepared" : "send-possible",
        writerRetired: retired, executionIsolated: retired, physicalCleanup: retired ? "destroyed" : "pending",
        toolsSettled: false, sendAuthorized: true, hostNoWriter: retired });
    }
    const page = pages.get(body.conversationKey);
    const matches = page && JSON.stringify(page.continuity) === JSON.stringify(body.expected);
    if (path === "/v1/turn/release") {
      if (matches) pages.delete(body.conversationKey);
      return Response.json({ ok: true, released: matches ? 1 : 0 });
    }
    return matches ? Response.json({ ok: true, ...page }) : Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid, launcherInstance,
    features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE],
    endpoint: `http://127.0.0.1:${server.port}`, control: { endpoint: `http://127.0.0.1:${server.port}`, token: controlToken },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-dev-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `fixture://${root}`, chatgptWeb: {
    browserHost: "launcher", browserHostDescriptorPath: descriptorPath, browserInteractionMode: "automatic",
    appName: CHATGPT_CONNECTOR_NAME, continuityStateDirectory: statePath, brokerSocketPath: defaultBrokerEndpoint(root),
    localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false,
    toolAuthorityMode: "delegated", experimentalBiggerContext,
  } };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const compatible = spyOn(worker, "assertContinuityCompatible").mockResolvedValue();
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  const ordinaryFinal = "Completed ordinary answer before compaction.";
  const summary = "Public task checkpoint with its completed ordinary answer.";
  const automatic = spyOn(worker, "run").mockImplementation(async turn => {
    const claim = turn.continuity!;
    const old = pages.get(turn.conversationKey!);
    if (claim.expected) expect(old).toEqual({ continuity: claim.expected, state: "ready" });
    const lease: ContinuityLease = { owner: claim.owner, traceId: turn.traceId,
      leaseId: old?.continuity.leaseId ?? "1".repeat(32), ...(claim.recovery ? { recovery: claim.recovery } : {}) };
    pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const prepared = await (turn.requireRetainedConversation ? turn.prepareResume!() : turn.prepare());
    if (prepared.contextPlan) await turn.onContextPlanSelected!(prepared.contextPlan.planId);
    submissions.push({ turn, prompt: prepared.text });
    await turn.onSendActivated?.();
    await turn.onSubmitted?.();
    try {
      if (turn.nativeConnector) {
        expect(turn.capabilities.localToolsEnabled).toBe(false);
        const token = prepared.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
        const handoffId = prepared.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
        expect(token).toBeDefined(); expect(handoffId).toBeDefined();
        await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary });
        await new Promise<void>(resolve => {
          if (turn.abortSignal?.aborted) resolve();
          else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "";
      }
      turn.onTextDelta(ordinaryFinal);
      return ordinaryFinal;
    } finally {
      prepared.release();
      pages.set(turn.conversationKey!, { continuity: lease, state: "ready" });
    }
  });
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const,
    browserInteractionMode: "automatic" as const, solAvailable: true, experimentalBiggerContext };
  const threadId = `thread-${root}`;
  const body = { model: "chatgpt-web/gpt-5.6-sol", stream: false, reasoning: { effort: "medium" },
    input: [{ type: "message", role: "user", id: "source-item", content: "Continue the original task.",
      internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "source-turn" }) } };
  const send = (value: unknown, compact = false) => {
    const incoming = new Request(`http://127.0.0.1/v1/responses${compact ? "/compact" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    const adapter = () => createChatGptWebAdapter(provider, { broker });
    return compact ? compactRequest(incoming, config, adapter) : responseRequest(incoming, config, adapter);
  };
  const dispose = async () => {
    chatGptTurnSessions.clear(); automatic.mockRestore(); taskUpdates.mockRestore(); compatible.mockRestore();
    await broker.close(); await server.stop(true); rmSync(root, { recursive: true, force: true });
  };
  return { root, statePath, registrations, store, pages, submissions, provider, config, body, threadId, ordinaryFinal, summary, send, dispose };
}
