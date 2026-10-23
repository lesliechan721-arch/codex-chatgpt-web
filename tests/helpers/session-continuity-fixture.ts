import { ContinuityRecoveryStore, continuityProcessInstance } from "../../src/adapters/chatgpt-web/continuity-recovery-store";
import { createRequire } from "node:module";
import { expect, spyOn } from "bun:test";
import { measureRuntimeOperation, measureRuntimeAsync, runtimePerformanceContext, withRuntimePerformanceContext } from "../../src/runtime-performance";
import { createContinuityMcpClient, type ContinuityMcpTransport } from "./continuity-mcp-client";
import { retainedFixtureCleanup } from "./retained-fixture-cleanup";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../../src/adapters/chatgpt-web/browser-worker";
import { continuityDigest, existingContinuityBindings } from "../../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityClaim, type ContinuityLease, type ContinuityLauncherInstance } from "../../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../../src/adapters/chatgpt-web/continuity-errors";
import { ContinuityRegistrationStore } from "../../src/adapters/chatgpt-web/continuity-registration";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "./chatgpt-web-adapter";
import type { NativeOperationReply } from "../../src/adapters/chatgpt-web/native-tool-operations";
import type { UserUpdate } from "../../src/adapters/chatgpt-web/task-update-protocol";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult, type BrokerToolRequest } from "../../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL } from "../../src/chatgpt-web-models";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint, defaultConfig } from "../../src/config";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LauncherKnownUnsentReceiptError } from "../../src/launcher-browser-host";
import { compactRequest, responseRequest } from "../../src/server";
import { parseRequest } from "../../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../../src/types";
import { parseContextTextReadResult } from "../../src/adapters/chatgpt-web/context-text-result";

// The fixture model completes the published required chain before business work.
// Tests can supply contextModel to inspect or delay that delivery themselves.
const require = createRequire(import.meta.url);
const deliveredEnvelopes = new Map<string, unknown>();
const deliveredStartupText = new Map<string, string>();
const startupReads = new Map<string, Promise<unknown>>();

export const launcherRecovery = require("../../launcher/electron/continuity-recovery.cjs");

export const launcherLease = require("../../launcher/electron/continuity-lease.cjs");

export const launcherAuthority = require("../../launcher/electron/continuity-execution-authority.cjs");

export interface ContinuityContextModelInput {
  prompt: string;
  token: string;
  manual: boolean;
  client: Awaited<ReturnType<typeof createContinuityMcpClient>>["client"];
  broker: TurnBroker;
}

export function recordedCall(call: BrokerToolRequest): Record<string, unknown> {
  return call.freeform
    ? { type: "custom_tool_call", call_id: call.callId, name: call.wireName, input: call.input }
    : { type: "function_call", call_id: call.callId, name: call.wireName, arguments: JSON.stringify(call.arguments) };
}

export function currentRecordedCall(provider: CodexProviderConfig, request: CodexParsedRequest): Record<string, unknown> {
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(request)}`)!;
  return recordedCall(source.outstanding()[0]!);
}

export function taskEnvelope(prompt: string): unknown {
  if (deliveredEnvelopes.has(prompt)) return structuredClone(deliveredEnvelopes.get(prompt));
  return JSON.parse(/<codex_context_json>\n([^\n]+)/.exec(prompt)![1]!);
}

/** The visible entry and exact bodies returned by its completed public required chain. */
export function deliveredStartupSources(prompt: string): string {
  return deliveredStartupText.get(prompt) ?? prompt;
}

/** Uses the public MCP response and complete delivery receipts, never the planner's private payload. */
export async function readContinuityStartup(prompt: string, client: ContinuityContextModelInput["client"]): Promise<unknown> {
  const running = startupReads.get(prompt);
  if (running) return running;
  const read = readContinuityStartupOnce(prompt, client);
  startupReads.set(prompt, read);
  try { return await read; }
  finally { if (startupReads.get(prompt) === read) startupReads.delete(prompt); }
}

async function readContinuityStartupOnce(prompt: string, client: ContinuityContextModelInput["client"]): Promise<unknown> {
  const match = /<codex_bootstrap_json>\n([^\n]+)/.exec(prompt);
  if (!match) return taskEnvelope(prompt);
  const entry = JSON.parse(match[1]!);
  const credential = entry.first_call.arguments;
  const auth = credential.request_id ? { request_id: credential.request_id } : { turn_token: credential.turn_token };
  const first = await client.callTool(entry.first_call);
  expect(first.isError).not.toBe(true);
  const overviewCall = { name: "codex_context_list", arguments: {
    ...auth, context_id: credential.context_id ?? entry.context_id, view: "overview" } };
  const overview = (first.structuredContent as any).context_bootstrap ?? first.structuredContent;
  if (overview.live?.context_ready && deliveredEnvelopes.has(prompt)) return structuredClone(deliveredEnvelopes.get(prompt));
  let next = overview.next_required_read;
  const bodies = new Map<string, string>();
  let payloadRef: string | undefined;
  for (let count = 0; next; count++) {
    if (count > 2_000) throw new Error("The fixture required context chain did not end");
    const result = await client.callTool({ name: next.tool, arguments: { ...next.arguments, ...auth } });
    expect(result.isError).not.toBe(true);
    const parsed = parseContextTextReadResult(result);
    for (const [index, item] of parsed.metadata.items.entries()) {
      const previous = bodies.get(item.read_ref) ?? "";
      expect(item.range.start).toBe(Buffer.byteLength(previous));
      bodies.set(item.read_ref, previous + parsed.bodies[index]!);
      if (item.source.origin === "context_bootstrap_payload") payloadRef = item.read_ref;
    }
    expect(parsed.metadata.required_step).toBeDefined();
    next = parsed.metadata.required_step!.next_required_read;
  }
  const ready = await client.callTool(overviewCall);
  expect(ready.isError).not.toBe(true);
  expect(ready.structuredContent).toMatchObject({ live: { context_ready: true } });
  const inline = /<codex_inline_context_json>\n```json\n([\s\S]*?)\n```\n<\/codex_inline_context_json>/.exec(prompt)?.[1];
  const payload = JSON.parse(inline ?? bodies.get(payloadRef!)!);
  expect(payload.format).toBe("context-bootstrap-payload-v3");
  const value = structuredClone(payload.payload);
  const inlineRequestText = /<codex_inline_request_json>\n```json\n([\s\S]*?)\n```\n<\/codex_inline_request_json>/.exec(prompt)?.[1];
  const inlineRequest = inlineRequestText ? JSON.parse(inlineRequestText) : undefined;
  for (const position of payload.inline_request_positions ?? []) {
    expect(inlineRequest?.[position.inline_index]).toBeDefined();
    value[position.path[0]][position.path[1]] = inlineRequest[position.inline_index];
  }
  for (const position of payload.positions ?? []) {
    const reference = payload.references.find((unit: any) => unit.unit_id === position.unit_id);
    expect(reference.delivery).not.toBe("reuse");
    const body = payload.inline_units?.find((unit: any) => unit.unit_id === position.unit_id)?.body
      ?? bodies.get(reference.read_ref);
    expect(body).toBeDefined();
    let parent = value;
    for (const segment of position.path.slice(0, -1)) parent = parent[segment];
    parent[position.path.at(-1)] = JSON.parse(body);
  }
  deliveredEnvelopes.set(prompt, value);
  deliveredStartupText.set(prompt, [prompt, ...bodies.values()].join("\n"));
  return value;
}

export function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse().map(([key, child]) => [key, reverseJsonObjectKeys(child)]));
}

// Observed with Codex 0.158.0 against an isolated Responses stub: response-only
// status and output_text annotations are not serialized back into input history.
export function codexRoundtrippedOutput(output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return output.map(({ status: _status, ...item }) => {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content = item.content.map(({ annotations: _annotations, ...part }) => part);
    }
    return item;
  });
}

// Each test file owns its cleanup stack and supplies its helper descriptor path.
export function createSessionContinuityFixtures(testFilePath: string) {
  const cleanups: Array<() => Promise<void>> = [];
  const backendExits: Array<() => Promise<void>> = [];

  async function disposeTestFixtures(): Promise<void> {
    const errors: unknown[] = [];
    for (const exit of backendExits.splice(0).reverse()) {
      try { await exit(); } catch (error) { errors.push(error); }
    }
    chatGptTurnSessions.clear();
    deliveredEnvelopes.clear();
    deliveredStartupText.clear();
    startupReads.clear();
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Continuity fixture cleanup failed");
  }

  function fixture(...args: Parameters<typeof createFixture>) {
    const mode = args[0] ? args[1]?.mcpTransport === "in-process" ? "manual-in-process" : "manual" : "automatic";
    return withRuntimePerformanceContext({ ...runtimePerformanceContext(), fixtureMode: mode },
      () => measureRuntimeOperation("fixture.prepare", () => createFixture(...args)));
  }

  function createFixture(manual = false, options: { codexHome?: string; threadId?: string; turnTimeoutMs?: number; taskUpdates?: boolean; root?: string; waitForRetirement?: boolean; launcherInstance?: ContinuityLauncherInstance; cleanupMode?: "release-page" | "backend-exit"; mcpTransport?: ContinuityMcpTransport;
    zeroRiskPro?: boolean; reasoning?: "low" | "medium"; contextModel?: (input: ContinuityContextModelInput) => Promise<void> } = {}) {
    const profileContext = runtimePerformanceContext();
    const root = options.root ?? mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-adapter-"));
    const statePath = join(root, "continuity");
    const registrations = measureRuntimeOperation("fixture.store", () => {
      const store = new ContinuityRegistrationStore(statePath); store.initialize(); return store;
    });
    const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
    const submissions: Array<{ prompt: string; turnToken?: string; claim: ContinuityClaim; key: string; reused: boolean }> = [];
    // Fixture identity has the protocol shape; it is not evidence of a real Launcher process.
    const launcherInstance = options.launcherInstance ?? { pid: process.pid, startIdentity: continuityProcessInstance().startIdentity === "unverified"
      ? "darwin:Sat Oct 10 00:00:00 2026" : continuityProcessInstance().startIdentity, instanceId: "a".repeat(64) };
    const recoveryHost = { continuityLauncherInstance: launcherInstance, turnTabs: new Map<string, any>(),
      removeTurnTab: (tab: any) => { tab.destroyed = true; recoveryHost.turnTabs.delete(tab.id); } };
    const server = measureRuntimeOperation("fixture.http", () => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/v1/turn/continuity-capacity") {
          await controls.onCapacityQuery?.();
          return Response.json({ ok: true, executionProtocol: 1, available: controls.capacityAvailable });
        }
        const body = await request.json() as { conversationKey: string; expected: ContinuityLease; recovery?: ContinuityClaim["recovery"]; recoveryStoreDirectory?: string };
        if (new URL(request.url).pathname === "/v1/turn/start") {
          const start = body as unknown as { conversationKey: string; traceId: string; continuity: ContinuityClaim; requireRetainedConversation?: boolean };
          controls.helperStarts++;
          const continuity = accept(start.conversationKey, start.continuity, start.traceId, start.requireRetainedConversation);
          return Response.json({ ok: true, executionProtocol: 1, surfaceId: "a".repeat(32),
            reused: Boolean(start.requireRetainedConversation), connectorBound: true, continuity });
        }
        if (new URL(request.url).pathname === "/v1/turn/end" || new URL(request.url).pathname === "/v1/turn/heartbeat") {
          if (new URL(request.url).pathname.endsWith("end")) controls.helperEnds++;
          return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, cancelledByUser: controls.helperUserClosed });
        }
        if (new URL(request.url).pathname.startsWith("/v1/turn/continuity-") && body.recovery) {
          if (new URL(request.url).pathname === "/v1/turn/continuity-terminate-preparation") {
            const record = new ContinuityRecoveryStore(statePath).get(body.recovery.threadKey);
            const termination = record?.works[body.recovery.logicalWorkId]?.attempts[body.recovery.attempt]?.preparationTermination;
            const page = termination && [...pages.values()].find(value => continuityDigest(value.continuity) === continuityDigest(termination.lease));
            if (!termination || !page) return Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
            if (controls.terminationConfirmFailures-- > 0) return Response.json({ ok: false, code: "continuity_unverified" }, { status: 503 });
            page.state = "ready";
            return Response.json({ ok: true, state: "preparation-terminated", recovery: body.recovery, requestId: termination.requestId,
              receiptId: termination.receiptId, traceId: termination.traceId, helperPid: termination.helperPid, continuity: page.continuity });
          }
          if (controls.actualRecovery) {
            try {
              launcherAuthority.bindExecutionAuthority(recoveryHost, body.recovery, body.recoveryStoreDirectory);
              const path = new URL(request.url).pathname;
              if (path.endsWith("prepare") && controls.prepareBeforeFailures-- > 0) return Response.json({ ok: false }, { status: 503 });
              const receipt = path.endsWith("retire") ? await launcherRecovery.retireContinuityWriter(recoveryHost, body.recovery)
                : path.endsWith("send-possible") ? launcherRecovery.markContinuitySendPossible(recoveryHost, body.recovery)
                : path.endsWith("prepare") ? launcherRecovery.updateContinuityPreparation(recoveryHost, body.expected, body.recovery)
                : launcherRecovery.queryContinuityTransaction(recoveryHost, body.recovery);
              if (path.endsWith("prepare") && controls.prepareAfterFailures-- > 0) return Response.json({ ok: false }, { status: 503 });
              return Response.json({ ok: true, ...receipt });
            } catch (error) { return Response.json({ ok: false, code: (error as { code?: string }).code }, { status: 409 }); }
          }
          const retired = new URL(request.url).pathname.endsWith("retire");
          const preparing = new URL(request.url).pathname.endsWith("prepare");
          const queriedPage = controls.queryIncludesContinuity && new URL(request.url).pathname.endsWith("query")
            ? [...pages.values()].find(page => continuityDigest(page.continuity.recovery) === continuityDigest(body.recovery)) : undefined;
          if (retired && controls.retirementCleanup === "destroyed") {
            for (const [key, page] of pages) if (continuityDigest(page.continuity.recovery) === continuityDigest(body.recovery)) pages.delete(key);
          }
          return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, ...(preparing ? { preparationExpected: body.expected } : {}),
            ...(queriedPage ? { continuity: queriedPage.continuity } : {}), launcherInstance, hostNoWriter: retired || controls.queryPhase === "missing", state: retired ? "retired" : preparing ? "prepared" : new URL(request.url).pathname.endsWith("query") ? controls.queryPhase : "send-possible", writerRetired: retired, executionIsolated: retired, physicalCleanup: retired ? controls.retirementCleanup : "pending", toolsSettled: false, sendAuthorized: true });
        }
        if (new URL(request.url).pathname === "/v1/turn/continuity" && controls.completionInspection) {
          const record = new ContinuityRecoveryStore(statePath).get(continuityDigest(threadId));
          if (record?.currentWorkId && record.works[record.currentWorkId]?.state === "completed") {
            const inspection = controls.completionInspection;
            controls.completionInspection = undefined;
            inspection.entered();
            await inspection.release;
          }
        }
        if (controls.inspectFailures > 0 && new URL(request.url).pathname !== "/v1/turn/release") {
          controls.inspectFailures--;
          return Response.json({ ok: false, code: "continuity_unverified" }, { status: 503 });
        }
        const page = pages.get(body.conversationKey);
        const matches = page && JSON.stringify(page.continuity) === JSON.stringify(body.expected);
        if (new URL(request.url).pathname === "/v1/turn/release") {
          if (matches) pages.delete(body.conversationKey);
          return Response.json({ ok: true, released: matches ? 1 : 0 });
        }
        return matches ? Response.json({ ok: true, ...page }) : Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
      },
    }));
    cleanups.push(() => withRuntimePerformanceContext(profileContext, () => measureRuntimeAsync("fixture.cleanup", async () => {
      await measureRuntimeAsync("cleanup.http", () => server.stop(true));
      if (!options.root) rmSync(root, { recursive: true, force: true });
    })));
    const descriptorPath = join(root, "launcher.json");
    const descriptor = {
      version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: launcherInstance.pid,
      launcherInstance,
      features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
      control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
      helper: { executable: process.execPath, script: testFilePath },
      partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
    };
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `fixture://${root}`,
      chatgptWeb: { maxComposerCodePoints: 64_000_000,
        browserInteractionMode: manual ? "manual" : "automatic",
        browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
        ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
        appName: manual ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME,
        brokerSocketPath: defaultBrokerEndpoint(root), continuityStateDirectory: statePath,
        localToolsEnabled: true, solAvailable: !manual, proAvailable: false, extraHighAvailable: false,
        toolAuthorityMode: "delegated", zeroRiskRequireSentConfirmation: true,
      },
    };
    const broker = measureRuntimeOperation("fixture.broker", () => TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!));
    // Ordinary lifecycle cases consume the public startup chain without reuse.
    // Reuse cases supply a model that verifies their versioned reuse receipts.
    const reuseSupport = options.contextModel ? undefined : spyOn(broker, "contextReuseAvailable").mockReturnValue(false);
    let modelMcp: Awaited<ReturnType<typeof createContinuityMcpClient>> | undefined;
    let modelMcpConnection: Promise<Awaited<ReturnType<typeof createContinuityMcpClient>>> | undefined;
    const manualMcp = async () => {
      modelMcpConnection ??= measureRuntimeAsync("fixture.mcp", () => createContinuityMcpClient({
        name: "continuity-model-fixture", contract: manual ? "safe" : "native",
        brokerSocketPath: provider.chatgptWeb!.brokerSocketPath!, transport: options.mcpTransport,
      }));
      modelMcp = await modelMcpConnection;
      return modelMcp.client;
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const compatible = spyOn(worker, "assertContinuityCompatible").mockResolvedValue();
    // Legacy lifecycle cases do not negotiate task updates. Regression cases opt in explicitly.
    const taskUpdatesSupport = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(options.taskUpdates === true);
    const originalAcceptTaskUpdate = broker.acceptTaskUpdate;
    if (manual && !options.taskUpdates) broker.acceptTaskUpdate = undefined as never;
    const controls = {
      helperStarts: 0, helperEnds: 0, helperUserClosed: false,
      capacityAvailable: true, inspectFailures: 0,
      retirementCleanup: "destroyed" as "destroyed" | "pending",
      emitReviewCommentary: false,
      reviewWireName: "exec_command",
      onCapacityQuery: undefined as (() => void | Promise<void>) | undefined,
      preLeaseFailures: 0, unknownPreLeaseFailures: 0, failAfterSendOnce: false, failAfterToolsOnce: false, failAfterToolsKeepPage: false,
      acquisitionFailures: 0, actualRecovery: false, actualAcquisitions: 0,
      prepareBeforeFailures: 0, prepareAfterFailures: 0,
      terminationConfirmFailures: 0,
      command: "fixture-command-not-executed-by-this-test",
      sourceArguments: undefined as Record<string, unknown> | undefined,
      queryPhase: "send-possible" as "send-possible" | "prepared" | "missing",
      queryIncludesContinuity: false,
      loseStartAcknowledgementOnce: false,
      failHandoffSettlement: false,
      endFailure: false, deferCompletion: false, safeToken: "", started: false,
      onStarted: undefined as (() => void) | undefined,
      completionInspection: undefined as { entered(): void; release: Promise<void> } | undefined,
      handoffSummary: "Verified checkpoint.", invokeSourceTools: false, singleSourceTool: false, parallelSourceTools: false,
      pauseAfterToolResults: false, repeatManualSourceTool: false, nativeSourceTools: false,
      sourceToken: "", toolResults: [] as BrokerToolResult[], modelTask: undefined as Promise<void> | undefined,
      acknowledgePendingUpdate: undefined as UserUpdate | undefined,
      releaseDeferredCompletion: undefined as (() => void) | undefined,
      releaseAfterToolResults: undefined as (() => void) | undefined,
  };
    const sourceTools = async (token: string) => {
      controls.sourceToken = token;
      const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
        provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
      let operationId = 0;
      const invoke = async (): Promise<BrokerToolResult> => {
        if (manual) {
          const client = await manualMcp();
          const reference = { request_id: token, operation_id: ++operationId, task_revision: 0 };
          let result = await client.callTool({ name: controls.nativeSourceTools ? "codex_exec" : "codex_tool_call",
            arguments: { ...reference, ...(controls.nativeSourceTools ? controls.sourceArguments ?? { cmd: controls.command }
              : { wire_name: controls.reviewWireName, arguments: controls.sourceArguments ?? { cmd: controls.command } }) } });
          while ((result.structuredContent as { kind?: string } | undefined)?.kind === "codex_native_pending") {
            result = await client.callTool({ name: "codex_tool_wait", arguments: { request_id: token, operation_id: operationId } });
          }
          const text = (result.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text).join("\n");
          const contextEntry = /<codex_context_navigation_json>\n([^\n]+)/.exec(text);
          if (contextEntry) expect((await client.callTool(JSON.parse(contextEntry[1]!).first_call)).isError).not.toBe(true);
          return result as BrokerToolResult;
        }
        if (controls.nativeSourceTools) {
          const reply = await callTurnBroker<NativeOperationReply>(provider.chatgptWeb!.brokerSocketPath!, {
            method: "native_operation_start", token, contract: manual ? "safe" : "native", nativeWaitProtocol: 1,
            ...(options.taskUpdates ? { taskUpdateProtocol: 1, taskRevision: 0 } : {}),
            operationId: ++operationId, entry: "codex_exec",
            nativeInput: controls.sourceArguments ?? { cmd: controls.command },
          }, null);
          if (reply.kind !== "result") throw new Error("Fixture operation did not receive its Native result");
          return reply.result;
        }
        return callTurnBroker<BrokerToolResult>(provider.chatgptWeb!.brokerSocketPath!, {
          method: "invoke", bindingId: claim.bindingId, wireName: controls.reviewWireName, freeform: false,
          registryGeneration: claim.environment.registryGeneration,
          arguments: controls.sourceArguments ?? { cmd: controls.command },
        }, null);
      };
      if (!manual && controls.parallelSourceTools && !controls.singleSourceTool) {
        controls.toolResults.push(...await Promise.all([invoke(), invoke()]));
      } else {
        controls.toolResults.push(await invoke());
        if ((!manual || controls.repeatManualSourceTool) && !controls.singleSourceTool) controls.toolResults.push(await invoke());
      }
      if (claim.activityId) await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
        method: "activity_complete", token, activityId: claim.activityId,
      });
    };
    const accept = (key: string, claim: ContinuityClaim, traceId: string, required: boolean | undefined) => {
      const previous = pages.get(key);
      if (claim.expected) {
        expect(required).toBe(true);
        expect(previous).toEqual({ continuity: claim.expected, state: "ready" });
      } else if (previous) {
        // An exact retry may arrive after Launcher created the page but its start acknowledgement
        // was lost. The same owner/trace reuses that provisional page instead of allocating one.
        expect(previous.continuity.owner).toBe(claim.owner);
        expect(previous.continuity.traceId).toBe(traceId);
      }
      const continuity: ContinuityLease = {
        owner: claim.owner, leaseId: previous?.continuity.leaseId ?? "1".repeat(32), traceId, ...(claim.recovery ? { recovery: claim.recovery } : {}),
      };
      pages.set(key, { continuity, state: "running" });
      return continuity;
    };
    const automatic = spyOn(worker, "run").mockImplementation(async (turn: BrowserTurn) => {
      if (manual) throw new Error("Zero Risk must not use the automatic worker");
      if (controls.actualRecovery) {
        launcherAuthority.bindExecutionAuthority(recoveryHost, turn.continuity!.recovery, turn.recoveryStoreDirectory);
        await launcherRecovery.acquireContinuityTransaction(recoveryHost, turn.continuity!, turn.traceId, process.pid,
          turn.conversationKey!, "automatic", () => {
            controls.actualAcquisitions++;
            if (controls.acquisitionFailures > 0) {
              controls.acquisitionFailures--;
              throw continuityError("continuity_unverified", "Actual acquisition callback failed.");
            }
            const tab: any = { id: turn.traceId, traceId: turn.traceId, helperPid: process.pid, status: "running", destroyed: false,
              continuityLeaseId: "1".repeat(32), view: { webContents: { isDestroyed: () => tab.destroyed } } };
            launcherLease.bindContinuityTab(tab, turn.continuity!);
            recoveryHost.turnTabs.set(tab.id, tab);
            return { continuity: launcherLease.continuityLease(tab) };
          });
      }
      if (controls.acquisitionFailures > 0) {
        controls.acquisitionFailures--;
        throw continuityError("continuity_unverified", "The attempted acquisition failed before its lease receipt.");
      }
      if (controls.preLeaseFailures > 0) {
        controls.preLeaseFailures--;
        expect(turn.continuity?.recovery).toBeDefined();
        expect(turn.recoveryRequestId).toBeDefined();
        throw new LauncherKnownUnsentReceiptError({ schemaVersion: 1, receiptId: "c".repeat(32), state: "known-unsent",
          executionProtocol: 1, sendState: "not-started", recovery: turn.continuity!.recovery!, launcherInstance,
          requestId: turn.recoveryRequestId!, traceId: turn.traceId, helperPid: process.pid });
      }
      if (controls.unknownPreLeaseFailures > 0) {
        controls.unknownPreLeaseFailures--;
        throw continuityError("continuity_resource_capacity", "Launcher rejected the turn before creating a page");
      }
      const hadPage = pages.has(turn.conversationKey!);
      const lease = accept(turn.conversationKey!, turn.continuity!, turn.traceId, turn.requireRetainedConversation);
      if (controls.loseStartAcknowledgementOnce && !hadPage && !turn.continuity!.expected) {
        controls.loseStartAcknowledgementOnce = false;
        expect(accept(turn.conversationKey!, turn.continuity!, turn.traceId, turn.requireRetainedConversation)).toEqual(lease);
      }
      turn.onContinuityLease!(lease);
      const compiled = await (turn.requireRetainedConversation ? turn.prepareResume!() : turn.prepare());
      if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
      expect("multipart" in compiled).toBeFalse();
      submissions.push({ prompt: compiled.text, turnToken: compiled.turnToken, claim: turn.continuity!, key: turn.conversationKey!, reused: Boolean(turn.requireRetainedConversation) });
      await turn.onSendActivated?.();
      if (turn.nativeConnector) {
        await turn.onSubmitted?.();
        const token = compiled.text.match(/turn_token (turn_[a-f0-9]{32})/)?.[1];
        const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
        expect(token).toBeDefined();
        expect(handoffId).toBeDefined();
        const aborted = new Promise<void>(resolve => {
          if (turn.abortSignal?.aborted) resolve();
          else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
          method: "submit_compaction_handoff", token, handoffId, summary: controls.handoffSummary,
        });
        await aborted;
        expect(turn.retainConversation).toBe(true);
        if (controls.failHandoffSettlement) {
          pages.delete(turn.conversationKey!);
          throw new Error("The accepted handoff has no proven physical settlement");
        }
        pages.get(turn.conversationKey!)!.state = "ready";
        return "";
      }
      if (controls.emitReviewCommentary) turn.onCommentary?.("Checking the source before continuing.");
      await turn.onSubmitted?.();
      if (controls.failAfterSendOnce) { controls.failAfterSendOnce = false; pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost"); }
      if (controls.deferCompletion) {
        controls.started = true;
        await new Promise<void>(resolve => { controls.releaseDeferredCompletion = resolve; controls.onStarted?.(); });
        controls.releaseDeferredCompletion = undefined;
      }
      if (options.contextModel) await options.contextModel({ prompt: compiled.text, token: compiled.turnToken!,
        manual, client: await manualMcp(), broker });
      else if (compiled.contextPlan) await readContinuityStartup(compiled.text, await manualMcp());
      if (controls.invokeSourceTools) {
        const token = compiled.turnToken;
        expect(token).toBeDefined();
        const calls = sourceTools(token!);
        void calls.catch(() => {});
        // The real worker captures the current answer before acknowledging a delivered batch.
        // This fixture has no DOM, but must still cross the same causal boundary.
        let progress = turn.externalProgress!.snapshot();
        while (progress.lastToolBatchRevision === 0) {
          progress = await turn.externalProgress!.waitForChange(progress.revision, turn.abortSignal);
        }
        await turn.externalProgress!.acknowledgeToolBatch(progress.lastToolBatchRevision);
        await calls;
        if (controls.failAfterToolsOnce) { controls.failAfterToolsOnce = false; if (!controls.failAfterToolsKeepPage) pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost"); }
        if (controls.pauseAfterToolResults) {
          await new Promise<void>(resolve => { controls.releaseAfterToolResults = resolve; });
          controls.releaseAfterToolResults = undefined;
        }
      }
      const answer = controls.invokeSourceTools ? "Stopped at the accepted tool boundary." : `Completed response ${submissions.length}.`;
      let completionCandidate = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
      if (controls.acknowledgePendingUpdate) {
        const token = compiled.turnToken!;
        const state = broker.taskUpdateState(token);
        expect(state).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0, driverGeneration: 1 });
        const reply = await callTurnBroker<{ taskUpdate: { deliveryId: string; throughRevision: number; updates: unknown[] } }>(provider.chatgptWeb!.brokerSocketPath!, {
          method: "native_operation_start", token, contract: "native", nativeWaitProtocol: 1, taskUpdateProtocol: 1,
          operationId: 900, taskRevision: 0, entry: "codex_exec", nativeInput: { cmd: "must-not-be-dispatched" }, waitMs: 1,
        });
        expect(reply.taskUpdate.updates).toEqual([controls.acknowledgePendingUpdate]);
        expect(reply.taskUpdate.throughRevision).toBe(1);
        await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, { method: "task_update_ack", token,
          contract: "native", taskUpdateProtocol: 1, deliveryId: reply.taskUpdate.deliveryId, throughRevision: 1 });
        expect(broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1 });
        completionCandidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
      }
      if (options.taskUpdates && compiled.contextPlan) {
        // The fixture can produce its answer before the child MCP transport has
        // settled its final overview receipt. Wait on the actual output guard;
        // do not manufacture delivery evidence or bypass another guard failure.
        const deadline = Date.now() + 2_000;
        for (;;) {
          try { broker.checkFinalOutputCandidate(compiled.turnToken!, completionCandidate); break; }
          catch (error) {
            if ((error as { code?: string }).code !== "CONTEXT_BUSY" || Date.now() >= deadline) throw error;
            await Bun.sleep(5);
          }
        }
      }
      turn.onTextDelta(answer, options.taskUpdates ? completionCandidate : undefined);
      if (options.taskUpdates && turn.completionFence) {
        const candidate = completionCandidate;
        const revision = await turn.completionFence.begin(candidate);
        if (revision !== undefined) await turn.completionFence.commit(revision, candidate);
      }
      expect(turn.retainConversation).toBe(true);
      pages.get(turn.conversationKey!)!.state = "ready";
      return answer;
    });
    const manualControl: ChatGptZeroRiskManualControl = {
      async start(_path, activity) {
        if (controls.preLeaseFailures > 0) {
          controls.preLeaseFailures--;
          expect(activity.recovery).toBeDefined();
          expect(activity.requestId).toBeDefined();
          throw new LauncherKnownUnsentReceiptError({ schemaVersion: 1, receiptId: "d".repeat(32), state: "known-unsent",
            executionProtocol: 1, sendState: "not-started", recovery: activity.recovery!, launcherInstance,
            requestId: activity.requestId!, traceId: activity.traceId, helperPid: activity.helperPid });
        }
        if (controls.unknownPreLeaseFailures > 0) {
          controls.unknownPreLeaseFailures--;
          throw continuityError("continuity_resource_capacity", "Launcher rejected the turn before creating a page");
        }
        const hadPage = pages.has(activity.conversationKey!);
        const continuity = accept(activity.conversationKey!, activity.continuity!, activity.traceId, activity.requireRetainedConversation);
        const prompt = activity.requireRetainedConversation ? activity.resumePrompt! : activity.prompt;
        if (activity.continuity!.expected || !hadPage) {
          submissions.push({ prompt, claim: activity.continuity!, key: activity.conversationKey!, reused: Boolean(activity.requireRetainedConversation) });
          const bootstrap = prompt.match(/<codex_bootstrap_json>\n([^\n]+)\n/);
          controls.safeToken = bootstrap ? JSON.parse(bootstrap[1]!).first_call.arguments.request_id
            : JSON.parse(prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
        }
        if (controls.loseStartAcknowledgementOnce && !hadPage && !activity.continuity!.expected) {
          controls.loseStartAcknowledgementOnce = false;
          expect(accept(activity.conversationKey!, activity.continuity!, activity.traceId, activity.requireRetainedConversation)).toEqual(continuity);
        }
        const selectedPlan = activity.requireRetainedConversation ? activity.contextPlans?.resume : activity.contextPlans?.full;
        return { continuity, reused: Boolean(activity.requireRetainedConversation),
          ...(selectedPlan ? { selectedPlanId: selectedPlan.planId } : {}) };
      },
      async waitSent() { broker.startSafeTurn(controls.safeToken); },
      waitTerminal: () => new Promise<never>(() => {}),
      async markStarted() {
        controls.started = true;
        controls.onStarted?.();
        if (options.contextModel) await options.contextModel({ prompt: submissions.at(-1)!.prompt,
          token: controls.safeToken, manual, client: await manualMcp(), broker });
        else if (submissions.at(-1)!.prompt.includes("<codex_bootstrap_json>")) {
          await readContinuityStartup(submissions.at(-1)!.prompt, await manualMcp());
        }
        if (controls.invokeSourceTools) {
          const token = controls.safeToken;
          controls.modelTask = sourceTools(token).then(async () => {
            const result = await (await manualMcp()).callTool({ name: "codex_turn_complete", arguments: {
              request_id: token, task_revision: 0, final_answer: controls.handoffSummary } });
            expect(result.isError).not.toBe(true);
          });
          void controls.modelTask.catch(() => {});
        } else if (!controls.deferCompletion) {
          const answer = `Completed response ${submissions.length}.`;
          if (submissions.at(-1)!.prompt.includes("<codex_bootstrap_json>")) {
            const result = await (await manualMcp()).callTool({ name: "codex_turn_complete", arguments: {
              request_id: controls.safeToken, task_revision: 0, final_answer: answer } });
            expect(result.isError).not.toBe(true);
          } else broker.completeSafeTurn(controls.safeToken, answer);
        }
      },
      async end(_path, activity) {
        for (const page of pages.values()) if (page.continuity.traceId === activity.traceId) page.state = "ready";
        if (controls.endFailure) throw new Error("Lost end acknowledgement");
      },
      async cancel() {},
    };
    cleanups.push(() => withRuntimePerformanceContext(profileContext, () => measureRuntimeAsync("fixture.cleanup", async () => {
      controls.releaseDeferredCompletion?.();
      controls.releaseAfterToolResults?.();
      automatic.mockRestore(); compatible.mockRestore(); taskUpdatesSupport.mockRestore();
      reuseSupport?.mockRestore();
      broker.acceptTaskUpdate = originalAcceptTaskUpdate;
      await measureRuntimeAsync("cleanup.broker", () => broker.close());
      await controls.modelTask?.catch(() => {});
      await measureRuntimeAsync("cleanup.child", () => modelMcp?.close());
    })));
    if (options.waitForRetirement) {
      const retire = retainedFixtureCleanup(descriptorPath);
      cleanups.push(() => withRuntimePerformanceContext(profileContext, () => measureRuntimeAsync("cleanup.sessions",
        () => retire([...pages.keys(), ...submissions.map(submission => submission.key)]))));
    }
    const threadId = options.threadId ?? `thread-${root}`;
    if (options.cleanupMode === "backend-exit") backendExits.push(async () => {
      const bindings = existingContinuityBindings(statePath);
      const binding = bindings?.observed(continuityDigest(threadId));
      if (!bindings || !binding) return;
      const source = binding.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
      if (source) {
        if (source.isActive() || source.outstanding().length) throw new Error("Backend exit cleanup requires completed continuity work.");
        await source.physicalSettlement;
        await source.waitForLogicalSettlement();
      }
      // Backend exit keeps the Launcher document. Retire local capabilities and
      // indexes before clear() can turn a settled session into a page cancellation.
      await chatGptTurnSessions.detachContinuityBinding(binding);
      bindings.forget(binding);
    });
    const request = (text = "First continuity instruction.", turnId = "turn-first", input?: unknown[]): CodexParsedRequest => {
      const parsed = parseRequest({
        model: manual ? (options.zeroRiskPro ? CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL : CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL) : "gpt-5.6-sol", stream: false,
        reasoning: { effort: options.reasoning ?? "low" }, tools: [{
          type: "function", name: "exec_command", description: "Fixture command; Native execution is simulated by the test.",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        }],
        input: input ?? [{ type: "message", id: `msg-${turnId}`, role: "user", content: text,
          internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      });
      parsed._conversationPolicy = "task";
      return parsed;
    };
    const next = (previous: CodexParsedRequest, turnId = "turn-next", answer = "Completed response 1.") => request("", turnId, [
      ...(previous._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
      { type: "message", role: "user", id: `msg-${turnId}`, content: "Next continuity instruction.",
        internal_chat_message_metadata_passthrough: { turn_id: turnId } },
    ]);
    const adapter = () => createChatGptWebAdapter(provider, { broker, zeroRiskManualControl: manualControl, codexHome: options.codexHome });
    let firstRequest = true;
    const run = (parsed: CodexParsedRequest) => withRuntimePerformanceContext(profileContext, () => {
      const request = () => measureRuntimeAsync("request.total", async () => {
      const current = adapter();
      const events: AdapterEvent[] = [];
      await current.preflight!(parsed, { headers: new Headers() });
      await current.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      return events;
      });
      if (firstRequest) { firstRequest = false; return measureRuntimeAsync("fixture.firstRequest", request); }
      return request();
    });
    return { provider, request, next, adapter, run, registrations, statePath, threadId, pages, submissions, compatible, automatic, descriptor, descriptorPath, controls, broker, recoveryHost, root, manualControl,
      readStartup: async (prompt: string) => readContinuityStartup(prompt, await manualMcp()) };
  }

  function httpFixture(manual = false, taskUpdates = false, options: { root?: string; threadId?: string; mcpTransport?: ContinuityMcpTransport } = {}) {
    const f = fixture(manual, { ...options, taskUpdates });
    const config = {
      ...defaultConfig("full"), browserHost: "launcher" as const,
      browserInteractionMode: manual ? "manual" as const : "automatic" as const,
      solAvailable: !manual,
    };
    const body: Record<string, unknown> & { model: string; stream: boolean; input: unknown[] } = {
      ...(f.request()._rawBody as Record<string, unknown>),
      input: (f.request()._rawBody as { input: unknown[] }).input,
      model: `chatgpt-web/${manual ? "zero-risk" : "gpt-5.6-sol"}`,
      reasoning: { effort: manual ? "low" : "medium" },
      stream: false,
    };
    const send = (value: unknown, compact = false, rememberState = false, signal?: AbortSignal) => {
      const request = new Request(`http://127.0.0.1/v1/responses${compact ? "/compact" : ""}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
        ...(signal ? { signal } : {}),
      });
      return compact ? compactRequest(request, config, () => f.adapter())
        : responseRequest(request, config, () => f.adapter(), { rememberState });
    };
    return { ...f, config, body, send };
  }

  return { cleanups, disposeTestFixtures, fixture, httpFixture };
}
