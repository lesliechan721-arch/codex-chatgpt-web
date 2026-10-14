import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { evictOptionalRecoveryResults, recordRecoveryAppend, recoveryDigest, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as recoveryRuntime from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as continuityInput from "../src/adapters/chatgpt-web/continuity-input";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { $ } from "bun";
import { harmlessContinuityCommand } from "./helpers/continuity-command";
import { OPENAI_ACCESS } from "../src/api-access";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptToolTimeoutError } from "../src/adapters/chatgpt-web/adapter-error";
import { cancelStructuredCompactionNativeTurn, existingStructuredCompactionRun } from "../src/adapters/chatgpt-web/compaction-handoff";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityClaim, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { cancelAbandonedContinuityCreation, leaveContinuityMode, stopDurableContinuity } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "./helpers/chatgpt-web-adapter";
import { createChatGptWebAdapter as createVerifiedChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { runContextCapabilityVerification } from "../src/adapters/chatgpt-web/context-capability-verification";
import { chatGptCurrentInstructionIndex, chatGptCurrentInstructionRevision, extractChatGptTurnIdentity, continuityCheckpointSiblingGroup, CONTINUITY_CHECKPOINT_SIBLING_PROOF } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { UserUpdate } from "../src/adapters/chatgpt-web/task-update-protocol";
import { chatGptContinuityInstructionPayloadDigest, continuityInstructionIdentity, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult, type BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint, defaultConfig } from "../src/config";
import * as configuration from "../src/config";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LauncherKnownUnsentReceiptError } from "../src/launcher-browser-host";
import { COMPACT_PROMPT, decodeCompactionSummary, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest, routeChatGptWebRequest, startServer } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { actualCheckpoint, observeCheckpointResponse, checkpointContinuationBody, compactionBody, observeCompactionHandoff } from "../scripts/validate-unified-task-continuity-transitions";
import { createLiveRequestBody } from "../scripts/validate-context-rendering";

const cleanups: Array<() => Promise<void>> = [];
const require = createRequire(import.meta.url);
const launcherRecovery = require("../launcher/electron/continuity-recovery.cjs");
const launcherLease = require("../launcher/electron/continuity-lease.cjs");
const launcherAuthority = require("../launcher/electron/continuity-execution-authority.cjs");
afterEach(async () => {
  chatGptTurnSessions.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function recordedCall(call: BrokerToolRequest): Record<string, unknown> {
  return call.freeform
    ? { type: "custom_tool_call", call_id: call.callId, name: call.wireName, input: call.input }
    : { type: "function_call", call_id: call.callId, name: call.wireName, arguments: JSON.stringify(call.arguments) };
}

function currentRecordedCall(provider: CodexProviderConfig, request: CodexParsedRequest): Record<string, unknown> {
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(request)}`)!;
  return recordedCall(source.outstanding()[0]!);
}

function taskEnvelope(prompt: string): unknown {
  return JSON.parse(/<codex_context_json>\n([^\n]+)/.exec(prompt)![1]!);
}

function fixture(manual = false, options: { codexHome?: string; threadId?: string; turnTimeoutMs?: number; taskUpdates?: boolean; root?: string } = {}) {
  const root = options.root ?? mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-adapter-"));
  const statePath = join(root, "continuity");
  const registrations = new ContinuityRegistrationStore(statePath);
  registrations.initialize();
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  const submissions: Array<{ prompt: string; claim: ContinuityClaim; key: string; reused: boolean }> = [];
  // Fixture identity has the protocol shape; it is not evidence of a real Launcher process.
  const launcherInstance = { pid: process.pid, startIdentity: continuityProcessInstance().startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : continuityProcessInstance().startIdentity, instanceId: "a".repeat(64) };
  const recoveryHost = { continuityLauncherInstance: launcherInstance, turnTabs: new Map<string, any>(),
    removeTurnTab: (tab: any) => { tab.destroyed = true; recoveryHost.turnTabs.delete(tab.id); } };
  const server = Bun.serve({
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
        if (retired && controls.retirementCleanup === "destroyed") {
          for (const [key, page] of pages) if (continuityDigest(page.continuity.recovery) === continuityDigest(body.recovery)) pages.delete(key);
        }
        return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, ...(preparing ? { preparationExpected: body.expected } : {}), launcherInstance, hostNoWriter: retired || controls.queryPhase === "missing", state: retired ? "retired" : preparing ? "prepared" : new URL(request.url).pathname.endsWith("query") ? controls.queryPhase : "send-possible", writerRetired: retired, executionIsolated: retired, physicalCleanup: retired ? controls.retirementCleanup : "pending", toolsSettled: false, sendAuthorized: true });
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
  });
  cleanups.push(async () => {
    await server.stop(true);
    if (!options.root) rmSync(root, { recursive: true, force: true });
  });
  const descriptorPath = join(root, "launcher.json");
  const descriptor = {
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    launcherInstance,
    features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
  };
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `fixture://${root}`,
    chatgptWeb: {
      browserInteractionMode: manual ? "manual" : "automatic",
      browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
      ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
      appName: manual ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME,
      brokerSocketPath: defaultBrokerEndpoint(root), continuityStateDirectory: statePath,
      localToolsEnabled: true, solAvailable: !manual, proAvailable: false, extraHighAvailable: false,
      toolAuthorityMode: "delegated", zeroRiskRequireSentConfirmation: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  let modelMcp: Client | undefined;
  const manualMcp = async () => {
    if (!modelMcp) {
      modelMcp = new Client({ name: "continuity-manual-model-fixture", version: "1" });
      await modelMcp.connect(new StdioClientTransport({ command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", "safe", "--broker-socket", provider.chatgptWeb!.brokerSocketPath!],
        cwd: process.cwd(), stderr: "pipe" }));
    }
    return modelMcp;
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
    preLeaseFailures: 0, unknownPreLeaseFailures: 0, failAfterSendOnce: false, failAfterToolsOnce: false,
    acquisitionFailures: 0, actualRecovery: false, actualAcquisitions: 0,
    prepareBeforeFailures: 0, prepareAfterFailures: 0,
    command: "fixture-command-not-executed-by-this-test",
    sourceArguments: undefined as Record<string, unknown> | undefined,
    queryPhase: "send-possible" as "send-possible" | "prepared" | "missing",
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
    expect(compiled.multipart).toBeUndefined();
    submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: Boolean(turn.requireRetainedConversation) });
    await turn.onSendActivated?.();
    if (turn.nativeConnector) {
      await turn.onSubmitted?.();
      const token = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
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
    if (controls.invokeSourceTools) {
      const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)?.[1];
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
      if (controls.failAfterToolsOnce) { controls.failAfterToolsOnce = false; pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost"); }
      if (controls.pauseAfterToolResults) {
        await new Promise<void>(resolve => { controls.releaseAfterToolResults = resolve; });
        controls.releaseAfterToolResults = undefined;
      }
    }
    const answer = controls.invokeSourceTools ? "Stopped at the accepted tool boundary." : `Completed response ${submissions.length}.`;
    let completionCandidate = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
    if (controls.acknowledgePendingUpdate) {
      const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
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
        controls.safeToken = JSON.parse(prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
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
      if (controls.invokeSourceTools) {
        const token = controls.safeToken;
        controls.modelTask = sourceTools(token).then(async () => {
          const result = await (await manualMcp()).callTool({ name: "codex_turn_complete", arguments: {
            request_id: token, task_revision: 0, final_answer: controls.handoffSummary } });
          expect(result.isError).not.toBe(true);
        });
        void controls.modelTask.catch(() => {});
      } else if (!controls.deferCompletion) broker.completeSafeTurn(controls.safeToken, `Completed response ${submissions.length}.`);
    },
    async end(_path, activity) {
      for (const page of pages.values()) if (page.continuity.traceId === activity.traceId) page.state = "ready";
      if (controls.endFailure) throw new Error("Lost end acknowledgement");
    },
    async cancel() {},
  };
  cleanups.push(async () => {
    controls.releaseDeferredCompletion?.();
    controls.releaseAfterToolResults?.();
    automatic.mockRestore(); compatible.mockRestore(); taskUpdatesSupport.mockRestore();
    broker.acceptTaskUpdate = originalAcceptTaskUpdate;
    await broker.close();
    await controls.modelTask?.catch(() => {});
    await modelMcp?.close();
  });
  const threadId = options.threadId ?? `thread-${root}`;
  const request = (text = "First continuity instruction.", turnId = "turn-first", input?: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({
      model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol", stream: false,
      reasoning: { effort: "low" }, tools: [{
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
  const run = async (parsed: CodexParsedRequest) => {
    const current = adapter();
    const events: AdapterEvent[] = [];
    await current.preflight!(parsed, { headers: new Headers() });
    await current.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    return events;
  };
  return { provider, request, next, adapter, run, registrations, statePath, threadId, pages, submissions, compatible, automatic, descriptor, descriptorPath, controls, broker, recoveryHost, root, manualControl };
}

for (const manual of [true, false]) test(`continuity: ${manual ? "Zero Risk" : "Automatic"} negotiated task updates allow successive ordinary turns on the same page`, async () => {
  const f = fixture(manual, { taskUpdates: true });
  let request = f.request();
  const tokens = new Set<string>();
  let lease: ContinuityLease | undefined;
  for (let turn = 1; turn <= 3; turn++) {
    const events = await f.run(request);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
      .map(event => event.type === "text_delta" ? event.text : "").join("")).toBe(`Completed response ${turn}.`);
    expect(f.submissions).toHaveLength(turn);
    const submission = f.submissions.at(-1)!;
    expect(submission.reused).toBe(turn > 1);
    expect(submission.prompt).toContain('"protocol":"task-updates-v1","task_revision":0');
    const token = manual
      ? JSON.parse(submission.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id
      : submission.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
    expect(tokens.has(token)).toBe(false);
    tokens.add(token);
    expect(f.broker.taskOutputReceipt(token)).toMatchObject({ taskRevision: 0, driverGeneration: 0 });
    expect(f.pages.size).toBe(1);
    const page = [...f.pages.values()][0]!;
    expect(page.state).toBe("ready");
    if (lease) {
      expect(page.continuity.owner).toBe(lease.owner);
      expect(page.continuity.leaseId).toBe(lease.leaseId);
      expect(page.continuity.traceId).not.toBe(lease.traceId);
      expect(submission.claim.expected).toEqual(lease);
    }
    lease = { ...page.continuity };
    const registration = f.registrations.get(continuityDigest(f.threadId))!;
    expect(registration.state).toBe("entered");
    expect(continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), registration.scope)!.state).toBe("ready");
    request = f.next(request, `turn-next-${turn}`, `Completed response ${turn}.`);
  }
});

for (const { name, sourceDelay, checkpointDelay, succeeds } of [
  { name: "gives the checkpoint a separate budget after source settlement", sourceDelay: 700, checkpointDelay: 700, succeeds: true },
  { name: "still times out during source settlement", sourceDelay: 1600, checkpointDelay: 0, succeeds: false },
  { name: "still times out during the checkpoint", sourceDelay: 0, checkpointDelay: 1600, succeeds: false },
]) test(`continuity compaction ${name}`, async () => {
  const f = fixture(false, { turnTimeoutMs: 1000 });
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const ordinary = f.automatic.getMockImplementation()!;
  let compactionStarted!: () => void;
  const started = new Promise<void>(resolve => { compactionStarted = resolve; });
  const beginCompaction = bindings.beginCompaction.bind(bindings);
  const begin = spyOn(bindings, "beginCompaction").mockImplementation((...args) => {
    const claim = beginCompaction(...args);
    compactionStarted();
    return claim;
  });
  let settleSource!: () => void;
  Object.defineProperty(source, "physicalSettlement", { value: new Promise<void>(resolve => { settleSource = resolve; }) });
  let checkpoint: Promise<string> | undefined;
  f.automatic.mockImplementation(turn => {
    if (!turn.nativeConnector) return ordinary(turn);
    checkpoint = (async () => {
      mock.timers.tick(checkpointDelay);
      turn.abortSignal?.throwIfAborted();
      return ordinary(turn);
    })();
    return checkpoint;
  });
  const compact = structuredClone(first);
  compact._compactionRequest = true;
  // Real filesystem and broker work must not consume the simulated phase budgets.
  mock.timers.enable({ apis: ["setTimeout"] });
  let run: Promise<AdapterEvent[]> | undefined;
  try {
    run = f.run(compact);
    void run.catch(() => {});
    await Promise.race([
      started,
      run.then(() => { throw new Error("Compaction finished before source settlement"); }),
    ]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(binding.state).toBe("compacting");
    mock.timers.tick(sourceDelay);
    settleSource();
    if (!succeeds) {
      await expect(run).rejects.toMatchObject({ code: "continuity_session_lost" });
      expect(binding.state).toBe("lost");
      if (sourceDelay > 1000) expect(checkpoint).toBeUndefined();
      return;
    }
    const events = await run;
    expect(events.find(event => event.type === "text_delta")).toMatchObject({
      type: "text_delta", text: expect.stringContaining(f.controls.handoffSummary),
    });
    expect(binding.state).toBe("ready");
    expect(f.submissions).toHaveLength(2);
  } finally {
    settleSource();
    await run?.catch(() => {});
    await source.physicalSettlement;
    await checkpoint?.catch(() => {});
    mock.timers.reset();
    begin.mockRestore();
  }
});

for (const manual of [false, true]) for (const replacement of ["empty", "removed"] as const) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} cached ordinary round applies ${replacement} tools before Native admission`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.nativeSourceTools = true;
  const first = f.request();
  const initial = await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const binding = source.runtime.continuityBinding!;
  const generation = source.continuityGenerationValue();
  const lastUsedAt = binding.lastUsedAt;
  const lease = structuredClone(binding.lease);
  const raw = structuredClone(first._rawBody) as { input: unknown[]; tools: unknown[] };
  raw.tools = replacement === "empty" ? [] : [{ type: "function", name: "remaining_fixture_tool",
    parameters: { type: "object", properties: {} } }];
  const replay = parseRequest(raw);
  replay._conversationPolicy = "task";
  expect(await f.run(replay)).toEqual(initial);
  expect(source.continuityGenerationValue()).toBe(generation);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  expect(binding.lease).toEqual(lease);
  expect(f.submissions).toHaveLength(1);
  const start = (operationId: number, cmd = "fixture-command-not-executed-by-this-test") => callTurnBroker<NativeOperationReply>(
    f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "native_operation_start", token: f.controls.sourceToken, contract: manual ? "safe" : "native",
      nativeWaitProtocol: 1, operationId, entry: "codex_exec", nativeInput: { cmd }, waitMs: 1,
    });
  expect(await start(2)).toMatchObject({ kind: "result", result: {
    isError: true, structuredContent: { code: "codex_tool_admission_rejected" },
  } });
  expect(await start(1)).toEqual({ kind: "pending", operation_id: 1 });
  await expect(start(1, "changed-start-description")).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
  expect(source.outstanding().map(request => request.callId)).toEqual([call.callId]);
  const delivery = spyOn(f.broker, "completeTool");
  try {
    const result = parseRequest({ ...raw, input: [...raw.input,
      { type: "function_call_output", call_id: call.callId, output: "Original admitted operation result." }] });
    result._conversationPolicy = "task";
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    await f.run(result);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.controls.toolResults[0]?.content).toEqual([{ type: "text", text: "Original admitted operation result." }]);
    expect(f.submissions).toHaveLength(1);
  } finally { delivery.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} rejected current payload leaves the active registry unchanged`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const raw = structuredClone(first._rawBody) as { input: Array<Record<string, unknown>>; tools: unknown[] };
    raw.input[0]!.content = "Conflicting current instruction.";
    raw.tools = [];
    const rejected = parseRequest(raw);
    rejected._conversationPolicy = "task";
    await expect(f.run(rejected)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
    const claim = await callTurnBroker<{ activityId?: string; environment: { tools: Array<{ name: string }> } }>(
      f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token: f.controls.sourceToken, ...(manual ? { contract: "safe" } : {}) });
    expect(claim.environment.tools.map(tool => tool.name)).toEqual(["exec_command"]);
    if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "activity_complete", token: f.controls.sourceToken, activityId: claim.activityId,
    });
    const result = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: call.callId, output: "Accepted original result." }]);
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.controls.toolResults).toHaveLength(1);
  } finally { update.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} generating reconnect applies its tools without advancing work`, async () => {
  const f = fixture(manual);
  f.controls.deferCompletion = true;
  const first = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(first, { headers: new Headers() });
  const detached = adapter.runTurn!(first, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const generation = source.continuityGenerationValue();
  const lastUsedAt = source.runtime.continuityBinding!.lastUsedAt;
  const raw = { ...first._rawBody as object, tools: [] };
  const retry = parseRequest(raw);
  retry._conversationPolicy = "task";
  await adapter.preflight!(retry, { headers: new Headers() });
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const pending = adapter.runTurn!(retry, { headers: new Headers() }, () => {});
    while (update.mock.calls.length === 0) await Bun.sleep(1);
    const token = manual ? f.controls.safeToken : f.submissions[0]!.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
    expect(await callTurnBroker<NativeOperationReply>(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "native_operation_start", token, contract: manual ? "safe" : "native", nativeWaitProtocol: 1,
      operationId: 1, entry: "codex_exec", nativeInput: { cmd: "not-executed" }, waitMs: 1,
    })).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
    expect(source.continuityGenerationValue()).toBe(generation);
    expect(source.runtime.continuityBinding!.lastUsedAt).toBe(lastUsedAt);
    expect(source.outstanding()).toEqual([]);
    if (manual) f.broker.completeSafeTurn(token, "Completed response 1.");
    else f.controls.releaseDeferredCompletion!();
    await pending;
    expect(f.submissions).toHaveLength(1);
  } finally { update.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} old execution cannot replace the later owner's tools`, async () => {
  const f = fixture(manual);
  const first = f.request();
  const oldEvents = await f.run(first);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const next = f.next(first);
  await f.run(next);
  const current = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const call = current.outstanding()[0]!;
  const binding = current.runtime.continuityBinding!;
  const owner = binding.executionKey;
  const generation = current.continuityGenerationValue();
  const lastUsedAt = binding.lastUsedAt;
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const replay = parseRequest({ ...first._rawBody as object, tools: [] });
    replay._conversationPolicy = "task";
    expect(await f.run(replay)).toEqual(oldEvents);
    expect(update).not.toHaveBeenCalled();
    expect(binding.executionKey).toBe(owner);
    expect(current.continuityGenerationValue()).toBe(generation);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    const claim = await callTurnBroker<{ activityId?: string; environment: { tools: Array<{ name: string }> } }>(
      f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token: f.controls.sourceToken, ...(manual ? { contract: "safe" } : {}) });
    expect(claim.environment.tools.map(tool => tool.name)).toEqual(["exec_command"]);
    if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "activity_complete", token: f.controls.sourceToken, activityId: claim.activityId,
    });
    const result = f.request("", "turn-next", [...(next._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: call.callId, output: "Later owner's result." }]);
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } finally { update.mockRestore(); }
});

test("registry replay: a delayed old update cannot replace the new owner's discovery", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const tools = [{ type: "tool_search", parameters: { type: "object" } }];
  const first = parseRequest({ ...f.request()._rawBody as object, tools });
  first._conversationPolicy = "task";
  let release!: () => void;
  let entered!: () => void;
  const applied = new Promise<void>(resolve => { entered = resolve; });
  const originalUpdate = f.broker.updateEnvironment.bind(f.broker);
  let paused = false;
  // DEV owner IPC can apply the update before its response reaches the Adapter.
  const update = spyOn(f.broker, "updateEnvironment").mockImplementation(async (token, environment) => {
    originalUpdate(token, environment);
    if (!paused) {
      paused = true;
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  let oldRun: Promise<AdapterEvent[]> | undefined;
  try {
    oldRun = f.run(first);
    await applied;
    while (!f.controls.started) await Bun.sleep(1);
    const oldSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    f.broker.completeSafeTurn(f.controls.safeToken, "Old ordinary answer.");
    await oldSource.browserOutcome;
    await oldSource.physicalSettlement;
    const binding = oldSource.runtime.continuityBinding!;
    f.controls.deferCompletion = false;
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
    f.controls.reviewWireName = "tool_search";
    const current = parseRequest({ ...f.next(first)._rawBody as object, tools });
    current._conversationPolicy = "task";
    expect((await f.run(current)).at(-1)).toMatchObject({ type: "done", endTurn: false });
    const currentSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(current)}`)!;
    const call = currentSource.outstanding()[0]!;
    const discovered = { type: "function", name: "new_owner_discovered", parameters: { type: "object", properties: {} } };
    const terminal = parseRequest({ ...current._rawBody as object, input: [...(current._rawBody as { input: unknown[] }).input,
      { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [discovered] }] });
    terminal._conversationPolicy = "task";
    expect((await f.run(terminal)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(binding.discoveredTools?.map(tool => tool.name)).toEqual(["new_owner_discovered"]);
    const newOwnerKey = binding.executionKey;
    const generation = currentSource.continuityGenerationValue();
    const lastUsedAt = binding.lastUsedAt;
    const lease = structuredClone(binding.lease);
    release();
    const oldEvents = await oldRun;
    expect(oldEvents).toContainEqual({ type: "text_delta", text: "Old ordinary answer.", phase: "final_answer" });
    expect(oldEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(binding.executionKey).toBe(newOwnerKey);
    expect(binding.discoveredTools?.map(tool => tool.name)).toEqual(["new_owner_discovered"]);
    expect(currentSource.continuityGenerationValue()).toBe(generation);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    expect(binding.lease).toEqual(lease);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } finally {
    release?.();
    await oldRun?.catch(() => {});
    update.mockRestore();
  }
});

for (const [kind, layout] of [
  ["plugins.instructions", "merged"], ["plugins.usage_instructions", "merged"], ["apps.instructions", "merged"],
  ["multi_agent.mode_instructions", "standalone"], ["multi_agent.role_instructions", "standalone"],
  ["multi_agent.usage_hint", "standalone"], ["token_budget.context_window", "standalone"],
  ["managed_config.developer_instructions", "standalone"],
  ["skills.catalog", "merged"], ["skills.instructions", "merged"], ["cloud_skills.instructions", "merged"],
  ["memories.instructions", "merged"], ["plugins.recommendations", "merged"], ["environments.instructions", "merged"],
  ["persistent_mode.instructions", "merged"], ["token_budget.context_window_guidance", "merged"],
  ["tools.deferred_namespaces", "merged"], ["git_attribution.instructions", "merged"], ["model_switch.instructions", "merged"],
] as const) test(`native prefix: ${kind} survives a new turn and rejects a conflicting retry`, async () => {
  const f = fixture();
  const generic = { type: "input_text", text: "Generic native developer instructions." };
  const target = { type: "input_text", text: `Current ${kind} instructions.` };
  const targetFirst = kind === "model_switch.instructions";
  const parts = targetFirst ? [target, generic] : [generic, target];
  const prefix = { type: "message", role: "developer", id: "native-prefix",
    content: layout === "merged" ? parts : [target],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: layout === "merged"
      ? (targetFirst ? [kind, "generic.developer_instructions"] : ["generic.developer_instructions", kind]) : [kind] } };
  // Source-backed synthetic variants of the rust-v0.159.2 initial developer layout.
  const prefixes = layout === "standalone" ? [{ ...prefix, id: "native-generic-prefix", content: [generic],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["generic.developer_instructions"] } }, prefix] : [prefix];
  const first = f.request("", "turn-first", [...prefixes, ...(f.request()._rawBody as { input: unknown[] }).input]);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const next = f.next(first);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  for (const part of parts) expect(prompt).toContain(part.text);
  expect(prompt.indexOf(parts[0]!.text)).toBeLessThan(prompt.indexOf(parts[1]!.text));
  const raw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  const content = raw.input[layout === "standalone" ? 1 : 0]!.content as Array<{ type: string; text: string }>;
  content[layout === "merged" && !targetFirst ? 1 : 0]!.text = `Changed ${kind} instructions.`;
  const retry = parseRequest(raw);
  retry._conversationPolicy = "task";
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    await expect(f.run(retry)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
  } finally { update.mockRestore(); }
  expect(f.submissions).toHaveLength(2);
});

test("verified pure environment: a derived no-AGENTS checkpoint continuation stays on the same page", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-cont-pure-env-home-"));
  cleanups.push(async () => { rmSync(codexHome, { recursive: true, force: true }); });
  const f = fixture(false, { codexHome, threadId: "019cbcc7-31b2-7028-a632-7f8118410741" });
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  // Source-backed no-AGENTS variant of the API-key capture, with a synthetic canonical rollout.
  // The original verified resolver runs unchanged; the page is the existing controlled fixture.
  const capture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol-api-key.json"), "utf8")) as {
    captured: Array<{ label: string; body: { input: Array<Record<string, any>>; client_metadata: Record<string, string>; [key: string]: unknown } }>;
  };
  const sourceTurn = "019cbcc7-31b2-7028-a632-7f8118410742";
  const compactTurn = "019cbcc7-31b2-7028-a632-7f8118410743";
  const continuedTurn = "019cbcc7-31b2-7028-a632-7f8118410744";
  const sourceBody = structuredClone(capture.captured.find(record => record.label === "new-turn")!.body);
  sourceBody.input = sourceBody.input.filter(item => item.role === "developer" || item.id === "item_4" || item.id === "item_12");
  const continuedBody = structuredClone(capture.captured.find(record => record.label === "continue")!.body);
  for (const body of [sourceBody, continuedBody]) for (const item of body.input) {
    if (Array.isArray(item.content)) {
      item.content = item.content.filter((part: { text?: string }) => !part.text?.startsWith("# AGENTS.md instructions"));
    }
  }
  expect(JSON.stringify([sourceBody.input, continuedBody.input])).not.toContain("AGENTS_MARKER");
  const sourceItem = sourceBody.input.find(item => item.id === "item_12")!;
  const sessionDirectory = join(codexHome, "sessions", "2026", "09", "30");
  mkdirSync(sessionDirectory, { recursive: true });
  const rolloutPath = join(sessionDirectory, `rollout-2026-09-30T09-00-00-${f.threadId}.jsonl`);
  const nativeEnvironment = (item: Record<string, any>, turnId: string) => ({ type: "response_item", payload: {
    ...item, internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["environments.environment_context"] },
  } });
  const nativeContext = (turnId: string) => ({ type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp/cgw-protocol-fixture/workspace",
    workspace_roots: ["/tmp/cgw-protocol-fixture/workspace"], approval_policy: "never", sandbox_policy: { type: "read-only" },
    permission_profile: { type: "managed", network: "restricted", file_system: { type: "restricted",
      entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }] } } } });
  const nativeRecords: unknown[] = [
    { type: "session_meta", payload: { id: f.threadId, source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: sourceTurn } },
    nativeEnvironment(sourceBody.input.find(item => item.id === "item_4")!, sourceTurn),
    nativeContext(sourceTurn),
    { type: "response_item", payload: { ...sourceItem, internal_chat_message_metadata_passthrough: {
      turn_id: sourceTurn, content_item_kinds: ["user.text"],
    } } },
  ];
  const writeNativeRecords = () => writeFileSync(rolloutPath, nativeRecords.map(item => JSON.stringify(item)).join("\n") + "\n");
  writeNativeRecords();
  const metadata = JSON.parse(sourceBody.client_metadata["x-codex-turn-metadata"]!);
  const options = { model: "gpt-5.6-sol", reasoning: { effort: "low" }, stream: false };
  const first = parseRequest({ ...sourceBody, ...options, client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    ...metadata, thread_id: f.threadId, turn_id: sourceTurn, request_kind: "turn",
  }) } });
  first._conversationPolicy = "task";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const binding = source.runtime.continuityBinding!;
  const physicalKey = f.submissions[0]!.key;
  const leaseId = binding.lease!.leaseId;
  const compact = parseRequest({ ...sourceBody, ...options, input: [...sourceBody.input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: f.threadId, turn_id: compactTurn,
      request_kind: "compaction", compaction: { implementation: "responses", strategy: "memento", phase: "standalone_turn" } }) },
  });
  compact._conversationPolicy = "task";
  compact._compactionRequest = true;
  compact._compactionOutput = "message";
  // The retained source environment predates the standalone compaction task. A turn_context
  // alone is not historical provenance; native Codex writes the task_started boundary too.
  nativeRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: compactTurn } });
  writeNativeRecords();
  await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolveWithRolloutPublicationRetry(compact);
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing verified compaction summary");
  expect(compact._chatGptCompactionSourceTurnId).toBe(sourceTurn);
  expect(binding.checkpoints.size).toBe(1);
  expect(binding.revision).toBe(1);
  expect(f.submissions).toHaveLength(2);
  continuedBody.input.find(item => item.id === "item_18")!.content = [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary.text}` }];
  const continued = parseRequest({ ...continuedBody, ...options, client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    ...JSON.parse(continuedBody.client_metadata["x-codex-turn-metadata"]!), thread_id: f.threadId, turn_id: continuedTurn, request_kind: "turn",
  }) } });
  continued._conversationPolicy = "task";
  nativeRecords.push(
    { type: "event_msg", payload: { type: "task_started", turn_id: continuedTurn } },
    nativeEnvironment(continuedBody.input.find(item => item.id === "item_20")!, continuedTurn),
    nativeContext(continuedTurn),
  );
  writeNativeRecords();
  const accepted = await f.run(continued);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]).toMatchObject({ key: physicalKey, reused: true });
  expect(binding.lease!.leaseId).toBe(leaseId);
  const prompt = f.submissions[2]!.prompt;
  for (const marker of ["SYSTEM_MARKER", "DEVELOPER_MARKER", "CONTINUE_MARKER"]) expect(prompt).toContain(marker);
  for (const marker of ["ORDINARY_MARKER", "NEW_TURN_MARKER", "AGENTS_MARKER"]) expect(prompt).not.toContain(marker);
  expect(await f.run(structuredClone(continued))).toEqual(accepted);
  expect(f.submissions).toHaveLength(3);
  const conflictingRaw = structuredClone(continued._rawBody) as { input: Array<Record<string, any>> };
  conflictingRaw.input.find(item => item.id === "item_21")!.content[0].text = "Changed current continuation payload.";
  const conflicting = parseRequest(conflictingRaw);
  conflicting._conversationPolicy = "task";
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    await expect(f.run(conflicting)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
  } finally { update.mockRestore(); }
  expect(f.submissions).toHaveLength(3);
  expect(f.pages.size).toBe(1);
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
});

function httpFixture(manual = false, taskUpdates = false, options: { root?: string; threadId?: string } = {}) {
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

function repair6SourceHelper(f: ReturnType<typeof httpFixture>, boundary: "response" | "dom" | "unknown-send", fault: string): void {
  const script = join(f.root, "page-loss-helper.ts");
  writeFileSync(script, `
    import { existsSync } from "node:fs";
    import { ChatGptBrowserWorker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
    import { callTurnBroker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/turn-broker.ts"))};
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
      const compiled = await turn.prepare();
      await turn.onSendActivated();
      if (${JSON.stringify(boundary)} === "unknown-send") {
        this.activeComposer = async () => ({ locator: () => ({ locator: () => ({ waitFor: async () => {} }) }) });
        return this.sendAttachedPrompt({ isClosed: () => true }, {});
      }
      await turn.onSubmitted();
      const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)[1];
      const claim = await callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, { method: "claim", token });
      const result = callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, {
        method: "invoke", bindingId: claim.bindingId, registryGeneration: claim.environment.registryGeneration,
        wireName: "exec_command", freeform: false, arguments: { cmd: "inert-page-loss-source" },
      }, null);
      void result.catch(() => {});
      await Promise.race([result.then(() => { throw new Error("Source unexpectedly completed without an outer result"); }), (async () => {
        let progress = turn.externalProgress.snapshot();
        while (!progress.lastToolBatchRevision) progress = await turn.externalProgress.waitForChange(progress.revision, turn.abortSignal);
        await turn.externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      })()]);
      while (!existsSync(${JSON.stringify(fault)})) await new Promise(resolve => setTimeout(resolve, 5));
      const page = { isClosed: () => true };
      if (${JSON.stringify(boundary)} === "dom") return this.responseDomSnapshot({
        evaluate: async () => { throw new Error("fixture renderer crashed"); }, page: () => page,
      });
      return this.waitForNewAssistantTurn(page, {}, Date.now() + 1000);
    };
    await import(${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-helper-main.ts"))});
  `);
  f.provider.chatgptWeb!.browserHelperScriptPath = script;
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  cleanups.push(async () => { taskUpdates.mockRestore(); await (worker as unknown as { launcherHelper?: { close(): Promise<void> } }).launcherHelper?.close(); });
}

async function repair7PendingUpdate(buffered = false) {
  const f = httpFixture(false, true);
  if (buffered) Object.assign(f.body, { text: { format: { type: "json_schema", name: "answer", strict: true,
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } });
  f.controls.invokeSourceTools = true; f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id, output: "Actual original result before the pending update recovery." };
  const body = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result,
    { type: "message", role: "user", id: "repair7-accepted-update", content: "Continue with the actual result. Do not repeat any business tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } }] };
  const append = await (await f.send(body)).json();
  expect(append.status).toBe("failed");
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), before = store.get(thread)!;
  expect(before.works[before.currentWorkId!]!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0, driverGeneration: 1 });
  expect(before.calls[String(call.call_id)]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(result) });
  expect(before.works[before.currentWorkId!]!.taskUpdateJournal!.deliveries).toHaveLength(1);
  const oldDelivery = before.works[before.currentWorkId!]!.taskUpdateJournal!.deliveries[0]!;
  const helper = join(f.root, "repair7-completion-helper.ts"), receipt = join(f.root, "repair7-helper-receipt.json");
  const install = (boundary: "begin" | "commit" | "buffered" | "acknowledged" | "stale" | "unknown" | "forged-code") => {
    writeFileSync(helper, `
      import { writeFileSync } from "node:fs";
      import { ChatGptBrowserWorker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
      import { callTurnBroker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/turn-broker.ts"))};
      ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
        const compiled=await turn.prepare(); await turn.onSendActivated(); await turn.onSubmitted();
        const token=compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)[1];
        const candidate={expectedDriverGeneration:1,taskRevision:1,acknowledgedRevision:0};
        const boundary=${JSON.stringify(boundary)};
        if(boundary==="acknowledged") {
          let oldCode;
          try { await callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, {method:"task_update_ack",token,contract:"native",taskUpdateProtocol:1,deliveryId:${JSON.stringify(oldDelivery.deliveryId)},throughRevision:1}); }
          catch(error) { oldCode=error.code; }
          const delivery=await callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, {method:"native_operation_start",token,contract:"native",nativeWaitProtocol:1,taskUpdateProtocol:1,operationId:900,taskRevision:0,entry:"codex_tool_inventory",nativeInput:{},waitMs:1});
          const ack=await callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, {method:"task_update_ack",token,contract:"native",taskUpdateProtocol:1,deliveryId:delivery.taskUpdate.deliveryId,throughRevision:delivery.taskUpdate.throughRevision});
          const current={...candidate,acknowledgedRevision:1};
          const revision=await turn.completionFence.begin(current);
          const committed=await turn.completionFence.commit(revision,current);
          writeFileSync(${JSON.stringify(receipt)},JSON.stringify({oldCode,acknowledged:ack.acknowledgedRevision,committed}));
          turn.onTextDelta("Actual acknowledged recovery complete.",current); return "Actual acknowledged recovery complete.";
        }
        if(boundary==="buffered") turn.onTextDelta('{"answer":"must remain rejected"}',candidate);
        if(boundary==="commit") return turn.completionFence.commit(0,candidate);
        return turn.completionFence.begin(boundary==="stale" ? {...candidate,expectedDriverGeneration:0} : candidate);
      };
      await import(${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-helper-main.ts"))});
    `);
    f.provider.chatgptWeb!.browserHelperScriptPath = helper;
    const worker = ChatGptBrowserWorker.forProvider(f.provider);
    cleanups.push(async () => { await (worker as unknown as { launcherHelper?: { close(): Promise<void> } }).launcherHelper?.close(); });
  };
  const send = async () => {
    const events: AdapterEvent[] = [];
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), f.config, () => {
      const adapter = f.adapter(), run = adapter.runTurn!;
      return { ...adapter, async runTurn(parsed, incoming, emit) {
        await run.call(adapter, parsed, incoming, event => { events.push(event); emit(event); });
      } };
    });
    return { response, envelope: await response.json(), events };
  };
  return { f, body, thread, store, before, call, oldDelivery, receipt, install, send };
}

for (const boundary of ["begin", "commit", "buffered"] as const) test(`repair7: actual pending ACK ${boundary} fence rejection survives helper IPC and public Responses`, async () => {
  const s = await repair7PendingUpdate(boundary === "buffered");
  s.install(boundary);
  const { response, envelope, events } = await s.send();
  expect(response.status).toBe(200);
  expect(envelope).toMatchObject({ status: "failed", error: { code: "task_update_unacknowledged" } });
  expect(events.filter(event => event.type === "error")).toContainEqual(expect.objectContaining({ code: "task_update_unacknowledged", retryable: false }));
  expect(envelope.end_turn).not.toBe(true);
  expect(envelope.output.filter((item: Record<string, unknown>) => item.type === "message" && item.phase === "final_answer")).toHaveLength(0);
  const after = s.store.get(s.thread)!, work = after.works[after.currentWorkId!]!;
  expect(work.taskUpdateJournal!.acknowledgedRevision).toBe(0);
  expect(work.taskUpdateJournal!.acceptedRevision).toBe(1);
  expect(work.attempts).toHaveLength(2);
  expect(work.stopReason).toBeUndefined(); expect(work.terminalReceiptId).toBeUndefined();
  expect(Object.keys(after.calls)).toEqual(Object.keys(s.before.calls));
  expect(after.calls[String(s.call.call_id)]!.firstResultDigest).toBe(s.before.calls[String(s.call.call_id)]!.firstResultDigest);
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
  expect(s.f.controls.helperStarts).toBe(1);
}, 30_000);

test("repair7: a recovered helper obtains a new control-only delivery and completes only after its actual ACK", async () => {
  const s = await repair7PendingUpdate(); s.install("acknowledged");
  const { envelope } = await s.send();
  expect(envelope).toMatchObject({ status: "completed", end_turn: true });
  expect(JSON.parse(readFileSync(s.receipt, "utf8"))).toEqual({ oldCode: "task_update_delivery_invalid", acknowledged: 1, committed: true });
  const after = s.store.get(s.thread)!, work = after.works[after.currentWorkId!]!;
  expect(work.state).toBe("completed"); expect(work.taskUpdateJournal!.acknowledgedRevision).toBe(1);
  expect(work.taskUpdateJournal!.deliveries).toHaveLength(2);
  expect(work.taskUpdateJournal!.deliveries.at(-1)).toMatchObject({ attempt: 1, epoch: 1, acknowledged: true });
  expect(Object.keys(after.calls)).toEqual(Object.keys(s.before.calls));
  expect(after.calls[String(s.call.call_id)]!.firstResultDigest).toBe(s.before.calls[String(s.call.call_id)]!.firstResultDigest);
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
  const replay = await (await s.f.send(s.body)).json();
  expect(replay.status).toBe("completed"); expect(s.f.controls.helperStarts).toBe(1);
}, 30_000);

for (const boundary of ["unknown", "forged-code", "stale"] as const) test(`repair7: completion helper ${boundary} error keeps its own trust boundary`, async () => {
  const s = await repair7PendingUpdate(); s.install(boundary);
  if (boundary !== "stale") {
    const fence = spyOn(s.f.broker, "beginCompletionFence").mockImplementation(() => {
      throw boundary === "forged-code" ? Object.assign(new Error("Ordinary error with an untrusted matching code"), { code: "task_update_unacknowledged" }) : new Error("Unknown ordinary completion failure");
    });
    cleanups.push(async () => { fence.mockRestore(); });
  }
  const { envelope, events } = await s.send();
  expect(envelope).toMatchObject({ status: "failed", error: { code: boundary === "stale" ? "task_update_driver_stale" : "continuity_session_lost" } });
  expect(events.filter(event => event.type === "error")).toContainEqual(expect.objectContaining({ code: boundary === "stale" ? "task_update_driver_stale" : "continuity_session_lost", retryable: false }));
  const after = s.store.get(s.thread)!, work = after.works[after.currentWorkId!]!;
  expect(work.taskUpdateJournal!.acknowledgedRevision).toBe(0); expect(work.stopReason).toBeUndefined();
  expect(Object.keys(after.calls)).toEqual(Object.keys(s.before.calls));
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
}, 30_000);

for (const boundary of ["response", "dom"] as const) for (const userClosed of [false, true]) {
  test(`repair6: public HTTP waits for actual helper ${boundary} page-loss settlement before source recovery (user-close=${userClosed})`, async () => {
    const f = httpFixture();
    f.body.model = "chatgpt-web/gpt-6-sol-instant"; f.body.reasoning = { effort: "low" };
    const fault = join(f.root, "renderer-crashed");
    repair6SourceHelper(f, boundary, fault);
    const response = await f.send(f.body);
    expect(response.status).toBe(200);
    const first = await response.json() as { output: Array<Record<string, unknown>> };
    const call = first.output.find(item => item.type === "function_call")!;
    expect(call).toBeDefined();
    const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
    const original = store.get(thread)!;
    expect(original.calls[String(call.call_id)]!.state).toBe("delivery-possible");
    const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
    f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "physical page absent");
    await source.browserOutcome; await source.physicalSettlement;
    expect(f.controls.helperStarts).toBe(1); expect(f.controls.helperEnds).toBe(1);
    const failed = store.get(thread)!;
    expect(failed.works[failed.currentWorkId!]!.state === "stopped").toBe(userClosed);
    expect(failed.works[failed.currentWorkId!]!.attempts).toHaveLength(1);
    // Return to the existing successor browser fixture only after real IPC has settled.
    delete f.provider.chatgptWeb!.browserHelperScriptPath;
    const result = { type: "function_call_output", call_id: call.call_id, output: "Actual settled page-loss source result." };
    const continuation = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
    if (userClosed) {
      const denied = await f.send(continuation);
      expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("continuity_stopped");
      expect(store.get(thread)).toEqual(failed); expect(f.submissions).toHaveLength(0);
      return;
    }
    const missing = await f.send(f.body);
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.code).toBe("continuity_execution_unsettled");
    expect(f.submissions).toHaveLength(0);
    const recovered = await f.send(continuation);
    expect(recovered.status).toBe(200); expect((await recovered.json()).status).toBe("completed");
    const after = store.get(thread)!;
    expect(after.currentWorkId).toBe(original.currentWorkId);
    expect(after.epoch).toBe(original.epoch + 1);
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(2);
    expect(after.calls[String(call.call_id)]!.firstResultDigest).toBe(recoveryResultDigest(result));
    expect(f.submissions).toHaveLength(1); expect(f.submissions[0]!.reused).toBe(false);
    expect((await (await f.send(continuation)).json()).status).toBe("completed");
    expect(f.submissions).toHaveLength(1);
  }, 30_000);
}

test("repair6: public helper page loss preserves unknown Send and refuses replacement", async () => {
  const f = httpFixture(), fault = join(f.root, "unknown-send-fault");
  repair6SourceHelper(f, "unknown-send", fault);
  const response = await f.send(f.body);
  expect(response.status).toBe(200); expect((await response.json()).status).toBe("failed");
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  expect(before.works[before.currentWorkId!]!.state).not.toBe("stopped");
  expect(before.works[before.currentWorkId!]!.attempts.at(-1)!.stage).toBe("send-possible");
  delete f.provider.chatgptWeb!.browserHelperScriptPath;
  const denied = await f.send(f.body);
  expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("continuity_execution_unsettled");
  expect(store.get(thread)).toEqual(before); expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
}, 30_000);

for (const target of ["same-work", "new-work"] as const) for (const userClosed of [false, true]) test(`repair6: late original helper failure cannot mutate a ${target} successor (user-close=${userClosed})`, async () => {
  const f = httpFixture(), fault = join(f.root, "late-old-helper-fault");
  repair6SourceHelper(f, "response", fault);
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!, work = before.works[before.currentWorkId!]!;
  const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
  const result = { type: "function_call_output", call_id: call.call_id, output: "Original outer result settled before withdrawal." };
  const parsed = parseRequest({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] });
  routeChatGptWebRequest(parsed, f.config);
  expect(source.acceptContinuityToolResults(parsed)).toHaveLength(1);
  expect(store.get(thread)!.calls[String(call.call_id)]!.state).toBe("settled");
  let successor;
  if (target === "same-work") {
    store.retireAttempt(thread, { scope: before.scope }, work.logicalWorkId, 0);
    successor = store.reserveRecovery(thread, { scope: before.scope }, {
      logicalWorkId: work.logicalWorkId, owner: before.owner, snapshotDigest: work.attempts[0]!.snapshotDigest,
    });
  } else {
    source.cancel();
    successor = store.admitWork({ thread, scope: before.scope, owner: before.owner,
      logicalWorkId: "new-task-after-interrupt", nativeTurnId: "new-native-turn", instructionIdentity: "new-native-instruction",
      workPayloadDigest: "1".repeat(64), snapshotDigest: "2".repeat(64), createPage: true, dispatchProtocolComplete: true });
  }
  f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "old page absent after withdrawal");
  await source.browserOutcome; await source.physicalSettlement;
  expect(store.get(thread)).toEqual(successor);
  expect(store.get(thread)!.works[successor.currentWorkId!]!.state).toBe("prepared");
  expect(store.get(thread)!.works[successor.currentWorkId!]!.attempts).toHaveLength(target === "same-work" ? 2 : 1);
  if (target === "new-work") expect(store.get(thread)!.works[work.logicalWorkId]!.state).toBe("stopped");
  expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
}, 30_000);

test("repair6: native Interrupt stops the original task before a late physical loss", async () => {
  const f = httpFixture(), fault = join(f.root, "interrupted-helper-fault");
  repair6SourceHelper(f, "response", fault);
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  // These are the ordered durable-stop and exact native cancellation used by /admin/interrupt-turn.
  expect(stopDurableContinuity(f.statePath, f.threadId, "turn-first", "native-interrupt")).toBe(true);
  const cancellation = chatGptTurnSessions.cancelNativeTurn(f.threadId, "turn-first", new DOMException("Codex turn interrupted", "AbortError"));
  expect(cancellation.cancelled).toBe(1);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), stopped = store.get(thread)!;
  expect(stopped.works[stopped.currentWorkId!]!.stopReason).toBe("native-interrupt");
  writeFileSync(fault, "page absent after interrupt");
  await source.browserOutcome; await source.physicalSettlement; await cancellation.settlement;
  expect(store.get(thread)).toEqual(stopped);
  delete f.provider.chatgptWeb!.browserHelperScriptPath;
  const denied = await f.send({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
    { type: "function_call_output", call_id: first.output.find(item => item.type === "function_call")!.call_id, output: "Real stopped call result." }] });
  expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("continuity_stopped");
  expect(f.submissions).toHaveLength(0);
}, 30_000);

for (const target of ["same-work", "new-work"] as const) for (const userClosed of [false, true]) {
  test(`repair6: cross-process retirement after the error guard preserves the ${target} successor (user-close=${userClosed})`, async () => {
    const f = httpFixture(), fault = join(f.root, "cross-process-old-helper-fault");
    repair6SourceHelper(f, "response", fault);
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const call = first.output.find(item => item.type === "function_call")!;
    const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
    const before = store.get(thread)!, work = before.works[before.currentWorkId!]!;
    const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
    const parsed = parseRequest({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
      { type: "function_call_output", call_id: call.call_id, output: "Actual result settled before cross-process retirement." }] });
    routeChatGptWebRequest(parsed, f.config);
    expect(source.acceptContinuityToolResults(parsed)).toHaveLength(1);
    let successor: ReturnType<ContinuityRecoveryStore["get"]>;
    let swaps = 0;
    const assertWriter = recoveryRuntime.assertRecoveryWriter;
    const check = spyOn(recoveryRuntime, "assertRecoveryWriter").mockImplementation(ref => {
      const checked = assertWriter(ref);
      if (ref.thread !== thread || swaps) return checked;
      swaps++;
      const code = `import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
        const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),thread=${JSON.stringify(thread)},scope=${JSON.stringify(before.scope)};
        ${target === "same-work" ? `store.retireAttempt(thread,{scope},${JSON.stringify(work.logicalWorkId)},0);
          store.reserveRecovery(thread,{scope},{logicalWorkId:${JSON.stringify(work.logicalWorkId)},owner:${JSON.stringify(before.owner)},snapshotDigest:${JSON.stringify(work.attempts[0]!.snapshotDigest)}});`
          : `store.stopWork(thread,{scope},${JSON.stringify(work.logicalWorkId)},"native-interrupt");
          store.admitWork({thread,scope,owner:${JSON.stringify(before.owner)},logicalWorkId:"new-task-after-child-interrupt",nativeTurnId:"new-child-turn",instructionIdentity:"new-child-instruction",workPayloadDigest:"1".repeat(64),snapshotDigest:"2".repeat(64),createPage:true,dispatchProtocolComplete:true});`}`;
      const child = Bun.spawnSync([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode) throw new Error(`Cross-process fixture failed: ${child.stderr.toString()}`);
      successor = store.get(thread)!;
      return checked;
    });
    cleanups.push(async () => { check.mockRestore(); });
    f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "old page physically absent");
    await source.browserOutcome; await source.physicalSettlement;
    expect(swaps).toBe(1);
    expect(store.get(thread)).toEqual(successor);
    expect(store.get(thread)!.works[successor!.currentWorkId!]!.state).toBe("prepared");
    expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
  }, 30_000);
}

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse().map(([key, child]) => [key, reverseJsonObjectKeys(child)]));
}

// Observed with Codex 0.158.0 against an isolated Responses stub: response-only
// status and output_text annotations are not serialized back into input history.
function codexRoundtrippedOutput(output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return output.map(({ status: _status, ...item }) => {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content = item.content.map(({ annotations: _annotations, ...part }) => part);
    }
    return item;
  });
}

for (const manual of [false, true]) for (const stream of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} ${stream ? "streamed" : "JSON"} accepts Codex-roundtripped tool output without repeating work`, async () => {
  const f = httpFixture(manual);
  f.body.stream = stream;
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.emitReviewCommentary = true;
  const readResponse = async (response: Response): Promise<{ output: Array<Record<string, unknown>> }> => {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json();
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.some(event => event.type === "response.failed")).toBe(false);
    const completed = events.find(event => event.type === "response.completed");
    expect(completed).toBeDefined();
    return completed.response;
  };
  const response = await f.send(f.body);
  const first = await readResponse(response);
  const call = first.output.find(item => item.type === "function_call")!;
  expect(call.status).toBe("completed");
  const nextBody = { ...f.body, input: [
    ...f.body.input, ...codexRoundtrippedOutput(first.output),
    { type: "function_call_output", call_id: call.call_id, output: "Actual accepted result 42." },
  ] };
  const next = await f.send(nextBody);
  expect({ httpStatus: next.status, ...await readResponse(next) }).toMatchObject({ httpStatus: 200, status: "completed" });
  const replay = await f.send(nextBody);
  expect({ httpStatus: replay.status, ...await readResponse(replay) }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} accepts Codex-roundtripped final output on the next user turn`, async () => {
  const f = httpFixture(manual);
  f.controls.emitReviewCommentary = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const next = await f.send({
    ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
      { type: "message", role: "user", id: "roundtripped-next", content: "Continue authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-roundtripped-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-roundtripped-next" }) },
  });
  expect({ httpStatus: next.status, ...await next.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) for (const format of ["local", "v1", "v2"] as const) {
  test(`HTTP ${manual ? "Zero Risk" : "Automatic"} ${format} compaction recognizes Codex-roundtripped owned output`, async () => {
    const f = httpFixture(manual);
    f.controls.emitReviewCommentary = true;
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const history = [...f.body.input, ...codexRoundtrippedOutput(first.output)];
    const body = format === "local" ? {
      ...f.body, input: [...history, { type: "message", role: "user", content: COMPACT_PROMPT }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
        compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
      }) },
    } : { ...f.body, input: [...history, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
    const response = await f.send(body, format === "v1");
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200 });
    expect(f.submissions).toHaveLength(2);
    expect(f.pages.size).toBe(1);
  });
}

test("Zero Risk rejected current result can be explicitly cancelled before leaving continuity without a restart", async () => {
  const f = httpFixture(true);
  f.controls.invokeSourceTools = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const output = codexRoundtrippedOutput(first.output);
  const call = output.find(item => item.type === "function_call")!;
  const rejected = await f.send({ ...f.body, input: [
    ...f.body.input, ...output,
    { type: "function_call_output", call_id: "unknown-current-call", output: "Must not be delivered." },
  ] });
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).error.code).toBe("continuity_source_unproven");
  expect(f.controls.toolResults).toHaveLength(0);
  expect(() => leaveContinuityMode(f.statePath, f.threadId))
    .toThrow("Finish or explicitly cancel the current continuity work");

  const cancelled = chatGptTurnSessions.cancelNativeTurn(f.threadId, "turn-first", new Error("Explicit test cancellation"));
  expect(cancelled.cancelled).toBe(1);
  await cancelled.settlement;
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("lost");
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
});

for (const changed of ["call_id", "name", "namespace", "arguments", "text", "phase", "status", "annotations"] as const) {
  test(`HTTP Codex-roundtripped history ignores changed echoed ${changed} while keeping the local result identity`, async () => {
    const f = httpFixture();
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
    f.controls.emitReviewCommentary = true;
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const output = codexRoundtrippedOutput(first.output);
    const call = output.find(item => item.type === "function_call")!;
    const message = output.find(item => item.type === "message")!;
    const originalCallId = call.call_id;
    if (changed === "text" || changed === "annotations") {
      (message.content as Array<Record<string, unknown>>)[0]![changed] = changed === "text" ? "Unowned text." : [{ type: "unowned_annotation" }];
    } else if (changed === "phase") message.phase = "final_answer";
    else call[changed] = changed === "status" ? "in_progress" : "unowned";
    const response = await f.send({ ...f.body, input: [
      ...f.body.input, ...output,
      { type: "function_call_output", call_id: originalCallId, output: "Actual completed tool result: 42." },
    ] });
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
    expect(f.controls.toolResults).toHaveLength(1);
    expect(JSON.stringify(f.controls.toolResults[0])).toContain("Actual completed tool result: 42.");
    expect(f.submissions).toHaveLength(1);
  });
}

for (const selectors of ["explicit", "omitted"] as const) test(`HTTP native compact verifies ${selectors} source selectors while keeping control-only execution`, async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  const output = await ordinary.json() as { output: Array<{ type: string }> };
  expect(output.output.some(item => item.type === "function_call")).toBe(false);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  expect(source.runtime.usageInput!.options).toMatchObject({ toolChoice: "none", parallelToolCalls: false });
  const body: Record<string, unknown> = { ...original };
  if (selectors === "omitted") { delete body.tool_choice; delete body.parallel_tool_calls; }
  const adapter = f.adapter();
  const preflight = adapter.preflight!.bind(adapter);
  let controlInput: CodexParsedRequest | undefined;
  let hadToolRegistry = false;
  adapter.preflight = async (parsed, ...args) => {
    controlInput = parsed; hadToolRegistry = parsed.context.tools !== undefined;
    return preflight(parsed, ...args);
  };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.config, () => adapter);
  expect(compact.status, await compact.clone().text()).toBe(200);
  await compact.text();
  expect(controlInput!.options.toolChoice).toBeUndefined();
  expect(controlInput!.options.parallelToolCalls).toBeUndefined();
  expect(hadToolRegistry).toBe(false);
  expect(f.automatic.mock.calls[1]![0].nativeConnector).toBe(true);
  expect(f.submissions).toHaveLength(2);
  expect(binding.checkpoints.size).toBe(1);
});

for (const selector of ["tool_choice", "parallel_tool_calls"] as const) test(`HTTP native compact rejects changed source ${selector}`, async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  await ordinary.text();
  const changed = { ...original, [selector]: selector === "tool_choice" ? "auto" : true };
  const compact = await f.send(changed, true);
  expect({ httpStatus: compact.status, ...await compact.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  // The ordinary accepted instruction remains immutable under the same identity.
  const replay = await f.send(changed);
  expect({ httpStatus: replay.status, ...await replay.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(1);
});

test("HTTP native compact refuses omitted source selectors when the real source options are unavailable", async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  await ordinary.text();
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  // Preserve its accepted digest and identity while removing the complete source object.
  source.runtime.usageInput = undefined;
  const compact = await f.send(f.body, true);
  expect({ httpStatus: compact.status, ...await compact.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(1);
  expect(binding.checkpoints.size).toBe(0);
});

for (const format of ["local", "v1", "v2"] as const) test(`HTTP ${format} compact installs one checkpoint and continues on the same page`, async () => {
  const f = httpFixture();
  const firstResponse = await f.send(f.body);
  expect({ httpStatus: firstResponse.status, ...await firstResponse.clone().json() }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect((await firstResponse.json()).status).toBe("completed");
  const originalInput = f.body.input as unknown[];
  const compactBody = format === "local" ? {
    ...f.body, input: [...originalInput, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  } : { ...f.body, input: [...originalInput, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
  const response = await f.send(compactBody, format === "v1");
  expect(response.status).toBe(200);
  const compacted = await response.json() as { output: Array<{ type: string; encrypted_content?: string; content?: Array<{ text?: string }> }> };
  const item = format === "v1" ? compacted.output.at(-1)
    : compacted.output.find(value => value.type === (format === "local" ? "message" : "compaction"));
  expect(item).toBeDefined();
  const text = item!.content?.map(part => part.text ?? "").join("") ?? "";
  if (format === "v1") {
    expect(compacted.output.every(value => value.type === "message")).toBe(true);
    expect(text.startsWith(`${SUMMARY_PREFIX}\n`)).toBe(true);
  }
  const summary = format === "v2" ? decodeCompactionSummary(item!.encrypted_content!)
    : format === "v1" ? text.slice(SUMMARY_PREFIX.length + 1) : text;
  expect(summary).toBe('Verified checkpoint.\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."');
  const retry = await f.send(compactBody, format === "v1");
  expect(retry.status, await retry.clone().text()).toBe(200);
  await retry.text();
  expect(f.submissions).toHaveLength(2);
  const input = format === "v1" ? compacted.output : [...originalInput, ...(format === "local"
    ? [{ type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }]
    : compacted.output)];
  const continued = await f.send({ ...f.body, input });
  expect(continued.status).toBe(200);
  const completed = await continued.json();
  expect(completed.status).toBe("completed");
  expect(completed.output.at(-1)?.content).toEqual([{ type: "output_text", text: "Completed response 1.", annotations: [] }]);
  expect(f.submissions).toHaveLength(2);
  const next = await f.send({
    ...f.body, input: [...input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
      { type: "message", role: "user", id: "next-http-message", content: "Continue new authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-http-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-http-next" }) },
  });
  expect(next.status).toBe(200);
  expect((await next.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.prompt).toContain("Continue new authorized work.");
  expect(f.submissions[2]!.prompt).not.toContain("First continuity instruction.");
  expect(new Set(f.submissions.map(value => value.key)).size).toBe(1);
});

for (const format of ["local", "v1", "v2"] as const) test(`HTTP completed ${format} compaction accepts the bridge's returned output history`, async () => {
  const f = httpFixture();
  const firstResponse = await f.send(f.body);
  const completed = await firstResponse.json() as { status: string; output: unknown[] };
  expect(completed.status).toBe("completed");
  const fullHistory = [...f.body.input, ...completed.output];
  const compactBody = format === "local" ? {
    ...f.body, input: [...fullHistory, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  } : { ...f.body, input: [...fullHistory, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
  const response = await f.send(compactBody, format === "v1");
  expect(response.status).toBe(200);
  await response.text();
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
});

test("HTTP tool continuation accepts the bridge's commentary and tool output exactly once", async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.emitReviewCommentary = true;
  const response = await f.send(f.body);
  const result = await response.json() as { output: Array<Record<string, unknown>> };
  const call = result.output.find(item => item.type === "function_call")!;
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary")).toBe(true);
  const continuation = await f.send({ ...f.body, input: [
    ...f.body.input, ...result.output,
    { type: "function_call_output", call_id: call.call_id, output: "Actual completed fixture result: 42." },
  ] });
  expect(continuation.status).toBe(200);
  await continuation.text();
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP next user turn accepts the bridge's complete commentary and final output", async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  const response = await f.send(f.body);
  const result = await response.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(result.status).toBe("completed");
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary")).toBe(true);
  const next = await f.send({
    ...f.body, input: [...f.body.input, ...result.output,
      { type: "message", role: "user", id: "review-next-message", content: "Continue new authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-review-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-review-next" }) },
  });
  expect(next.status).toBe(200);
  await next.text();
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} replays an earlier accepted tool round after the canonical head advances`, async () => {
  const f = httpFixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const initial = await (await f.send(f.body)).json() as { status: string; output: Array<Record<string, unknown>> };
  const call = initial.output.find(item => item.type === "function_call")!;
  const nextBody = { ...f.body, input: [
    ...f.body.input, ...initial.output,
    { type: "function_call_output", call_id: call.call_id, output: "Actual accepted result 42" },
  ] };
  const next = await (await f.send(nextBody)).json() as { status: string };
  expect(next.status).toBe("completed");
  expect(f.controls.toolResults).toHaveLength(1);

  const replay = await f.send(f.body);
  expect(replay.status).toBe(200);
  const replayBody = await replay.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(replayBody.status).toBe("completed");
  expect(replayBody.output.find(item => item.type === "function_call")?.call_id).toBe(call.call_id);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP streamed replay of an earlier accepted tool round completes after the canonical head advances", async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  await (await f.send({ ...f.body, input: [
    ...f.body.input, ...first.output,
    { type: "function_call_output", call_id: call.call_id, output: "Accepted result 42" },
  ] })).text();

  const response = await f.send({ ...f.body, stream: true });
  const events = await response.text();
  expect(events).toContain("event: response.completed");
  expect(events).not.toContain("event: response.failed");
  expect(f.controls.toolResults).toHaveLength(1);
});

test("Automatic original ordinary replay keeps its first tool batch after round journal reclamation", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const initial = await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const result = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Accepted first result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const priorBatch = snapshot.lastToolBatchRevision;
  const next = f.run(result);
  while (snapshot.lastToolBatchRevision === priorBatch) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  await next;
  const currentCall = source.outstanding()[0]!.callId;
  // Exercise the journal cap without issuing hundreds of simulated Native calls.
  for (let index = 0; index < 511; index += 1) source.completeRound(`completed-capacity-probe-${index}`);
  expect((source as unknown as { rounds: Map<string, unknown> }).rounds.size).toBe(512);
  expect(await f.run(structuredClone(first))).toEqual(initial);
  expect(source.outstanding()[0]!.callId).toBe(currentCall);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  await expect(f.run(structuredClone(result))).rejects.toMatchObject({ code: "continuity_source_unproven" });
});

for (const changedEcho of [false, true]) test(`Automatic current results with ${changedEcho ? "changed" : "original"} call echoes survive older batch reclamation`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const oldCall = source.outstanding()[0]!;
  const oldResult = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: oldCall.callId, output: "Accepted earlier result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const revision = snapshot.lastToolBatchRevision;
  const next = f.run(oldResult);
  while (snapshot.lastToolBatchRevision === revision) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  await next;
  const current = source.outstanding()[0]!;
  const base = [...(oldResult._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Next tool batch." },
    { type: "function_call", call_id: changedEcho ? "decorative-call-echo" : current.callId,
      name: changedEcho ? "changed-display-name" : current.wireName,
      arguments: changedEcho ? '{"cmd":"changed-display-only"}' : JSON.stringify(current.arguments) }];
  const result = { type: "function_call_output", call_id: current.callId, output: "Accepted current result." };
  const full = f.request("", "turn-first", [...base, result]);
  expect(source.continuityToolResultRoundKey(full)).toBe("tool-batch:2");
  for (let index = 0; index < 511; index++) source.completeRound(`completed-capacity-probe-${index}`);
  await expect(f.run(structuredClone(oldResult))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const unknown = { type: "function_call_output", call_id: "unknown-current-result", output: "Unowned result." };
  for (const results of [[unknown, result], [result, unknown], [result, result]]) {
    await expect(f.run(f.request("", "turn-first", [...base, ...results]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(source.outstanding()[0]!.callId).toBe(current.callId);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(source.continuityToolResultRoundKey(full)).toBe("tool-batch:2");
  const accepted = await f.run(full);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(full))).toEqual(accepted);
  expect(f.controls.toolResults).toHaveLength(2);
  expect(f.submissions).toHaveLength(1);
});

test("HTTP completed compaction replay remains readable after later work on the same revision", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const compactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
  expect(compact.status).toBe("completed");

  const next = await f.send({
    ...f.body,
    input: [...history, ...compact.output,
      { type: "message", role: "user", id: "next-work-after-checkpoint", content: "Perform the next authorized task.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-next-after-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next-after-checkpoint" }) },
  });
  expect(next.status).toBe(200);
  expect((await next.json()).status).toBe("completed");

  const replay = await f.send(compactBody);
  expect(replay.status).toBe(200);
  expect((await replay.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(3);
  expect(f.pages.size).toBe(1);
});

test("HTTP completed compaction replay remains readable while later work is still running", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const compactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
  expect(compact.status).toBe("completed");

  const nextBody = {
    ...f.body,
    input: [...history, ...compact.output,
      { type: "message", role: "user", id: "running-work-after-checkpoint", content: "Keep this work running.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-running-after-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-running-after-checkpoint" }) },
  };
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const running = f.send(nextBody);
  while (!f.controls.started) await Bun.sleep(1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const runningExecutionKey = binding.executionKey;
  const lastUsedAt = binding.lastUsedAt;
  const submissions = f.submissions.length;
  try {
    const replay = await f.send(compactBody);
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe("completed");
    expect(binding.state).toBe("running");
    expect(binding.executionKey).toBe(runningExecutionKey);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    expect(f.submissions).toHaveLength(submissions);
  } finally {
    f.controls.releaseDeferredCompletion?.();
  }
  expect((await (await running).json()).status).toBe("completed");
});

test("HTTP consecutive owned compactions may commit the same summary without confusing their transactions", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const firstCompactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const firstCompact = await (await f.send(firstCompactBody)).json() as { status: string; output: unknown[] };
  expect(firstCompact.status).toBe("completed");

  const nextBody = {
    ...f.body,
    input: [...history, ...firstCompact.output,
      { type: "message", role: "user", id: "repeat-original-instruction", content: "First continuity instruction.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-repeat-instruction" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-repeat-instruction" }) },
  };
  const next = await (await f.send(nextBody)).json() as { status: string; output: unknown[] };
  expect(next.status).toBe("completed");
  const secondSourceHistory = [...nextBody.input, ...next.output];
  const secondCompactBody = { ...nextBody, input: [...secondSourceHistory, { type: "compaction_trigger" }] };
  const secondCompact = await f.send(secondCompactBody);
  expect(secondCompact.status).toBe(200);
  const secondCompactResult = await secondCompact.json() as { status: string; output: unknown[] };
  expect(secondCompactResult.status).toBe("completed");

  const third = await f.send({
    ...nextBody,
    input: [...secondSourceHistory, ...secondCompactResult.output,
      { type: "message", role: "user", id: "work-after-repeated-checkpoint", content: "Continue after the repeated checkpoint.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-after-repeated-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-repeated-checkpoint" }) },
  });
  expect(third.status).toBe(200);
  expect((await third.json()).status).toBe("completed");

  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("ready");
  expect(binding.revision).toBe(2);
  expect([...binding.checkpoints.values()].map(checkpoint => [checkpoint.sourceRevision, checkpoint.revision]))
    .toEqual([[0, 1], [1, 2]]);
  expect(f.pages.size).toBe(1);
  const currentExecutionKey = binding.executionKey;
  const submissions = f.submissions.length;
  expect((await (await f.send(firstCompactBody)).json()).status).toBe("completed");
  expect((await (await f.send(secondCompactBody)).json()).status).toBe("completed");
  expect(binding.revision).toBe(2);
  expect(binding.executionKey).toBe(currentExecutionKey);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.pages.size).toBe(1);
});

test("HTTP exact compaction replay accepts reordered structured JSON without a second submission", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { status: string; output: unknown[] };
  expect(first.status).toBe("completed");
  const compactBody = { ...f.body, input: [...f.body.input, ...first.output, { type: "compaction_trigger" }] };
  const compact = await f.send(compactBody);
  expect(compact.status).toBe(200);
  expect((await compact.json()).status).toBe("completed");
  const submissions = f.submissions.length;
  const reordered = reverseJsonObjectKeys(compactBody);
  expect(reordered).toEqual(compactBody);

  const replay = await f.send(reordered);
  expect(replay.status).toBe(200);
  expect((await replay.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(submissions);
});

test("HTTP reordered reconnect replays commentary already journaled before observer disconnect", async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  f.controls.deferCompletion = true;
  const abort = new AbortController();
  const first = await f.send({ ...f.body, stream: true }, false, false, abort.signal);
  expect(first.status).toBe(200);
  const reader = first.body!.getReader();
  const decoder = new TextDecoder();
  let observed = "";
  while (!observed.includes("Checking the source before continuing.")) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(2_000).then(() => { throw new Error("Timed out waiting for streamed commentary"); }),
    ]);
    if (chunk.done) throw new Error("Stream ended before commentary was delivered");
    observed += decoder.decode(chunk.value, { stream: true });
  }
  abort.abort();
  await reader.cancel().catch(() => {});
  while (!f.controls.releaseDeferredCompletion) await Bun.sleep(1);
  f.controls.releaseDeferredCompletion();

  const reorderedInput = reverseJsonObjectKeys(f.body.input) as unknown[];
  expect(reorderedInput).toEqual(f.body.input);
  const replay = await f.send({ ...f.body, stream: false, input: reorderedInput });
  expect(replay.status).toBe(200);
  const result = await replay.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(result.status).toBe("completed");
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary"
    && JSON.stringify(item).includes("Checking the source before continuing."))).toBe(true);
  expect(f.submissions).toHaveLength(1);
});

for (const kind of ["ordinary", "checkpoint"] as const) test(`HTTP ${kind} resume accepts structurally identical input history with reordered JSON object keys`, async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { status: string; output: unknown[] };
  expect(first.status).toBe("completed");
  const sourceHistory = [...f.body.input, ...first.output];
  let input: unknown[];
  if (kind === "ordinary") {
    const reordered = reverseJsonObjectKeys(f.body.input) as unknown[];
    expect(reordered).toEqual(f.body.input);
    input = [...reordered, ...first.output];
  } else {
    const compactBody = { ...f.body, input: [...sourceHistory, { type: "compaction_trigger" }] };
    const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
    expect(compact.status).toBe("completed");
    const reordered = reverseJsonObjectKeys(sourceHistory) as unknown[];
    expect(reordered).toEqual(sourceHistory);
    input = [...reordered, ...compact.output];
  }
  const turnId = `turn-reordered-${kind}-input`;
  const response = await f.send({
    ...f.body,
    input: [...input,
      { type: "message", role: "user", id: `msg-${turnId}`, content: "Continue after canonical JSON normalization.",
        internal_chat_message_metadata_passthrough: { turn_id: turnId } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: turnId }) },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("completed");
  expect(f.pages.size).toBe(1);
});

for (const kind of ["tool-round", "next-turn", "compaction"] as const) test(`HTTP ${kind} accepts structurally identical output with reordered JSON object keys`, async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  if (kind === "tool-round") {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const output = first.output.map(item => Object.fromEntries(Object.entries(item).reverse()));
  expect(output).toEqual(first.output);

  const body = kind === "tool-round"
    ? { ...f.body, input: [...f.body.input, ...output,
      { type: "function_call_output", call_id: first.output.find(item => item.type === "function_call")!.call_id, output: "Accepted real fixture result" },
    ] }
    : kind === "next-turn"
      ? { ...f.body, input: [...f.body.input, ...output,
        { type: "message", id: "reordered-next-message", role: "user", content: "Continue the next authorized work.",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-reordered-next" } },
      ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-reordered-next" }) } }
      : { ...f.body, input: [...f.body.input, ...output, { type: "compaction_trigger" }] };
  const response = await f.send(body);
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("completed");
});

for (const kind of ["namespaced", "tool_search"] as const) test(`HTTP ${kind} native output round-trips under continuity`, async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = kind === "namespaced" ? "review_tools__exec_command" : "tool_search";
  const spec = (f.body.tools as Array<Record<string, unknown>>)[0]!;
  f.body.tools = kind === "namespaced"
    ? [{ type: "namespace", name: "review_tools", tools: [spec] }]
    : [{ type: "tool_search", description: "Fixture search, no external service is called", parameters: spec.parameters }];
  const first = await f.send(f.body);
  const result = await first.json() as { output: Array<Record<string, unknown>> };
  const callType = kind === "namespaced" ? "function_call" : "tool_search_call";
  const call = result.output.find(item => item.type === callType)!;
  if (kind === "namespaced") expect(call).toMatchObject({ name: "exec_command", namespace: "review_tools" });
  const continuation = await f.send({ ...f.body, input: [
    ...f.body.input, ...result.output,
    kind === "namespaced"
      ? { type: "function_call_output", call_id: call.call_id, output: "Actual fixture tool result: 42." }
      : { type: "tool_search_output", call_id: call.call_id, tools: [], status: "completed" },
  ] });
  expect(continuation.status).toBe(200);
  await continuation.text();
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP expired previous_response_id rejects partial input, then a full canonical resend uses the retained page", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body, false, true)).json();
  expect(first.status).toBe("completed");
  const next: Record<string, unknown> = {
    ...(f.next(parseRequest(f.body))._rawBody as Record<string, unknown>), model: f.body.model, reasoning: f.body.reasoning,
  };
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
  try {
    const partial = await f.send({ ...next, previous_response_id: first.id, input: (next.input as unknown[]).slice(-1) });
    expect(partial.status).toBe(409);
    expect(await partial.text()).toContain("previous_response_id");
    expect(f.pages.size).toBe(1);
    expect(f.submissions).toHaveLength(1);
    const full = await f.send(next);
    expect(full.status).toBe(200);
    expect((await full.json()).status).toBe("completed");
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  } finally { clock.mockRestore(); }
});

test("HTTP streamed compaction failure preserves its deterministic code and never emits a completed checkpoint", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  f.controls.handoffSummary = 'Invalid checkpoint.\nCODEX_LATEST_USER_PROMPT_JSON\n"A different instruction"';
  const body = { ...f.body, stream: true, input: [...f.body.input as unknown[], { type: "compaction_trigger" }] };
  const response = await f.send(body);
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('"type":"response.failed"');
  expect(stream).toContain('"code":"continuity_source_unproven"');
  expect(stream).not.toContain('"type":"response.completed"');
  const thread = continuityDigest(f.threadId);
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const initialWork = Object.values(before.works).find(work => work.purpose === "compaction")!;
  expect(initialWork).toBeDefined();
  const targetId = initialWork.compactionTargetId!;
  expect(Object.keys(before.compactionTargets)).toEqual([targetId]);
  expect(Object.keys(before.checkpoints)).toHaveLength(0);
  expect(initialWork.attempts.at(-1)).toMatchObject({ stage: "interrupted-settled", writerRetired: true });
  const repeated = await f.send(body);
  expect(repeated.status).toBe(200);
  const repeatedStream = await repeated.text();
  expect(repeatedStream).toContain('"type":"response.failed"');
  expect(repeatedStream).toContain('"code":"continuity_source_unproven"');
  expect(repeatedStream).not.toContain('"type":"response.completed"');
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const retriedWork = after.works[initialWork.logicalWorkId]!;
  expect(Object.keys(after.compactionTargets)).toEqual([targetId]);
  expect(retriedWork.compactionTargetId).toBe(targetId);
  expect(retriedWork.workPayloadDigest).toBe(initialWork.workPayloadDigest);
  expect(retriedWork.attempts).toHaveLength(initialWork.attempts.length + 1);
  expect(retriedWork.attempts.at(-1)).toMatchObject({
    attempt: initialWork.attempts.at(-1)!.attempt + 1, epoch: before.epoch + 1,
    stage: "interrupted-settled", writerRetired: true,
  });
  expect(retriedWork.retryBudget!.attempts).toBe(initialWork.retryBudget!.attempts + 1);
  expect(retriedWork.retryBudget!.startedAt).toBe(initialWork.retryBudget!.startedAt);
  expect(retriedWork.retryBudget!.lastFailureAt).toBeGreaterThanOrEqual(initialWork.retryBudget!.lastFailureAt!);
  expect(after.historyRevision).toBe(0);
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
  expect(after.calls).toEqual(before.calls);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.automatic.mock.calls.at(-1)![0]).toMatchObject({
    compaction: true, nativeConnector: true, capabilities: { localToolsEnabled: false },
  });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.key).not.toBe(f.submissions[1]!.key);
  expect(f.submissions[2]!.reused).toBe(false);
});

test("an ordinary Native route observes mode exit before forwarding upstream", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
  let forwarded = 0;
  try {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { authorization: "Bearer continuity-native-test-only", "content-type": "application/json" },
      body: JSON.stringify({ ...f.body, model: "gpt-native-fixture" }),
    }), f.config, () => { throw new Error("Native selection must not start a Web adapter"); }, {
      fetchNative: async () => {
        forwarded++;
        expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
        expect(f.pages.size).toBe(0);
        return Response.json({ id: "native-fixture-response", status: "completed", output: [] });
      },
    });
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
    expect(forwarded).toBe(1);
    const replay = await f.send(f.body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "Completed response 1." }] },
    ] });
    expect(f.pages.size).toBe(0);
    expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
    expect(f.submissions).toHaveLength(1);
  } finally { provider.mockRestore(); }
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} strictly resumes one leased page and exact reconnect does not submit again`, async () => {
  const f = fixture(manual);
  const first = f.request();
  const firstEvents = await f.run(first);
  expect(firstEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const second = f.next(first);
  second._continuityHistoryRevision = 999;
  const secondEvents = await f.run(second);
  expect(second._continuityHistoryRevision).toBe(0);
  expect(secondEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[0]!.key).toBe(f.submissions[1]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("First continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
  const repeated = await f.run(second);
  expect(repeated.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  if (manual) { expect(f.automatic).not.toHaveBeenCalled(); expect(f.compatible).not.toHaveBeenCalled(); }
});

test("automatic continuity keeps the same page with Bigger Context enabled and sends each input without staging", async () => {
  const f = fixture();
  f.provider.chatgptWeb!.experimentalBiggerContext = true;
  const first = f.request();
  first.options.reasoning = "medium";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const next = f.next(first);
  next.options.reasoning = "medium";
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
});

for (const biggerContext of [false, true]) test(`first input preflight rejects over-limit prompts with Bigger Context ${biggerContext}`, async () => {
  const f = fixture();
  f.provider.chatgptWeb!.experimentalBiggerContext = biggerContext;
  await expect(f.run(f.request("oversized ".repeat(100_000)))).rejects.toMatchObject({
    code: biggerContext ? "context_length_exceeded" : "continuity_input_limit", retryable: false,
  });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.submissions).toHaveLength(0);
  expect(f.pages.size).toBe(0);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} capacity rejection preserves the unused first-creation right`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.capacityAvailable = false;
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_resource_capacity", retryable: false });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(0);
  f.controls.capacityAvailable = true;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  f.controls.capacityAvailable = false;
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page launcher rejection keeps the claimed creation transaction retryable`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(0);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} unproved pre-page capacity error cannot authorize another Send`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.unknownPreLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const store = new ContinuityRecoveryStore(f.statePath);
  const before = store.get(continuityDigest(f.threadId))!;
  const attempt = before.works[before.currentWorkId!]!.attempts[0]!;
  expect(attempt.acquisitionEvidence?.status).toBe("possible");
  expect(attempt.sendEvidence?.status).toBe(manual ? "possible" : undefined);
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  const after = store.get(before.thread)!;
  expect(after.works[before.currentWorkId!]!.attempts).toHaveLength(1);
  expect(after.transaction!.transactionId).toBe(before.transaction!.transactionId);
  expect(f.submissions).toHaveLength(0);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} retryable initial creation keeps its first accepted payload and prompt`, async () => {
  const payload = fixture(manual);
  const first = payload.request();
  payload.controls.preLeaseFailures = 1;
  expect((await payload.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  await expect(payload.run(payload.request("Changed current instruction.", "turn-first")))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(payload.submissions).toHaveLength(0);

  const history = fixture(manual);
  const original = history.request("", "turn-first", [
    { type: "message", role: "user", id: "msg-history", content: "Original initial history.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-history" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Historical answer." }] },
    { type: "message", role: "user", id: "msg-turn-first", content: "First continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  history.controls.preLeaseFailures = 1;
  expect((await history.run(original)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const changedHistory = structuredClone(original);
  const changedInput = (changedHistory._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput[0]!.content = "Changed initial history.";
  expect((await history.run(changedHistory)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(history.submissions).toHaveLength(1);
  expect(history.submissions[0]!.prompt).toContain("Original initial history.");
  expect(history.submissions[0]!.prompt).not.toContain("Changed initial history.");
});

for (const manual of [false, true]) for (const retryable of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${retryable ? "creating" : "completed"} initial replay ignores completed ID-only history and removed turn metadata`, async () => {
  const f = fixture(manual);
  const first = f.request("", "turn-first", [
    { type: "message", role: "user", id: "old-with-turn", content: "Original completed history.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "assistant", content: "Old answer." },
    { type: "message", role: "user", id: "old-without-turn", content: "Original ID-only history." },
    { type: "message", role: "assistant", content: "Other old answer." },
    { type: "message", role: "user", id: "msg-turn-first", content: "Current instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  f.controls.preLeaseFailures = retryable ? 1 : 0;
  const accepted = await f.run(first);
  const input = structuredClone((first._rawBody as { input: Array<Record<string, unknown>> }).input);
  delete input[0]!.internal_chat_message_metadata_passthrough;
  input[0]!.content = "Changed completed history.";
  input[2]!.content = "Changed ID-only history.";
  const replay = await f.run(f.request("", "turn-first", input));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  if (!retryable) expect(replay).toEqual(accepted);
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[0]!.prompt).toContain("Original ID-only history.");
  expect(f.submissions[0]!.prompt).not.toContain("Changed ID-only history.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume rejects an unowned completed instruction before submitting`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", id: "completed-external", content: "Old external instruction." },
    { type: "message", role: "assistant", content: "Completed external response." },
    { type: "message", role: "user", id: "msg-turn-next", content: "Current next instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume retains adjacent ID-only and tagged current instructions`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", id: "current-constraint", content: "Keep this current constraint." },
    { type: "message", role: "user", id: "msg-turn-next", content: "Current next instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  const accepted = await f.run(next);
  expect(f.submissions[1]!.prompt).toContain("Keep this current constraint.");
  expect(f.submissions[1]!.prompt).toContain("Current next instruction.");
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  const changed = structuredClone(next);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === "current-constraint")!.content = "Changed current constraint.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) for (const terminal of ["interrupt", "mode-exit", "lost"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${terminal} ${terminal === "lost" ? "preserves" : "releases"} the captured input of failed initial creation`, async () => {
  const f = fixture(manual);
  f.controls.preLeaseFailures = 1;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("creating");
  expect(binding.initialAcceptedInput).toBeDefined();
  expect(binding.initialInstructionPayloadDigest).toBeDefined();
  const acceptedInput = binding.initialAcceptedInput;
  const acceptedPayloadDigest = binding.initialInstructionPayloadDigest;
  const recoveryStore = new ContinuityRecoveryStore(f.statePath);
  const originalRecovery = recoveryStore.get(continuityDigest(f.threadId))!;
  if (terminal === "interrupt") expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-first")).toBe(true);
  else if (terminal === "mode-exit") await leaveContinuityMode(f.statePath, f.threadId);
  else bindings.lose(binding, binding.executionKey);
  expect(binding.state).toBe(terminal === "lost" ? "lost" : "ended");
  if (terminal === "lost") {
    expect(binding.initialAcceptedInput).toEqual(acceptedInput);
    expect(binding.initialInstructionPayloadDigest).toBe(acceptedPayloadDigest);
    const accepted = await f.run(f.request());
    expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(await f.run(f.request())).toEqual(accepted);
    const recovered = recoveryStore.get(originalRecovery.thread)!;
    expect(recovered.transaction!.transactionId).toBe(originalRecovery.transaction!.transactionId);
    expect(recovered.transaction!.snapshotVersion).toBe(originalRecovery.transaction!.snapshotVersion);
    expect(recovered.works[originalRecovery.currentWorkId!]!.attempts).toHaveLength(1);
    expect(recovered.works[originalRecovery.currentWorkId!]!.retryBudget).toBeUndefined();
    expect(f.pages.size).toBe(1);
    expect(f.submissions).toHaveLength(1);
  } else {
    expect(binding.initialAcceptedInput).toBeUndefined();
    expect(binding.initialInstructionPayloadDigest).toBeUndefined();
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
    expect(f.pages.size).toBe(0);
    expect(f.submissions).toHaveLength(0);
  }
});

for (const manual of [false, true]) for (const checkpoint of [false, true]) for (const tagged of [false, true]) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${checkpoint ? "checkpoint" : "ordinary"} increment keeps ${tagged ? "tagged" : "ID-only"} ${trailing ? "trailing" : "leading"} current system and developer constraints`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = checkpoint;
  f.controls.singleSourceTool = true;
  const first = f.request("", "turn-first", [
    { type: "message", role: "system", content: "OLD_SYSTEM_CONTEXT.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "developer", content: "OLD_DEVELOPER_CONTEXT.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    ...(f.request()._rawBody as { input: unknown[] }).input,
  ]);
  await f.run(first);
  let base: unknown[] = [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
  ];
  if (checkpoint) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Actual checkpoint source result." },
    ]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    base = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
    f.controls.invokeSourceTools = false;
  }
  const envelopes = (["system", "developer"] as const).map(role => ({
      type: "message", role, id: `current-${role}`, content: `CURRENT_${role.toUpperCase()}_CONSTRAINT.`,
      ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } } : {}),
    }));
  const next = f.request("", "turn-next", [
    ...base,
    ...(!trailing ? envelopes : []),
    { type: "message", role: "user", id: "msg-turn-next", content: "Current work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    ...(trailing ? envelopes : []),
  ]);
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  expect(prompt).toContain("CURRENT_SYSTEM_CONSTRAINT.");
  expect(prompt).toContain("CURRENT_DEVELOPER_CONSTRAINT.");
  expect(prompt).not.toContain("OLD_SYSTEM_CONTEXT.");
  expect(prompt).not.toContain("OLD_DEVELOPER_CONTEXT.");
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  for (const role of ["system", "developer"] as const) {
    const changed = structuredClone(next);
    (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === `current-${role}`)!.content = "Conflicting current constraint.";
    await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const role of ["system", "developer"] as const) for (const tagged of [false, true]) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} failed first creation rejects changed ${tagged ? "tagged" : "untagged"} ${trailing ? "trailing" : "leading"} ${role} constraint`, async () => {
  const f = fixture(manual);
  const envelope = { type: "message", role, id: "current-envelope", content: "Accepted current constraint.",
    ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}) };
  const first = f.request("", "turn-first", [
    ...(!trailing ? [envelope] : []),
    ...(f.request()._rawBody as { input: unknown[] }).input,
    ...(trailing ? [envelope] : []),
  ]);
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const changed = structuredClone(first);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === "current-envelope")!.content = "Conflicting current constraint.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(0);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) for (const retainSource of [false, true]) for (const tagged of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint-only keeps ${tagged ? "tagged" : "untagged"} trailing constraints with source ${retainSource ? "retained" : "recovered"}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint source result." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const continuation = f.request("", "turn-first", [
    ...(retainSource ? (first._rawBody as { input: unknown[] }).input : []),
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(["system", "developer"] as const).map(role => ({
      type: "message", role, id: `tail-${role}`, content: `CURRENT_CHECKPOINT_${role.toUpperCase()}.`,
      ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}),
    })),
  ]);
  const accepted = await f.run(continuation);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt).toContain("CURRENT_CHECKPOINT_SYSTEM.");
  expect(f.submissions.at(-1)!.prompt).toContain("CURRENT_CHECKPOINT_DEVELOPER.");
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  for (const role of ["system", "developer"] as const) {
    const changed = structuredClone(continuation);
    (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === `tail-${role}`)!.content = "Changed checkpoint constraint.";
    await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${entry} keeps a ${trailing ? "trailing" : "leading"} prior-turn abort notice contextual`, async () => {
  const f = fixture(manual);
  const first = f.request();
  let base: unknown[] = [];
  if (entry !== "initial") {
    f.controls.invokeSourceTools = entry === "checkpoint";
    f.controls.singleSourceTool = manual;
    await f.run(first);
    base = [...(first._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: "Completed response 1." }];
    if (entry === "checkpoint") {
      const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
      const compact = f.request("", "turn-first", [
        ...(first._rawBody as { input: unknown[] }).input,
        recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
      ]);
      compact._compactionRequest = true;
      const summary = (await f.run(compact)).find(event => event.type === "text_delta");
      if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
      base = [...(first._rawBody as { input: unknown[] }).input,
        { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
      f.controls.invokeSourceTools = false;
    }
  }
  const notice = { type: "message", role: "user", ...(trailing ? { id: "prior-notice" } : {}),
    content: "<turn_aborted>The previous turn was interrupted.</turn_aborted>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-prior" } };
  const current = { type: "message", role: "user", id: "current-task", content: "Current valid task.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } };
  const request = f.request("", "turn-next", [...base, ...(trailing ? [current, notice] : [notice, current])]);
  const submissions = f.submissions.length;
  const accepted = await f.run(request);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.prompt).toContain("Current valid task.");
  if (entry !== "initial") expect(f.submissions.at(-1)!.prompt).not.toContain("previous turn was interrupted");
  expect(await f.run(structuredClone(request))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} current-turn abort literal remains work while an anonymous notice rejects`, async () => {
  const f = fixture(manual);
  const literal = "<turn_aborted>Explain this tag.</turn_aborted>";
  const first = f.request(literal);
  const accepted = await f.run(first);
  expect(f.submissions[0]!.prompt).toContain(literal);
  const anonymous = f.next(first);
  ((anonymous._rawBody as { input: unknown[] }).input).push({
    type: "message", role: "user", content: "<turn_aborted>Unknown ownership.</turn_aborted>",
  });
  await expect(f.run(anonymous)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect(await f.run(structuredClone(first))).toEqual(accepted);
});

for (const manual of [false, true]) for (const parentFirst of [false, true]) for (const checkpointOnly of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${checkpointOnly ? "checkpoint-only" : "initial"} current native role change rejects after ${parentFirst ? "parent" : "human"} input`, async () => {
  const f = fixture(manual);
  const raw = structuredClone(f.request("Same current text.")._rawBody) as {
    client_metadata: Record<string, string>; input: Array<Record<string, unknown>>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: f.threadId, turn_id: "turn-first", subagent_kind: "thread_spawn", request_kind: "turn",
    parent_thread_id: "thread-parent", agent_name: "/root/child",
  });
  const human = raw.input[0]!;
  const parent = { ...human, type: "agent_message", author: "/root", recipient: "/root/child" };
  delete (parent as Record<string, unknown>).role;
  let checkpoint: unknown[] = [];
  const request = (item: Record<string, unknown>) => {
    const parsed = parseRequest({ ...raw, input: [item, ...checkpoint] });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const firstItem = parentFirst ? parent : human;
  const first = request(firstItem);
  f.controls.invokeSourceTools = checkpointOnly;
  f.controls.singleSourceTool = manual;
  let accepted = await f.run(first);
  if (checkpointOnly) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = parseRequest({ ...raw, input: [firstItem,
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." }] });
    compact._conversationPolicy = "task";
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    checkpoint = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
    f.controls.invokeSourceTools = false;
    accepted = await f.run(request(firstItem));
  }
  await expect(f.run(request(parentFirst ? human : parent))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(await f.run(request(firstItem))).toEqual(accepted);
  expect(f.submissions).toHaveLength(checkpointOnly ? manual ? 2 : 3 : 1);
});

for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${entry} rejects ${trailing ? "trailing" : "leading"} anonymous current instruction before submitting`, async () => {
  const f = fixture(manual);
  const first = f.request();
  let base: unknown[] = [];
  if (entry !== "initial") {
    f.controls.invokeSourceTools = entry === "checkpoint";
    f.controls.singleSourceTool = manual;
    await f.run(first);
    base = [...(first._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: "Completed response 1." }];
    if (entry === "checkpoint") {
      const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
      const compact = f.request("", "turn-first", [
        ...(first._rawBody as { input: unknown[] }).input,
        recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
      ]);
      compact._compactionRequest = true;
      const summary = (await f.run(compact)).find(event => event.type === "text_delta");
      if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
      base = [...(first._rawBody as { input: unknown[] }).input,
        { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
      f.controls.invokeSourceTools = false;
    }
  }
  const anonymous = { type: "message", role: "user", content: "Required current constraint without identity." };
  const current = { type: "message", role: "user", id: "current-task", content: "Current task.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } };
  const input = [...base, ...(trailing ? [current, anonymous] : [anonymous, current])];
  const submissions = f.submissions.length;
  await expect(f.run(f.request("", "turn-next", input))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const changed = input.map(item => item === anonymous ? { ...anonymous, content: "Conflicting anonymous constraint." } : item);
  await expect(f.run(f.request("", "turn-next", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(f.request("", "turn-next", [...base, current]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} anonymous completed history does not enter the current payload`, async () => {
  const f = fixture(manual);
  const first = f.request("", "turn-first", [
    { type: "message", role: "user", content: "Old anonymous completed task." },
    { type: "message", role: "assistant", content: "Old completed answer." },
    ...(f.request()._rawBody as { input: unknown[] }).input,
  ]);
  const accepted = await f.run(first);
  const changed = structuredClone(first);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.content = "Changed completed history.";
  expect(await f.run(changed)).toEqual(accepted);
  expect((await f.run(f.next(changed))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).not.toContain("anonymous completed task");
  expect(f.submissions[1]!.prompt).not.toContain("Changed completed history");
});

test("Automatic reclaimed result replay rejects without retiring the current owner", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const result = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Accepted first result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const priorBatch = snapshot.lastToolBatchRevision;
  const next = f.run(result);
  while (snapshot.lastToolBatchRevision === priorBatch) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  await next;
  const currentCall = source.outstanding()[0]!.callId;
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const lease = { ...binding.lease! };
  for (let index = 0; index < 510; index++) source.completeRound(`completed-capacity-probe-${index}`);
  expect(source.continuityToolResultRoundKey(result)).toBe("tool-batch:1");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const predecessor = source.runExclusive(async () => {
    await gate;
    source.completeRound("causal-round-completed-before-replay");
  });
  const retry = structuredClone(result);
  const adapter = f.adapter();
  await adapter.preflight!(retry, { headers: new Headers() });
  let queued!: () => void;
  const enqueued = new Promise<void>(resolve => { queued = resolve; });
  const runExclusive = source.runExclusive.bind(source);
  const exclusive = spyOn(source, "runExclusive").mockImplementation(<T>(task: () => Promise<T>) => {
    queued();
    return runExclusive(task);
  });
  const replay = adapter.runTurn!(retry, { headers: new Headers() }, () => {}).catch(error => error);
  await enqueued;
  exclusive.mockRestore();
  release();
  await predecessor;
  expect(await replay).toMatchObject({ code: "continuity_source_unproven" });
  expect(source.roundEvents("tool-batch:1")).toEqual([]);
  expect(source.roundCompleted("tool-batch:1")).toBe(false);
  expect(binding.state).toBe("running");
  expect(binding.lease).toEqual(lease);
  expect(source.outstanding()[0]!.callId).toBe(currentCall);
  expect(f.controls.toolResults).toHaveLength(1);
  expect((await f.run(f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: currentCall, output: "Accepted current result." },
  ]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} anonymous current steering is rejected instead of replaying old work`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const steering = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", content: "New steering without native identity." },
  ]);
  await expect(f.run(steering)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same-turn steering excludes explicitly foreign-turn work and constraints`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    ...(["system", "developer", "user"] as const).map(role => ({
      type: "message", role, id: `foreign-${role}`, content: `OLD_FOREIGN_${role.toUpperCase()}_WORK.`,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" },
    })),
    { type: "message", role: "assistant", content: "Completed old work." },
    { type: "message", role: "user", id: "current-steering", content: "Current steering instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions[1]!.prompt).toContain("Current steering instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("OLD_FOREIGN_");
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent initial preflights reject a conflicting payload and preserve the accepted retry`, async () => {
  const f = fixture(manual);
  const requests = [f.request("First payload."), f.request("Conflicting payload.")];
  const adapters = requests.map(() => f.adapter());
  let capacityQueries = 0;
  f.controls.onCapacityQuery = () => { capacityQueries += 1; };
  const outcomes = await Promise.allSettled(requests.map((parsed, index) => (
    adapters[index]!.preflight!(parsed, { headers: new Headers() })
  )));
  expect(capacityQueries).toBe(2);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(outcome => outcome.status === "rejected"))
    .toMatchObject({ reason: { code: "continuity_source_unproven" } });
  const acceptedIndex = outcomes.findIndex(outcome => outcome.status === "fulfilled");
  const accepted = requests[acceptedIndex]!;
  f.controls.preLeaseFailures = 1;
  const events: AdapterEvent[] = [];
  await adapters[acceptedIndex]!.runTurn!(accepted, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect((await f.run(structuredClone(accepted))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[0]!.prompt).toContain(accepted.context.messages[0]!.content as string);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent initial preflights with changed history share the first captured prompt`, async () => {
  const f = fixture(manual);
  const requests = ["Initial history A.", "Initial history B."].map(content => f.request("", "turn-first", [
    { type: "message", role: "user", id: "old-instruction", content,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "assistant", content: "Completed old answer." },
    { type: "message", role: "user", id: "msg-turn-first", content: "Current instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]));
  const adapters = requests.map(() => f.adapter());
  const accepted: number[] = [];
  await Promise.all(requests.map(async (parsed, index) => {
    await adapters[index]!.preflight!(parsed, { headers: new Headers() });
    accepted.push(index);
  }));
  const events: AdapterEvent[] = [];
  const laterIndex = accepted[1]!;
  await adapters[laterIndex]!.runTurn!(requests[laterIndex]!, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]!.prompt).toContain(requests[accepted[0]!]!.context.messages[0]!.content as string);
  expect(f.submissions[0]!.prompt).not.toContain(requests[laterIndex]!.context.messages[0]!.content as string);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page creation failure can be abandoned by leaving continuity`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page creation failure can be abandoned by native interrupt`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-other")).toBe(false);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-first")).toBe(true);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  await leaveContinuityMode(f.statePath, f.threadId);
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} lost initial start acknowledgement reconciles the exact provisional page`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.loseStartAcknowledgementOnce = true;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`limited takeover notice waits for a real submission and is consumed once manual=${manual}`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  f.pages.clear();
  f.controls.retirementCleanup = "pending";
  const next = f.next(first);
  const adapter = f.adapter();
  await adapter.preflight!(next, { headers: new Headers() });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  expect(bindings.recoveryStore.get(thread)!.takeoverNoticePending).toBe(true);
  expect(f.submissions).toHaveLength(1);
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(next, { headers: new Headers() }, event => events.push(event));
  expect(events.filter(event => event.type === "text_delta" && event.text.includes("ChatGPT's own activities may still be running"))).toHaveLength(1);
  expect(bindings.recoveryStore.get(thread)!.takeoverNoticePending).toBe(false);
  const consumed = bindings.recoveryStore.get(thread)!;
  const replay = await f.run(structuredClone(next));
  expect(replay).toEqual(events);
  expect(bindings.recoveryStore.get(thread)).toEqual(consumed);
  expect(f.submissions).toHaveLength(2);
});

test("a missing physical page starts one replacement epoch and exact retries replay its result", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const sourceEpoch = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(f.threadId))!.epoch;
  const sourceKey = f.submissions[0]!.key;
  f.pages.clear();
  const next = f.next(first);
  const recovered = await f.run(next);
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(next))).toEqual(recovered);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(sourceKey);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.pages.size).toBe(1);
  expect(f.registrations.get(continuityDigest(f.threadId))).toMatchObject({ state: "entered", epoch: sourceEpoch + 1 });
});

test("disconnect during initial capacity preflight does not consume registration or start a page", async () => {
  const f = fixture();
  const first = f.request();
  const controller = new AbortController();
  f.controls.onCapacityQuery = () => controller.abort();
  await expect(f.adapter().preflight!(first, { headers: new Headers(), abortSignal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.submissions).toHaveLength(0);
  f.controls.onCapacityQuery = undefined;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
});

test("an uninitialized store, old launcher, and conflicting configuration fail before creating a page", async () => {
  const f = fixture();
  writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor, features: [] }));
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  rmSync(f.statePath, { recursive: true, force: true });
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(f.submissions).toHaveLength(0);
});

test("summary-only, compaction, and tool-result continuations cannot claim the initial creation right", async () => {
  const f = fixture();
  const summary = { type: "compaction", encrypted_content: encodeCompactionSummary("Inherited checkpoint") };
  const onlySummary = f.request("", "turn-first", [summary]);
  await expect(f.run(onlySummary)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const compact = f.request(); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const tool = f.request("", "turn-first", [
    ...(f.request()._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: "unowned-call", output: "finished" },
  ]);
  await expect(f.run(tool)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  const valid = f.request("", "turn-first", [summary, ...(f.request()._rawBody as { input: unknown[] }).input]);
  await f.run(valid);
  expect(f.submissions).toHaveLength(1);
});

test("changed completed assistant history does not block a clear new native instruction", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const changed = f.next(first, "turn-next", "Invented final answer");
  expect((await f.run(changed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Invented final answer");
});

test("an invented checkpoint cannot advance revision even when a clear current instruction follows", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const changed = f.next(first);
  (changed._rawBody as { input: unknown[] }).input.unshift({ type: "compaction", encrypted_content: encodeCompactionSummary("Invented checkpoint") });
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

test("ordinary resume ignores completed foreign history before a clear new instruction", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const repeated = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Foreign tool result." },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next", content: "Next continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  expect((await f.run(repeated)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Foreign execution record.");
  expect(JSON.stringify(taskEnvelope(f.submissions[1]!.prompt))).not.toContain("Foreign tool result.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume keeps every new current-turn instruction item`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next-constraint", content: "Constraint: keep both new items.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    { type: "message", role: "user", id: "msg-turn-next", content: "Execute the next task.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Constraint: keep both new items.");
  expect(f.submissions[1]!.prompt).toContain("Execute the next task.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} cross-turn resume excludes an old item-ID-only instruction before explicit current work`, async () => {
  const f = fixture(manual);
  const first = f.request("Historical instruction A.", "turn-a");
  await f.run(first);
  const history = structuredClone((first._rawBody as { input: unknown[] }).input);
  delete (history[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const next = f.request("", "turn-b", [
    ...history,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-b", content: "Current instruction B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-b" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Current instruction B.");
  expect(f.submissions[1]!.prompt).not.toContain("Historical instruction A.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} replay binds every instruction item in the accepted current work set`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next-constraint", content: "Constraint A.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    { type: "message", role: "user", id: "msg-turn-next", content: "Stable task B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await f.run(next);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const acceptedInput = source.canonicalInput();
  const changed = structuredClone(next);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.id === "msg-turn-next-constraint")!.content = "Changed constraint A'.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
  expect(source.canonicalInput()).toEqual(acceptedInput);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same native instruction identity cannot replace its accepted current payload`, async () => {
  const f = fixture(manual);
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const changed = f.request("Changed current instruction.", "turn-first");
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} settled replay cannot replace the owned canonical input`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const foreignReplay = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unowned execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  await expect(f.run(foreignReplay)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  const next = f.next(first);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} detached final locks canonical input before the first reconnect`, async () => {
  const f = fixture(manual);
  f.controls.deferCompletion = true;
  const parsed = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const namespace = chatGptWebExecutionNamespace(f.provider);
  const source = chatGptTurnSessions.find(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)!;
  if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  else f.controls.releaseDeferredCompletion!();
  expect(await source.browserOutcome).toEqual({ type: "final", answer: "Completed response 1." });
  await source.physicalSettlement;
  const foreignReplay = f.request("", "turn-first", [
    ...(parsed._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  const foreignCompact = structuredClone(foreignReplay);
  foreignCompact._compactionRequest = true;
  await expect(f.run(foreignCompact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  await expect(f.run(foreignReplay)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect((await f.run(parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} completed historical assistant changes replay the accepted result round`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const canonical = [...(next._rawBody as { input: unknown[] }).input];
  expect(source.canonicalInput()).toEqual(canonical);
  const foreignReplay = f.request("", "turn-first", [
    ...canonical,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
  ]);
  expect((await f.run(foreignReplay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} accepted local tool result payload cannot be replaced by a retry`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const accepted = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Accepted result A." },
  ]);
  expect((await f.run(accepted)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
  const changed = structuredClone(accepted);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.type === "function_call_output")!.output = "Conflicting result B.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
});

for (const mutation of ["tools", "status"] as const) test(`Automatic accepted tool_search_output ${mutation} cannot change before its result round completes`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = "tool_search";
  const initialRaw = structuredClone(f.request()._rawBody) as Record<string, unknown> & {
    input: unknown[];
    tools: Array<Record<string, unknown>>;
  };
  const functionSpec = initialRaw.tools[0]!;
  initialRaw.tools = [{
    type: "tool_search",
    description: "Fixture search, no external service is called",
    parameters: functionSpec.parameters,
  }];
  const first = parseRequest(initialRaw);
  first._conversationPolicy = "task";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;

  const acceptedRaw = structuredClone(initialRaw);
  acceptedRaw.input = [
    ...initialRaw.input,
    { type: "tool_search_call", call_id: call.callId, arguments: { query: "fixture" } },
    { type: "tool_search_output", call_id: call.callId, tools: [], status: "completed" },
  ];
  const accepted = parseRequest(acceptedRaw);
  accepted._conversationPolicy = "task";
  f.controls.pauseAfterToolResults = true;
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(accepted, { headers: new Headers() });
  const interrupted = adapter.runTurn!(accepted, { headers: new Headers(), abortSignal: abort.signal }, () => {})
    .catch(error => error);
  while (!f.controls.releaseAfterToolResults) await Bun.sleep(1);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(source.roundCompleted(source.continuityRoundKey(accepted))).toBeFalse();
  abort.abort();
  expect(await interrupted).toMatchObject({ name: "AbortError" });

  const changedRaw = structuredClone(acceptedRaw);
  const changedResult = changedRaw.input.find(item => (
    item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).type === "tool_search_output"
  )) as Record<string, unknown>;
  if (mutation === "tools") {
    changedResult.tools = [{ type: "function", name: "loaded_tool", description: "Loaded fixture tool", parameters: { type: "object" } }];
  } else {
    changedResult.status = "failed";
  }
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "task";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });

  f.controls.pauseAfterToolResults = false;
  f.controls.releaseAfterToolResults!();
  expect((await f.run(accepted)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
});

test("Automatic local parallel result batch accepts reordered results once", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  f.controls.parallelSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const calls = source.outstanding();
  expect(calls).toHaveLength(2);
  const results = calls.map((call, index) => ({
    type: "function_call_output", call_id: call.callId, output: `Parallel result ${index + 1}.`,
  })).reverse();
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...results,
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
  expect(source.outstanding()).toHaveLength(0);
  expect((await f.run(structuredClone(next))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const invalid of ["incomplete", "duplicate", "wrong-type", "unknown"] as const) {
  test(`Automatic local parallel result batch rejects ${invalid} current results before delivery`, async () => {
    const f = fixture();
    f.controls.invokeSourceTools = true;
    f.controls.parallelSourceTools = true;
    const first = f.request();
    expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const calls = source.outstanding();
    expect(calls).toHaveLength(2);
    const valid = calls.map((call, index) => ({
      type: "function_call_output", call_id: call.callId, output: `Parallel result ${index + 1}.`,
    }));
    const results: unknown[] = invalid === "incomplete" ? [valid[0]]
      : invalid === "duplicate" ? [valid[0], structuredClone(valid[0])]
      : invalid === "wrong-type" ? [{ ...valid[0], type: "custom_tool_call_output" }, valid[1]]
      : [...valid, { type: "function_call_output", call_id: "unknown-current-call", output: "Foreign result." }];
    const next = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      ...results,
    ]);
    await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.controls.toolResults).toHaveLength(0);
    expect(source.outstanding()).toHaveLength(2);
    expect(f.submissions).toHaveLength(1);
  });
}

test("a lost manual end acknowledgement preserves its accepted answer and reuses the verified page for new work", async () => {
  const f = fixture(true);
  f.controls.endFailure = true;
  const first = f.request();
  const accepted = await f.run(first);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const source = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const sourceEpoch = source.epoch;
  expect(source.state).toBe("ready");
  expect(await f.run(structuredClone(first))).toEqual(accepted);
  expect(f.submissions).toHaveLength(1);
  f.controls.endFailure = false;
  const next = f.next(first);
  const recovered = await f.run(next);
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(next))).toEqual(recovered);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.pages.size).toBe(1);
  expect(continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!.epoch).toBe(sourceEpoch);
});

test("a manual HTTP observer disconnect does not cancel the retained execution", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const parsed = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const namespace = chatGptWebExecutionNamespace(f.provider);
  expect(chatGptTurnSessions.find(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)?.isActive()).toBe(true);
  f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  expect((await f.run(parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  const document = JSON.parse(readFileSync(join(f.statePath, "threads.json"), "utf8"));
  const stored = document.entries[continuityDigest(f.threadId)];
  expect(continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)?.state).toBe("ready");
});

async function completedInspectionFixture(manual: boolean) {
  const f = fixture(manual);
  let releaseInspection!: () => void, inspectionEntered!: () => void, executionStarted!: () => void;
  const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
  const started = new Promise<void>(resolve => { executionStarted = resolve; });
  f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
  f.controls.onStarted = executionStarted;
  f.controls.deferCompletion = true;
  cleanups.push(async () => { releaseInspection(); });
  const parsed = f.request(), adapter = f.adapter(), originalAbort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: originalAbort.signal }, () => {}).catch(error => error);
  await started;
  originalAbort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  else f.controls.releaseDeferredCompletion!();
  await inspected;
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(parsed)}`)!;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), before = store.get(thread)!;
  expect(source.isActive()).toBe(true);
  expect(source.settledOutcome()).toBeUndefined();
  expect(before.works[before.currentWorkId!]!).toMatchObject({ state: "completed", terminalDigest: recoveryDigest("Completed response 1.") });
  expect(before.works[before.currentWorkId!]!.attempts.at(-1)).toMatchObject({ stage: "completed", writerRetired: true });
  expect(source.runtime.recoveryOrigin).toMatchObject({ scope: before.scope, logicalWorkId: before.currentWorkId,
    ownerId: before.owner.id, attempt: 0, epoch: before.epoch });
  return { ...f, parsed, source, store, thread, before, releaseInspection };
}

for (const manual of [false, true]) for (const boundary of ["settles", "observer-aborts", "business-deadline", "source-conflict", "stops", "successor"] as const) {
  test(`review repair3: ${manual ? "Zero Risk" : "Automatic"} exact completed reconnect ${boundary}`, async () => {
    const f = await completedInspectionFixture(manual);
    const update = spyOn(f.broker, "updateEnvironment");
    cleanups.push(async () => { update.mockRestore(); });
    if (boundary === "source-conflict") {
      const raw = structuredClone(f.parsed._rawBody) as { input: Array<Record<string, unknown>> };
      raw.input[0]!.content = "A conflicting body for the already accepted instruction.";
      const changed = parseRequest(raw); changed._conversationPolicy = "task";
      await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
      f.releaseInspection();
      expect((await f.run(f.parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    } else {
      let canonicalChecked!: () => void;
      const checked = new Promise<void>(resolve => { canonicalChecked = resolve; });
      const adapter = f.adapter(), abort = new AbortController(), events: AdapterEvent[] = [];
      await adapter.preflight!(f.parsed, { headers: new Headers() });
      const assertCanonical = f.source.assertCanonicalReplayInput.bind(f.source);
      const canonical = spyOn(f.source, "assertCanonicalReplayInput").mockImplementation(input => { assertCanonical(input); canonicalChecked(); });
      cleanups.push(async () => { canonical.mockRestore(); });
      let returned = false;
      const reconnect = adapter.runTurn!(f.parsed, { headers: new Headers(), abortSignal: abort.signal }, event => events.push(event))
        .then(() => { returned = true; }, error => { returned = true; return error; });
      await checked;
      expect(returned).toBe(false);
      expect(update).not.toHaveBeenCalled();
      if (boundary === "observer-aborts") {
        abort.abort();
        expect(await reconnect).toMatchObject({ name: "AbortError" });
        expect(f.source.isActive()).toBe(true);
        expect(f.store.get(f.thread)).toEqual(f.before);
        f.releaseInspection();
        expect((await f.run(f.parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
      } else if (boundary === "business-deadline") {
        // Deliver the original runtime's deadline failure while its physical cleanup is held.
        // The reconnect must consume that failure before the cleanup gate opens.
        f.source.runtime.cancel(chatGptToolTimeoutError("fixture-command-not-executed-by-this-test", 1000));
        expect(await reconnect).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "error", code: "codex_tool_timeout", status: 504 });
        expect(f.source.isPhysicallySettled()).toBe(false);
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.attempts).toEqual(f.before.works[f.before.currentWorkId!]!.attempts);
        f.releaseInspection();
        await f.source.physicalSettlement;
      } else if (boundary === "stops" || boundary === "successor") {
        if (boundary === "stops") f.store.stopWork(f.thread, { scope: f.before.scope }, f.before.currentWorkId!, "user-stop");
        else {
          const next = f.next(f.parsed, "turn-after-durable-final");
          f.store.admitWork({ thread: f.thread, scope: f.before.scope, owner: continuityProcessInstance(),
            logicalWorkId: continuityDigest([f.thread, "turn-after-durable-final"]), instructionIdentity: "turn-after-durable-final",
            nativeTurnId: "turn-after-durable-final", workPayloadDigest: recoveryDigest(next._rawBody),
            snapshotDigest: recoveryDigest(next._rawBody), dispatchProtocolComplete: true, createPage: true });
          expect(f.store.get(f.thread)!.epoch).toBe(f.before.epoch + 1);
        }
        f.releaseInspection();
        expect(await reconnect).toMatchObject({ code: "continuity_source_unproven" });
        expect(events.some(event => event.type === "done")).toBe(false);
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.terminalDigest).toBe(f.before.works[f.before.currentWorkId!]!.terminalDigest);
      } else {
        f.releaseInspection();
        expect(await reconnect).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer").map(event => event.type === "text_delta" ? event.text : "").join("")).toBe("Completed response 1.");
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.attempts).toEqual(f.before.works[f.before.currentWorkId!]!.attempts);
      }
    }
    expect(update).not.toHaveBeenCalled();
    expect(f.submissions).toHaveLength(1);
  });
}

for (const manual of [false, true]) for (const boundary of ["same-work", "successor", "renamed-error", "lookalike-error"] as const) {
  test(`review repair3: ${manual ? "Zero Risk" : "Automatic"} environment RPC crossing completion ${boundary}`, async () => {
    const successor = boundary === "successor";
    const rejects = successor || boundary === "lookalike-error";
    const f = fixture(manual);
    let started!: () => void, inspectionEntered!: () => void, releaseInspection!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
    f.controls.onStarted = started; f.controls.deferCompletion = true;
    f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
    cleanups.push(async () => { releaseInspection(); });
    const parsed = f.request(), original = f.adapter(), originalAbort = new AbortController();
    await original.preflight!(parsed, { headers: new Headers() });
    const detached = original.runTurn!(parsed, { headers: new Headers(), abortSignal: originalAbort.signal }, () => {}).catch(error => error);
    await starting; originalAbort.abort();
    expect(await detached).toMatchObject({ name: "AbortError" });
    let rpcEntered!: () => void, releaseRpc!: () => void, rpcRejected!: (error: unknown) => void;
    const entered = new Promise<void>(resolve => { rpcEntered = resolve; });
    const reply = new Promise<void>(resolve => { releaseRpc = resolve; });
    const rejected = new Promise<unknown>(resolve => { rpcRejected = resolve; });
    const updateEnvironment = f.broker.updateEnvironment.bind(f.broker);
    const update = spyOn(f.broker, "updateEnvironment").mockImplementation(async (...args) => {
      rpcEntered(); await reply;
      try { return await updateEnvironment(...args); }
      catch (error) {
        if (boundary === "renamed-error" && error instanceof Error) error.message = "The writer ended; wording is not a protocol field.";
        const returned = boundary === "lookalike-error"
          ? continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt.") : error;
        rpcRejected(returned); throw returned;
      }
    });
    cleanups.push(async () => { releaseRpc(); update.mockRestore(); });
    const adapter = f.adapter(), events: AdapterEvent[] = [];
    await adapter.preflight!(parsed, { headers: new Headers() });
    let returned = false;
    const reconnect = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event))
      .then(() => { returned = true; }, error => { returned = true; return error; });
    await entered;
    if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
    else f.controls.releaseDeferredCompletion!();
    await inspected;
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(parsed)}`)!;
    const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), completed = store.get(thread)!;
    expect(completed.works[completed.currentWorkId!]!.state).toBe("completed");
    if (successor) {
      const next = f.next(parsed, "turn-rpc-successor");
      store.admitWork({ thread, scope: completed.scope, owner: continuityProcessInstance(),
        logicalWorkId: continuityDigest([thread, "turn-rpc-successor"]), instructionIdentity: "turn-rpc-successor", nativeTurnId: "turn-rpc-successor",
        workPayloadDigest: recoveryDigest(next._rawBody), snapshotDigest: recoveryDigest(next._rawBody), dispatchProtocolComplete: true, createPage: true });
    }
    releaseRpc();
    expect(await rejected).toMatchObject({ code: "continuity_source_unproven" });
    if (rejects) {
      if (boundary === "lookalike-error") releaseInspection();
      expect(await reconnect).toMatchObject({ code: "continuity_source_unproven" });
      expect(events.some(event => event.type === "done")).toBe(false);
      releaseInspection();
      await source.physicalSettlement;
    } else {
      expect(returned).toBe(false);
      releaseInspection();
      expect(await reconnect).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(store.get(thread)!.works[completed.currentWorkId!]!.terminalDigest).toBe(recoveryDigest("Completed response 1."));
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(f.submissions).toHaveLength(1);
  });
}

test("Automatic completed compaction retains the exact page and concurrent retries share one structured handoff", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const [left, right] = await Promise.all([f.run(compact), f.run(structuredClone(compact))]);
  expect(left.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(right.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(left.find(event => event.type === "text_delta")).toEqual(right.find(event => event.type === "text_delta"));
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.pages.size).toBe(1);
  expect([...f.pages.values()][0]?.state).toBe("ready");
  const replay = await f.run(structuredClone(compact));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`);
  expect(source?.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  expect(source?.conversationKey()).toBeUndefined();
  f.pages.clear();
  expect(await f.run(structuredClone(compact))).toEqual(replay);
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(2);
});

test("Automatic shared compaction is cancelled by a later request's native turn identity", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  let release!: () => void;
  const gate = source.runExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await Bun.sleep(0);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const pending = f.run(compact).catch(error => error);
  const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(compact)}`;
  while (!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  const retry = f.request("", "turn-compaction-retry", (first._rawBody as { input: unknown[] }).input);
  retry._compactionRequest = true;
  const adapter = f.adapter();
  await adapter.preflight!(retry, { headers: new Headers() });
  const retried = adapter.runTurn!(retry, { headers: new Headers() }, () => {}).catch(error => error);
  const cancellation = cancelStructuredCompactionNativeTurn(f.threadId, "turn-compaction-retry", new DOMException("User interrupted compaction", "AbortError"));
  release();
  await gate;
  const [left, right] = await Promise.all([pending, retried]);
  await cancellation.settlement;
  expect(cancellation.cancelled).toBe(1);
  expect(left).toBeInstanceOf(Error);
  expect(right).toBeInstanceOf(Error);
  expect(f.submissions).toHaveLength(1);
});

test("completed compaction rejects canonical history with unowned execution records", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unowned execution record." }] },
    { type: "function_call", name: "exec_command", call_id: "foreign-call", arguments: '{"cmd":"not-owned"}' },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} leaving continuity releases the settled page, replays its answer, and permits a distinct new instruction`, async () => {
  const f = fixture(manual);
  const first = f.request();
  const accepted = await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const sourceEpoch = continuityBindingsFor(f.statePath).recoveryStore.get(binding.thread)!.epoch;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  await Promise.all([
    leaveContinuityMode(f.statePath, f.threadId),
    leaveContinuityMode(f.statePath, f.threadId),
  ]);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
  expect(source.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  expect(await f.run(structuredClone(first))).toEqual(accepted);
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
  const next = f.next(first);
  const restarted = await f.run(next);
  expect(restarted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(next))).toEqual(restarted);
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(f.registrations.get(continuityDigest(f.threadId))).toMatchObject({ state: "entered", epoch: sourceEpoch + 1 });
});

test("leaving after compaction releases the committed lease rather than the retired source lease", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  const accepted = await f.run(compact);
  const committed = [...binding.checkpoints.values()][0]!;
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  expect([...binding.checkpoints.values()]).toEqual([committed]);
  expect(await f.run(structuredClone(compact))).toEqual(accepted);
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(2);
});

test("mode exit refuses an active manual owner without cancelling its authorized work", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const first = f.request();
  const adapter = f.adapter();
  await adapter.preflight!(first, { headers: new Headers() });
  const running = adapter.runTurn!(first, { headers: new Headers() }, () => {});
  void running.catch(() => {});
  while (!f.controls.started) await Bun.sleep(1);
  try {
    expect(() => leaveContinuityMode(f.statePath, f.threadId))
      .toThrow("Finish or explicitly cancel the current continuity work");
    expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
    expect(f.pages.size).toBe(1);
  } finally {
    f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
    await running;
  }
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
});

test("Zero Risk completed explicit compaction prepares a manual checkpoint and preserves its ordinary answer", async () => {
  const f = fixture(true);
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
});

test("a rejected structured handoff retries its stable target without committing or replaying ordinary work", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  f.controls.handoffSummary = 'Invalid checkpoint.\nCODEX_LATEST_USER_PROMPT_JSON\n"A different instruction"';
  const compact = structuredClone(first); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  const thread = continuityDigest(f.threadId);
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const initialWork = Object.values(before.works).find(work => work.purpose === "compaction")!;
  expect(initialWork).toBeDefined();
  const targetId = initialWork.compactionTargetId!;
  const ordinaryWork = Object.values(before.works).find(work => work.purpose === "ordinary")!;
  expect(initialWork.attempts.at(-1)).toMatchObject({ stage: "interrupted-settled", writerRetired: true });
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const retriedWork = after.works[initialWork.logicalWorkId]!;
  expect(Object.keys(after.compactionTargets)).toEqual([targetId]);
  expect(retriedWork.compactionTargetId).toBe(targetId);
  expect(retriedWork.workPayloadDigest).toBe(initialWork.workPayloadDigest);
  expect(retriedWork.attempts).toHaveLength(initialWork.attempts.length + 1);
  expect(retriedWork.attempts.at(-1)).toMatchObject({
    attempt: initialWork.attempts.at(-1)!.attempt + 1, epoch: before.epoch + 1,
    stage: "interrupted-settled", writerRetired: true,
  });
  expect(retriedWork.retryBudget!.attempts).toBe(initialWork.retryBudget!.attempts + 1);
  expect(retriedWork.retryBudget!.startedAt).toBe(initialWork.retryBudget!.startedAt);
  expect(retriedWork.retryBudget!.lastFailureAt).toBeGreaterThanOrEqual(initialWork.retryBudget!.lastFailureAt!);
  expect(after.works[ordinaryWork.logicalWorkId]).toEqual(ordinaryWork);
  expect(after.historyRevision).toBe(0);
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
  expect(after.calls).toEqual(before.calls);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.automatic.mock.calls.at(-1)![0]).toMatchObject({
    compaction: true, nativeConnector: true, capabilities: { localToolsEnabled: false },
  });
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.key).not.toBe(f.submissions[1]!.key);
  expect(f.submissions[2]!.reused).toBe(false);
  expect(f.registrations.get(thread)).toMatchObject({
    state: "lost", epoch: after.epoch, transactionId: after.transaction!.transactionId,
  });
  expect(after.state).toBe("lost");
  const changedSource = f.request("A changed source instruction.");
  changedSource._compactionRequest = true;
  await expect(f.run(changedSource)).rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  const changedControl = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "user", content: `${COMPACT_PROMPT}\nChanged compaction control.` },
  ]);
  changedControl._compactionRequest = true;
  changedControl._compactionOutput = "message";
  await expect(f.run(changedControl)).rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(new ContinuityRecoveryStore(f.statePath).get(thread)).toEqual(after);
  expect(f.submissions).toHaveLength(3);
});

test("an accepted handoff survives failed physical settlement and commits that exact summary without resubmission", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  f.controls.failHandoffSettlement = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost", retryable: false });
  expect(binding.acceptedHandoff?.summary).toBe(`${f.controls.handoffSummary}\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."`);
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(source.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  const recovered = await f.run(structuredClone(compact));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.find(event => event.type === "text_delta")).toMatchObject({ type: "text_delta", text: binding.acceptedHandoff!.summary });
  expect(await f.run(structuredClone(compact))).toEqual(recovered);
  const current = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(current.revision).toBe(1);
  expect(current.checkpoints.size).toBe(1);
  expect([...current.checkpoints.values()][0]!.summary).toBe(binding.acceptedHandoff!.summary);
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(0);
});

test("a committed result is retained when the physical page disappears before a compact reconnect", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  const accepted = await f.run(compact);
  const committed = [...binding.checkpoints.values()][0]!;
  f.pages.clear();
  expect(await f.run(structuredClone(compact))).toEqual(accepted);
  expect([...binding.checkpoints.values()]).toEqual([committed]);
  expect(committed.summary).toBe(`${f.controls.handoffSummary}\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."`);
  expect(binding.revision).toBe(1);
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(0);
});

for (const format of ["encrypted", "readable", "summary-only"] as const) test(`${format} checkpoint replays a completed ordinary answer without resubmission and then resumes new work`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summaryEvent = compactEvents.find(event => event.type === "text_delta");
  if (summaryEvent?.type !== "text_delta") throw new Error("Missing checkpoint answer");
  const marker = format === "readable"
    ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summaryEvent.text}` }
    : { type: "compaction", encrypted_content: encodeCompactionSummary(summaryEvent.text) };
  const resumed = f.request("", "turn-first", [
    ...(format === "summary-only" ? [] : (first._rawBody as { input: unknown[] }).input), marker,
  ]);
  const resumedEvents = await f.run(resumed);
  expect(resumed._continuityHistoryRevision).toBe(1);
  expect(resumedEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(resumedEvents.filter(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual([{ type: "text_delta", text: "Completed response 1.", phase: "final_answer" }]);
  expect(f.submissions).toHaveLength(2);
  const compactReplay = await f.run(compact);
  expect(compactReplay.find(event => event.type === "text_delta")).toEqual(summaryEvent);
  expect(f.submissions).toHaveLength(2);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const next = f.next(resumed, "turn-after-checkpoint");
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.reused).toBe(true);
  expect(f.submissions[2]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[2]!.prompt).not.toContain("Verified checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("First continuity instruction.");
  expect(f.submissions[2]!.prompt).toContain("Next continuity instruction.");
});

for (const format of ["encrypted", "readable", "summary-only"] as const) test(`${format} checkpoint can move across completed foreign history when a clear new instruction follows`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summaryEvent = compactEvents.find(event => event.type === "text_delta");
  if (summaryEvent?.type !== "text_delta") throw new Error("Missing checkpoint answer");
  const marker = format === "readable"
    ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summaryEvent.text}` }
    : { type: "compaction", encrypted_content: encodeCompactionSummary(summaryEvent.text) };
  const moved = f.request("", "turn-after-checkpoint", [
    ...(format === "summary-only" ? [] : (first._rawBody as { input: unknown[] }).input),
    marker,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Foreign tool result." },
    structuredClone(marker),
    { type: "message", role: "user", id: "msg-turn-after-checkpoint", content: "New work after checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-checkpoint" } },
  ]);
  expect((await f.run(moved)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(moved._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.prompt).toContain("New work after checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("Foreign execution record.");
  expect(JSON.stringify(taskEnvelope(f.submissions[2]!.prompt))).not.toContain("Foreign tool result.");
});

for (const manual of [false, true]) for (const reclamation of ["capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation}-reclaimed old ordinary replay stays bound to its stale repeated-summary revision`, async () => {
  const f = fixture(manual);
  const repeatedInstruction = "Repeat the same continuity instruction.";
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const compactSource = async (source: CodexParsedRequest, turnId: string) => {
    if (!manual) {
      const compact = structuredClone(source); compact._compactionRequest = true;
      return f.run(compact);
    }
    const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(source)}`;
    const session = chatGptTurnSessions.find(sourceKey)!;
    const call = session.outstanding()[0]!;
    const compact = f.request("", turnId, [
      ...(source._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
    ]);
    compact._compactionRequest = true;
    return f.run(compact);
  };
  const first = f.request(repeatedInstruction);
  await f.run(first);
  const firstCompactEvents = await compactSource(first, "turn-first");
  const firstSummary = firstCompactEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (firstSummary?.type !== "text_delta") throw new Error("Missing first repeated checkpoint");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(firstSummary.text) };
  const userItem = (turnId: string) => ({
    type: "message", role: "user", id: `msg-${turnId}`, content: repeatedInstruction,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  const a = f.request("", "turn-repeat-a", [structuredClone(marker), userItem("turn-repeat-a")]);
  const aEvents = await f.run(a);
  const aAnswer = aEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (aAnswer?.type !== "text_delta") throw new Error("Missing repeated ordinary answer A");
  const namespace = chatGptWebExecutionNamespace(f.provider);
  const aKey = `${namespace}:${chatGptTurnExecutionKey(a)}`;

  const b = f.request("", "turn-repeat-b", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: aAnswer.text }] },
    userItem("turn-repeat-b"),
  ]);
  if (manual) f.controls.invokeSourceTools = true;
  await f.run(b);
  const secondCompactEvents = await compactSource(b, "turn-repeat-b");
  f.controls.invokeSourceTools = false;
  const secondSummary = secondCompactEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (secondSummary?.type !== "text_delta") throw new Error("Missing second repeated checkpoint");
  expect(secondSummary.text).toBe(firstSummary.text);

  if (reclamation === "capacity") {
    const capacity = chatGptTurnSessions as unknown as { maxEntries: number };
    const originalMaxEntries = capacity.maxEntries;
    capacity.maxEntries = 2;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "capacity-reclamation-probe");
    } finally {
      capacity.maxEntries = originalMaxEntries;
    }
  } else {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  expect(chatGptTurnSessions.find(aKey)).toBeUndefined();
  const submissions = f.submissions.length;

  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.ordinaryReplayTombstones.get(aKey)).toMatchObject({ revision: 1 });

  await expect(f.run(a)).rejects.toMatchObject({ status: 409, code: "continuity_source_unproven", retryable: false });
  expect(f.submissions).toHaveLength(submissions);

  const current = f.request("", "turn-current-revision", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(secondSummary.text) },
    { type: "message", role: "user", id: "msg-current-revision", content: "Fresh work on revision 2.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-current-revision" } },
  ]);
  expect((await f.run(current)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
});

test("a new instruction immediately after a checkpoint sends only its increment and supports a second same-page checkpoint", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const firstEvents = await f.run(compact);
  const summary = firstEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing first checkpoint");
  const next = f.request("", "turn-new", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-new", content: "New task after checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-new" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions[2]!.prompt).toContain("New task after checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("Verified checkpoint.");
  f.controls.handoffSummary = "Second verified checkpoint.";
  const secondCompact = structuredClone(next); secondCompact._compactionRequest = true;
  expect((await f.run(secondCompact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(4);
  expect(new Set(f.submissions.map(item => item.key)).size).toBe(1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active compaction preserves delivered tool results and resumes with fresh authority on the same page`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  expect(call.wireName).toBe("exec_command");
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(source.outstanding()).toHaveLength(0);
  expect(JSON.stringify(f.controls.toolResults[0])).toContain("Actual completed tool result: 42.");
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 2);
  if (!manual) expect(f.controls.toolResults[1]?.isError).toBe(true);
  expect(source.supersededError).toMatchObject({ code: "continuity_source_unproven" });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing active handoff");
  const token = f.controls.sourceToken;
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  expect((await f.run(resumed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(resumed._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(manual ? 2 : 3);
  const prompt = f.submissions.at(-1)!.prompt;
  expect(prompt).not.toContain("Verified checkpoint.");
  expect(prompt).not.toContain("Actual completed tool result: 42.");
  expect(prompt).not.toContain(token);
  expect(prompt).toContain("continue only unfinished authorized work");
  expect(new Set(f.submissions.map(submission => submission.key)).size).toBe(1);
  expect(f.pages.size).toBe(1);
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) }))
    .rejects.toThrow();
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active compaction rejects foreign execution records before checkpoint commit`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const owned = [
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ];
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...owned,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call", name: "exec_command", call_id: "foreign-call", arguments: '{"cmd":"not-owned"}' },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  const valid = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...owned,
  ]);
  valid._compactionRequest = true;
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} compaction rejects source history superseded after preflight`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const toolCall = {
    type: "function_call", name: call.wireName, call_id: call.callId,
    arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}',
  };
  const staleCompact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    toolCall,
    { type: "function_call_output", call_id: call.callId, output: "Preflight tool result A." },
  ]);
  staleCompact._compactionRequest = true;
  const compactAdapter = f.adapter();
  const sourceCoverage = source.runtime.compactionSourceCoverage!;
  const canonicalBeforePreflight = structuredClone(source.canonicalInput());
  const coverageBeforePreflight = sourceCoverage.metadata();
  const recoveryStore = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const durableBeforePreflight = recoveryStore.get(thread)!;
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });
  expect(source.canonicalInput()).toEqual(canonicalBeforePreflight);
  expect(sourceCoverage.metadata()).toEqual(coverageBeforePreflight);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(durableBeforePreflight.contextCoverage);
  expect(recoveryStore.get(thread)!.calls[call.callId]!.firstResultDigest).toBeUndefined();

  const newerCanonical = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    structuredClone(toolCall),
    { type: "function_call_output", call_id: call.callId, output: "Canonical tool result B." },
  ]);
  expect((await f.run(newerCanonical)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(source.canonicalInput()).toEqual((newerCanonical._rawBody as { input: unknown[] }).input);
  expect(recoveryStore.get(thread)!.calls[call.callId]!.firstResultDigest)
    .toBe(recoveryResultDigest({ type: "function_call_output", call_id: call.callId, output: "Canonical tool result B." }));

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const submissions = f.submissions.length;
  const acceptedCoverage = sourceCoverage.metadata();
  const acceptedDurableCoverage = recoveryStore.get(thread)!.contextCoverage;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(sourceCoverage.metadata()).toEqual(acceptedCoverage);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(acceptedDurableCoverage);
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  expect(f.submissions).toHaveLength(submissions);
});

test("Automatic stale compaction CAS failure preserves an active running source", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const firstCall = source.outstanding()[0]!;
  const toolCall = {
    type: "function_call", name: firstCall.wireName, call_id: firstCall.callId,
    arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}',
  };
  const staleCompact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    toolCall,
    { type: "function_call_output", call_id: firstCall.callId, output: "Preflight tool result A." },
  ]);
  staleCompact._compactionRequest = true;
  const compactAdapter = f.adapter();
  const sourceCoverage = source.runtime.compactionSourceCoverage!;
  const canonicalBeforePreflight = structuredClone(source.canonicalInput());
  const coverageBeforePreflight = sourceCoverage.metadata();
  const recoveryStore = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const durableBeforePreflight = recoveryStore.get(thread)!;
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });
  expect(source.canonicalInput()).toEqual(canonicalBeforePreflight);
  expect(sourceCoverage.metadata()).toEqual(coverageBeforePreflight);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(durableBeforePreflight.contextCoverage);
  expect(recoveryStore.get(thread)!.calls[firstCall.callId]!.firstResultDigest).toBeUndefined();

  const newerCanonical = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    structuredClone(toolCall),
    { type: "function_call_output", call_id: firstCall.callId, output: "Canonical tool result B." },
  ]);
  const previousBatchRevision = source.runtime.mode === "tools"
    ? source.runtime.externalProgress.snapshot().lastToolBatchRevision
    : 0;
  const newerRun = f.run(newerCanonical);
  const deadline = Date.now() + 1_000;
  let nextBatchRevision = previousBatchRevision;
  while (nextBatchRevision === previousBatchRevision && Date.now() < deadline) {
    await Bun.sleep(1);
    if (source.runtime.mode === "tools") {
      nextBatchRevision = source.runtime.externalProgress.snapshot().lastToolBatchRevision;
    }
  }
  if (source.runtime.mode === "tools") {
    await source.runtime.externalProgress.acknowledgeToolBatch(nextBatchRevision);
  }
  expect((await newerRun).at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(recoveryStore.get(thread)!.calls[firstCall.callId]!.firstResultDigest)
    .toBe(recoveryResultDigest({ type: "function_call_output", call_id: firstCall.callId, output: "Canonical tool result B." }));
  expect(source.outstanding()).toHaveLength(1);
  expect(source.outstanding()[0]?.callId).not.toBe(firstCall.callId);
  const acceptedCanonical = structuredClone(source.canonicalInput());
  expect(acceptedCanonical).toEqual([
    ...(newerCanonical._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!),
  ]);

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  expect(binding.state).toBe("running");
  const submissions = f.submissions.length;
  const acceptedCoverage = sourceCoverage.metadata();
  const acceptedDurableCoverage = recoveryStore.get(thread)!.contextCoverage;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(sourceCoverage.metadata()).toEqual(acceptedCoverage);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(acceptedDurableCoverage);
  expect(binding.state).toBe("running");
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  expect(source.outstanding()).toHaveLength(1);
  expect(source.canonicalInput()).toEqual(acceptedCanonical);
  expect(f.submissions).toHaveLength(submissions);
  source.cancel(continuityError("continuity_session_lost"));
});

test("an active Zero Risk ordinary final that wins before control delivery is preserved without a second prompt", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const first = f.request();
  const ordinary = f.run(first);
  while (!f.controls.started) await Bun.sleep(1);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const handoff = f.run(compact).catch(error => error);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  // Compaction validation is serialized behind the active ordinary owner. It must not claim
  // the compaction state until the source lock can prove which local work actually won.
  expect(binding.state).toBe("running");
  f.broker.completeSafeTurn(f.controls.safeToken, "Ordinary final wins.");
  expect((await ordinary).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await handoff).toMatchObject({ code: "continuity_manual_handoff_required" });
  expect(binding.revision).toBe(0);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(first)).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Ordinary final wins.", phase: "final_answer" });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} new native turn rejects an old instruction without a committed transition`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const stale = f.request("", "turn-without-new-instruction", structuredClone((first._rawBody as { input: unknown[] }).input));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} new native turn rejects an already-consumed item-ID-only instruction`, async () => {
  const f = fixture(manual);
  const input = structuredClone((f.request()._rawBody as { input: unknown[] }).input);
  delete (input[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const first = f.request("", "turn-first", input);
  await f.run(first);
  const stale = f.request("", "turn-without-new-instruction", structuredClone(input));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} old item-ID-only instruction cannot revive after a newer ordinary execution`, async () => {
  const f = fixture(manual);
  const inputA = structuredClone((f.request("Instruction A.", "turn-a")._rawBody as { input: unknown[] }).input);
  delete (inputA[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const a = f.request("", "turn-a", inputA);
  await f.run(a);

  const b = f.next(a, "turn-b");
  const inputB = (b._rawBody as { input: unknown[] }).input;
  delete (inputB.at(-1) as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  await f.run(b);
  expect(f.submissions).toHaveLength(2);

  const namespace = chatGptWebExecutionNamespace(f.provider);
  const aKey = `${namespace}:${chatGptTurnExecutionKey(a)}`;
  if (reclamation === "capacity") {
    const capacity = chatGptTurnSessions as unknown as { maxEntries: number };
    const originalMaxEntries = capacity.maxEntries;
    capacity.maxEntries = 2;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "capacity-consumed-instruction-probe");
    } finally {
      capacity.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(aKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(aKey)).toBeUndefined();

  const stale = f.request("", "turn-c", structuredClone(inputA));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const masked = f.next(b, "turn-c");
  const maskedInput = (masked._rawBody as { input: Array<Record<string, unknown>> }).input;
  maskedInput.at(-1)!.id = "msg-turn-a";
  maskedInput.at(-1)!.content = "Changed work under a consumed instruction ID.";
  maskedInput.push({ type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" } });
  await expect(f.run(masked)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
  const valid = f.next(b, "turn-d");
  ((valid._rawBody as { input: unknown[] }).input).push(maskedInput.at(-1));
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed foreign work.");
});

for (const manual of [false, true]) for (const reclamation of ["retained", "tombstone"] as const) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint resume rejects a ${reclamation} consumed item-ID-only instruction`, async () => {
  const f = fixture(manual);
  const inputA = structuredClone((f.request("Instruction A.", "turn-a")._rawBody as { input: unknown[] }).input);
  delete (inputA[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const a = f.request("", "turn-a", inputA);
  await f.run(a);

  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const b = f.next(a, "turn-b");
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-b", [
    ...(b._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "The completed original result." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
  f.controls.invokeSourceTools = false;

  const aKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(a)}`;
  if (reclamation === "tombstone") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "checkpoint-consumed-instruction-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
    expect(chatGptTurnSessions.find(aKey)).toBeUndefined();
    const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
    expect(binding.ordinaryReplayTombstones.get(aKey)).toMatchObject({
      instructionIdentity: "msg-turn-a", nativeTurnId: "turn-a",
    });
  } else expect(chatGptTurnSessions.find(aKey)).toBeDefined();

  const submissions = f.submissions.length;
  const stale = f.request("", "turn-c", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...structuredClone(inputA),
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  ((stale._rawBody as { input: unknown[] }).input).push({
    type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" },
  });
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  const valid = f.request("", "turn-d", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-turn-d", content: "Valid new checkpoint work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-d" } },
    { type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" } },
  ]);
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed foreign work.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary replay rejects changed top-level instructions`, async () => {
  const f = fixture(manual);
  const request = (instructions: string) => {
    const raw = structuredClone(f.request()._rawBody) as Record<string, unknown>;
    raw.instructions = instructions;
    const parsed = parseRequest(raw);
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = request("Instruction A.");
  await f.run(first);
  await expect(f.run(request("Instruction B."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(request("Instruction A."))).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Completed response 1.", phase: "final_answer" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} unowned terminal results are rejected before a new ordinary submission`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.next(first);
  const input = structuredClone((next._rawBody as { input: unknown[] }).input);
  input.push({ type: "function_call_output", call_id: "unissued-current-call", output: "unowned result" });
  const invalid = f.request("", "turn-next", input);
  await expect(f.run(invalid)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

test("completed delegated compaction retry rejects changed source content under the same source identity", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const changed = f.request("A different source instruction."); changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active delegated source content conflict preserves the accepted source owner`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  expect(source.outstanding()).toHaveLength(1);
  const token = f.controls.sourceToken;
  const changed = f.request("Changed delegated source content.", "turn-first");
  changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("running");
  expect(source.isActive()).toBe(true);
  expect(source.supersededError).toBeUndefined();
  expect(source.outstanding()).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(0);
  const claim = await callTurnBroker<{ bindingId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "claim", token, ...(manual ? { contract: "safe" } : {}),
  });
  expect(claim.bindingId).toBeDefined();
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} committed compaction replay rejects changed accepted tool-result payload`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId,
      arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Accepted compact result A." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
  ]);
  await f.run(resumed);
  await f.run(f.next(resumed, "turn-after-compaction-result"));
  if (reclamation === "capacity") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "compaction-result-replay-capacity-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(sourceKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const changed = structuredClone(compact);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.type === "function_call_output")!.output = "Conflicting compact result B.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_result_conflict", retryable: false });
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same native turn old instruction cannot revive after steering and checkpoint`, async () => {
  const f = fixture(manual);
  const a = f.request("Instruction A.", "turn-first");
  await f.run(a);
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const b = f.request("", "turn-first", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-b", content: "Instruction B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: !manual });
  const compact = manual ? (() => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
    const call = source.outstanding()[0]!;
    return f.request("", "turn-first", [
      ...(b._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Completed B result." },
    ]);
  })() : structuredClone(b);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const submissions = f.submissions.length;
  const stale = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(a._rawBody as { input: unknown[] }).input,
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
});

test("completed local compaction retry rejects a changed control payload", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const raw = structuredClone(first._rawBody) as Record<string, unknown> & { input: unknown[] };
  const compactRaw = {
    ...raw,
    input: [...raw.input, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  };
  const compact = parseRequest(compactRaw);
  compact._conversationPolicy = "task";
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const changedRaw = structuredClone(compactRaw);
  (changedRaw.input.at(-1) as { content: string }).content += "\nChanged control payload.";
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "task";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} repeated-summary checkpoint-only transition follows the second active source`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const compactActive = async (ordinary: CodexParsedRequest, turnId: string) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", turnId, [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "The completed original result." },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
    return summary.text;
  };
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const firstSummary = await compactActive(first, "turn-first");
  const secondInstruction = { type: "message", role: "user", id: "msg-second-source", content: "First continuity instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-second" } };
  const second = f.request("", "turn-second", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(firstSummary) },
    secondInstruction,
  ]);
  expect((await f.run(second)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const secondSummary = await compactActive(second, "turn-second");
  expect(secondSummary).toBe(firstSummary);
  f.controls.invokeSourceTools = false;
  const continued = f.request("", "turn-second", [
    secondInstruction,
    { type: "compaction", encrypted_content: encodeCompactionSummary(secondSummary) },
  ]);
  expect((await f.run(continued)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.revision).toBe(2);
  expect(continued._continuityHistoryRevision).toBe(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same-turn identical source text and summary select the explicitly retained source`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const compactActive = async (ordinary: CodexParsedRequest) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", "turn-first", [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output: "Accepted exact source result." },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing committed checkpoint");
    return { compact, summary: summary.text };
  };
  const a = f.request();
  await f.run(a);
  const first = await compactActive(a);
  const bItem = { type: "message", role: "user", id: "same-turn-source-b", content: "First continuity instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const b = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
    ...(a._rawBody as { input: unknown[] }).input, bItem,
  ]);
  await f.run(b);
  const second = await compactActive(b);
  expect(second.summary).toBe(first.summary);
  f.controls.invokeSourceTools = false;
  const continued = f.request("", "turn-first", [bItem,
    { type: "compaction", encrypted_content: encodeCompactionSummary(second.summary) },
  ]);
  bindContinuityRequestScope(continued, chatGptWebExecutionNamespace(f.provider));
  expect(recoverCompactionInstruction(continued, extractChatGptTurnIdentity(continued))?.source.itemId).toBe(bItem.id);
  const before = f.submissions.length;
  const [accepted, concurrentRetry] = await Promise.all([f.run(continued), f.run(structuredClone(continued))]);
  expect(concurrentRetry).toEqual(accepted);
  expect(continued._continuityHistoryRevision).toBe(2);
  expect(await f.run(structuredClone(continued))).toEqual(accepted);
  expect(f.submissions).toHaveLength(before + 1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.checkpoints.size).toBe(2);
  expect([...binding.checkpoints.values()].find(checkpoint => checkpoint.revision === 2)?.continuationExecutionKey)
    .toBe(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(continued)}`);
  expect(await f.run(structuredClone(first.compact))).toEqual(await f.run(first.compact));
  const stale = f.request("", "turn-first", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const ambiguous = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
  ]);
  await expect(f.run(ambiguous)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(before + 1);
  const next = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(second.summary) }, bItem,
    { type: "message", role: "user", id: "same-turn-current-c", content: "Distinct work after both checkpoints.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next._continuityHistoryRevision).toBe(2);
  expect(f.submissions).toHaveLength(before + 2);
});

test("real Codex captured active and completed checkpoint-only requests reuse product commits with a fake page", async () => {
  // This replays real client request structure. Launcher, ChatGPT, and Native execution use the fixture.
  const captured = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol-active.json"), "utf8")) as {
    captured: Array<{ label: string; replay?: boolean; body: { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
      response: { output: Array<{ type: string; encrypted_content?: string }> } }>;
  };
  const f = fixture();
  const checkpointContents = new Map<string, string>();
  const load = (record: typeof captured.captured[number]) => {
    const body = structuredClone(record.body);
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, thread_id: f.threadId });
    for (const item of body.input) if (typeof item.encrypted_content === "string" && checkpointContents.has(item.encrypted_content)) {
      item.encrypted_content = checkpointContents.get(item.encrypted_content)!;
    }
    const parsed = parseRequest({ ...body, model: "gpt-5.6-sol", stream: false });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const ordinary = captured.captured.find(record => record.label === "ordinary" && !record.replay)!;
  const activeCompact = captured.captured.find(record => record.label === "active-compact")!;
  const activeContinuation = captured.captured.find(record => record.label === "ordinary"
    && record.body.input.some(item => item.type === "compaction"))!;
  f.controls.invokeSourceTools = true;
  f.controls.sourceArguments = JSON.parse(activeCompact.body.input.find(item => item.type === "function_call")!.arguments as string);
  const first = load(ordinary);
  const initial = await f.run(first);
  expect(initial.at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(await f.run(load(ordinary))).toEqual(initial);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = load(activeCompact);
  const raw = compact._rawBody as { input: Array<Record<string, unknown>> };
  const callId = source.outstanding()[0]!.callId;
  for (const item of raw.input) if (item.call_id) item.call_id = callId;
  // Reparse after mapping the fake capture's call ID to the local product Broker call.
  const localCompact = parseRequest({ ...compact._rawBody as object, model: compact.modelId });
  localCompact._conversationPolicy = "task";
  f.controls.handoffSummary = decodeCompactionSummary(activeCompact.response.output[0]!.encrypted_content!)!;
  const activeSummary = await f.run(localCompact);
  expect(activeSummary.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const activeSummaryText = activeSummary.find(event => event.type === "text_delta");
  if (activeSummaryText?.type !== "text_delta") throw new Error("Missing product checkpoint");
  // The product adds its existing latest-user codec appendix; use that committed encoding.
  checkpointContents.set(activeCompact.response.output[0]!.encrypted_content!, encodeCompactionSummary(activeSummaryText.text));
  f.controls.invokeSourceTools = false;
  const continued = load(activeContinuation);
  const activeResult = await f.run(continued);
  expect(activeResult.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(load(activeContinuation))).toEqual(activeResult);
  expect(f.submissions.at(-1)!.prompt).toContain("SYSTEM_MARKER");
  expect(f.submissions.at(-1)!.prompt).toContain("DEVELOPER_MARKER");
  expect(f.submissions.at(-1)!.prompt).toContain("# AGENTS.md instructions");
  expect(f.submissions.at(-1)!.prompt).not.toContain("ORDINARY_MARKER");
  const next = load(captured.captured.find(record => record.label === "new-turn")!);
  const nextResult = await f.run(next);
  const completedCompact = captured.captured.find(record => record.label === "compact")!;
  f.controls.handoffSummary = decodeCompactionSummary(completedCompact.response.output[0]!.encrypted_content!)!;
  const completedSummary = await f.run(load(completedCompact));
  expect(completedSummary.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const completedSummaryText = completedSummary.find(event => event.type === "text_delta");
  if (completedSummaryText?.type !== "text_delta") throw new Error("Missing completed product checkpoint");
  checkpointContents.set(completedCompact.response.output[0]!.encrypted_content!, encodeCompactionSummary(completedSummaryText.text));
  const before = f.submissions.length;
  const checkpointOnly = captured.captured.find(record => record.label === "checkpoint-only")!;
  const finalReplay = await f.run(load(checkpointOnly));
  expect(finalReplay.filter(event => event.type === "text_delta")).toEqual(nextResult.filter(event => event.type === "text_delta"));
  expect(await f.run(load(checkpointOnly))).toEqual(finalReplay);
  expect(f.submissions).toHaveLength(before);
  expect(f.controls.toolResults).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.revision).toBe(2);
  expect(binding.checkpoints.size).toBe(2);
});

test("Automatic repeated-summary continuation replays the old result round for the same native instruction", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const compactCurrent = async (ordinary: CodexParsedRequest, output: string) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", "turn-first", [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    return summary.text;
  };
  const summary = await compactCurrent(first, "Original source result.");
  const continuation = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }]);
  await f.run(continuation);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(continuation)}`)!;
  const call = source.outstanding()[0]!;
  const result = f.request("", "turn-first", [
    ...(continuation._rawBody as { input: unknown[] }).input,
    recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Accepted continuation result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const priorBatch = snapshot.lastToolBatchRevision;
  const next = f.run(result);
  while (snapshot.lastToolBatchRevision === priorBatch) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  const accepted = await next;
  expect(await compactCurrent(result, "Next continuation result.")).toBe(summary);
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const retry = structuredClone(result);
  expect(await f.run(retry)).toEqual(accepted);
  expect(retry._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint resume excludes old item-ID-only instructions and binds only new work`, async () => {
  const f = fixture(manual);
  const old = { type: "message", role: "user", id: "historical-a", content: "Historical instruction A." };
  const current = { type: "message", role: "user", id: "current-b", content: "Source instruction B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = f.request("", "turn-first", [old, current]);
  await f.run(first);
  let compact = structuredClone(first);
  if (manual) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call = source.outstanding()[0]!;
    compact = f.request("", "turn-first", [old, current,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const events = await f.run(compact);
  const summary = events.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-next", [old, current,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "current-c", content: "New instruction C.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await f.run(next);
  expect(f.submissions.at(-1)!.prompt).toContain("New instruction C.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Historical instruction A.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Source instruction B.");
  const replayRaw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  replayRaw.input[0]!.content = "Changed old instruction.";
  const replay = parseRequest(replayRaw);
  replay._conversationPolicy = "task";
  const submissions = f.submissions.length;
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} cached compaction binds all source instructions after steering`, async () => {
  const f = fixture(manual);
  const prior = f.request("Earlier steering instruction.");
  await f.run(prior);
  const a = { type: "message", role: "user", id: "constraint-a", content: "Accepted constraint A.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const b = { type: "message", role: "user", id: "task-b", content: "Stable task B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = f.request("", "turn-first", [...(prior._rawBody as { input: unknown[] }).input, a, b]);
  await f.run(first);
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  let compact = structuredClone(first);
  if (manual) {
    const call = source.outstanding()[0]!;
    compact = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-after-compact", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "next-task", content: "New work after compaction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-compact" } },
  ]);
  await f.run(next);
  if (reclamation === "capacity") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      // Admission can reclaim the earlier steering execution before this source.
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "source-payload-capacity-probe");
      registry.maxEntries = registry.entries.size;
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "source-payload-capacity-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(sourceKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const snapshot = source.canonicalInput();
  const changedRaw = structuredClone(compact._rawBody) as { input: Array<Record<string, unknown>> };
  changedRaw.input.find(item => item.id === "constraint-a")!.content = "Conflicting constraint A'.";
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "task";
  changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const historicalRaw = structuredClone(compact._rawBody) as { input: Array<Record<string, unknown>> };
  historicalRaw.input[0]!.content = "Changed earlier steering history.";
  const historicalReplay = parseRequest(historicalRaw);
  historicalReplay._conversationPolicy = "task";
  historicalReplay._compactionRequest = true;
  expect((await f.run(historicalReplay)).find(event => event.type === "text_delta")).toEqual(summary);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
  expect(source.canonicalInput()).toEqual(snapshot);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent compaction rejects changed results before initial acceptance`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const makeCompact = (output: string) => {
    const parsed = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    parsed._compactionRequest = true;
    return parsed;
  };
  const a = makeCompact("Result A");
  const b = makeCompact("Result B");
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lock = source.runExclusive(async () => { entered(); await gate; });
  await enteredPromise;
  try {
    const runA = f.run(a).then(events => ({ ok: true as const, events }), error => ({ ok: false as const, error }));
    let cached: Promise<string> | undefined;
    for (let i = 0; i < 200; i++) {
      if (a._continuityHistoryRevision !== undefined) {
        const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(a)}`;
        cached = existingStructuredCompactionRun<string>(key);
      }
      if (cached) break;
      await Bun.sleep(5);
    }
    expect(cached).toBeDefined();
    const resultB = await f.run(b).then(events => ({ ok: true as const, events }), error => ({ ok: false as const, error }));
    expect(resultB.ok).toBe(false);
    release();
    const resultA = await runA;
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(false);
    if (!resultB.ok) expect(resultB.error).toMatchObject({ code: "continuity_source_unproven" });
    if (resultA.ok) {
      expect(resultA.events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(f.submissions).toHaveLength(manual ? 1 : 2);
    }
  } finally {
    release();
    await lock;
  }
});

// V3 uses explicit new-turn ownership; locating completed predecessors is no longer required.
for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} owned new-turn input continues without its completed predecessor`, async () => {
  const f = httpFixture(manual);
  expect((await f.send(f.body)).status).toBe(200);
  const response = await f.send({
    ...f.body,
    input: [{ type: "message", role: "user", id: "next-only", content: "New instruction with missing predecessor.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next" }) },
  });
  expect(response.status).toBe(200);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions.at(-1)!.prompt).toContain("New instruction with missing predecessor.");
  const unowned = await f.send({
    ...f.body,
    input: [{ type: "message", role: "user", id: "unowned-next", content: "Unowned new instruction." }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-unowned" }) },
  });
  expect(unowned.status).toBe(409);
  expect(await unowned.json()).toMatchObject({ error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(2);
  expect((await f.send(f.body)).status).toBe(200);
});

for (const manual of [false, true]) for (const sameTurn of [false, true]) for (const retainPredecessor of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} moved checkpoint rejects ambiguous ${sameTurn ? "same-turn" : "ID-only"} history with predecessor ${retainPredecessor ? "before checkpoint" : "absent"}`, async () => {
  const f = fixture(manual);
  const old = { type: "message", role: "user", id: "old-a", content: "Old instruction A.",
    ...(sameTurn ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}) };
  const current = { type: "message", role: "user", id: "source-b", content: "Source instruction B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = f.request("", "turn-first", [old, current]);
  await f.run(first);
  let compact = structuredClone(first);
  if (manual) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call = source.outstanding()[0]!;
    compact = f.request("", "turn-first", [old, current,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const submissions = f.submissions.length;
  const turnId = sameTurn ? "turn-first" : "turn-next";
  const next = f.request("", turnId, [
    ...(retainPredecessor ? [current] : []),
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, old,
    { type: "message", role: "user", id: "new-c", content: "New instruction C.", internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  const proved = f.request("", turnId, [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, old, current,
    { type: "message", role: "user", id: "proved-new", content: "Proved new work.",
      internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ]);
  expect((await f.run(proved)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt).toContain("Proved new work.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Old instruction A.");
});

for (const manual of [false, true]) test(`Round 7: accepted foreign-source tail cannot mask consumed current instruction ${manual}`, async () => {
  const f = fixture(manual);
  const a = f.request("Consumed instruction A.", "turn-a");
  await f.run(a);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = false;
  const b = f.next(a, "turn-b");
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-c", [
    ...(b._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Completed B result." },
  ]);
  compact._compactionRequest = true;
  const events = await f.run(compact);
  const summary = events.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const originalB = structuredClone((b._rawBody as { input: unknown[] }).input.at(-1));
  const masked = f.request("", "turn-c", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-turn-a", content: "Changed work under consumed instruction A ID.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-c" } },
    originalB,
  ]);
  const before = f.submissions.length;
  const unmasked = f.request("", "turn-c", (masked._rawBody as { input: unknown[] }).input.slice(0,-1));
  await expect(f.run(unmasked)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(chatGptCurrentInstructionIndex(masked)).toBe(1);
  expect(chatGptCurrentInstructionRevision(masked)?.itemId).toBe("msg-turn-a");
  const result = await f.run(masked).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code }));
  expect(result).toMatchObject({ accepted: false, code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(before);
});
test("Round 7: accepted source tail cannot mask new instruction after completed-source checkpoint", async () => {
  const f=fixture();
  const source = f.request("Source A.", "turn-a");
  await f.run(source);
  const compact=f.request("", "turn-b", (source._rawBody as {input: unknown[]}).input);
  compact._compactionRequest=true;
  const events=await f.run(compact);
  const summary=events.find(event=>event.type==="text_delta");
  if(summary?.type!=="text_delta") throw new Error("Missing summary");
  const next=f.request("", "turn-b", [
    {type:"compaction", encrypted_content:encodeCompactionSummary(summary.text)},
    {type:"message",role:"user",id:"msg-turn-new",content:"A new current task.",internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}},
    ...(source._rawBody as {input: unknown[]}).input,
  ]);
  const before=f.submissions.length;
  const result=await f.run(next).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code}));
  expect(result).toMatchObject({ accepted: true });
  expect(f.submissions).toHaveLength(before + 1);
  expect(f.submissions.at(-1)?.prompt).toContain("A new current task.");
});

for (const manual of [false,true]) test(`Round 7: current native cross-task instruction remains usable on ordinary resume ${manual}`, async () => {
  const f=fixture(manual);
  const first=f.request("Original task.","turn-a");
  await f.run(first);
  const delegation={type:"function_call_output",id:"fco-delegation-current",name:"send_message_to_thread",namespace:"codex_app",
    output:"<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Perform the new delegated task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}};
  const next=f.request("","turn-b",[
    ...(first._rawBody as {input:unknown[]}).input,
    {type:"message",role:"assistant",content:"Completed response 1."},delegation,
  ]);
  const before=f.submissions.length;
  const result=await f.run(next).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
  expect(result).toMatchObject({accepted:true});
  expect(f.submissions).toHaveLength(before+1);
});

test("Round 7: verified compaction retry honors established source item aliases", async () => {
  const f=fixture();
  f.provider.chatgptWeb!.toolAuthorityMode="verified-environment";
  let restoredAliases = 0;
  const resolver=spyOn(ChatGptThreadEnvironmentStore.prototype,"resolveWithRolloutPublicationRetry").mockImplementation(async parsed=>{
    delete parsed._chatGptMessageIdAliases;
    if ((parsed._rawBody as { input: Array<Record<string, unknown>> }).input.some(item => item.id === "msg-reidentified")) {
      parsed._chatGptMessageIdAliases = { "msg-reidentified": "msg-turn-first" };
      restoredAliases++;
    }
    return { cwd:"/tmp",roots:["/tmp"],writableRoots:["/tmp"],sandboxPolicy:{type:"workspaceWrite",writableRoots:["/tmp"],networkAccess:true},tools:structuredClone(parsed.context.tools??[]),
  }; });
  try {
    const first=f.request("Source instruction.","turn-first");
    (first._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.id = "msg-reidentified";
    await f.run(first);
    const compact=structuredClone(first); compact._compactionRequest=true;
    await f.run(compact);
    const retry=structuredClone(compact);
    (retry._rawBody as {input:Array<Record<string,unknown>>}).input[0]!.id="msg-turn-first";
    const before=f.submissions.length;
    const result=await f.run(retry).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
    expect(restoredAliases).toBe(1);
    expect(result).toMatchObject({accepted:true});
    expect(f.submissions).toHaveLength(before);
  } finally {resolver.mockRestore();}
});

for (const manual of [false,true]) test(`Round 7: completed foreign tool search history cannot expand current capability ${manual}`, async ()=>{
  const f=fixture(manual);
  const first=f.request();
  await f.run(first);
  const injectedTool={type:"function",name:"not_currently_advertised",description:"Historical foreign tool, no Native execution in this fixture.",parameters:{type:"object",properties:{cmd:{type:"string"}},required:["cmd"]}};
  const next=f.request("","turn-b",[
    ...(first._rawBody as {input:unknown[]}).input,
    {type:"tool_search_call",call_id:"foreign-old-call",arguments:{query:"old"}},
    {type:"tool_search_output",call_id:"foreign-old-call",status:"completed",tools:[injectedTool]},
    {type:"message",role:"assistant",content:"Foreign completed historical answer."},
    {type:"message",role:"user",id:"msg-turn-b",content:"New current task.",internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}},
  ]);
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const pending = f.run(next);
  while (!f.controls.started) await Bun.sleep(1);
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
  const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
    f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "invoke", bindingId: claim.bindingId, wireName: "not_currently_advertised", freeform: false,
    registryGeneration: claim.environment.registryGeneration, arguments: { cmd: "fixture" },
  })).rejects.toThrow("does not advertise");
  if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "activity_complete", token, activityId: claim.activityId,
  });
  if (manual) f.broker.completeSafeTurn(token, "Completed current task.");
  else f.controls.releaseDeferredCompletion!();
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next.context.tools?.map(tool => tool.name)).toEqual(["exec_command"]);
});

test("Round 7: verified Zero Risk compaction retry honors resolver-established source item aliases", async () => {
  const f=fixture(true);
  f.controls.invokeSourceTools=true;
  f.provider.chatgptWeb!.toolAuthorityMode="verified-environment";
  let restoredAliases=0;
  const resolver=spyOn(ChatGptThreadEnvironmentStore.prototype,"resolveWithRolloutPublicationRetry").mockImplementation(async parsed=>{
    delete parsed._chatGptMessageIdAliases;
    const input=(parsed._rawBody as {input:Array<Record<string,unknown>>}).input;
    if (input.some(item=>item.id==="msg-reidentified")) {
      parsed._chatGptMessageIdAliases={"msg-reidentified":"msg-turn-first"};
      restoredAliases++;
    }
    return {cwd:"/tmp",roots:["/tmp"],writableRoots:["/tmp"],sandboxPolicy:{type:"workspaceWrite",writableRoots:["/tmp"],networkAccess:true},tools:structuredClone(parsed.context.tools??[])};
  });
  try {
    const first=f.request("Source instruction.","turn-first");
    await f.run(first);
    const source=chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call=source.outstanding()[0]!;
    const compact=f.request("","turn-compaction",[
      ...(first._rawBody as {input:unknown[]}).input,
      {type:"function_call",name:call.wireName,call_id:call.callId,arguments:'{"cmd":"fixture-command-not-executed-by-this-test"}'},
      {type:"function_call_output",call_id:call.callId,output:"Completed source result."},
    ]); compact._compactionRequest=true;
    await f.run(compact);
    const retry=structuredClone(compact);
    (retry._rawBody as {input:Array<Record<string,unknown>>}).input[0]!.id="msg-reidentified";
    const before=f.submissions.length;
    const result=await f.run(retry).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
    expect(restoredAliases).toBe(1);
    expect(result).toMatchObject({accepted:true});
    expect(f.submissions).toHaveLength(before);
  } finally {resolver.mockRestore();}
});
for (const manual of [false, true]) test(`Round 7: queued active-source compaction cancellation has no unhandled rejection ${manual}`, async () => {
  const f=fixture(manual); f.controls.invokeSourceTools=true; f.controls.singleSourceTool=true;
  const first=f.request(); await f.run(first);
  const source=chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call=source.outstanding()[0]!;
  const compact=f.request('', 'turn-compaction',[...(first._rawBody as {input:unknown[]}).input,{type:'function_call_output',call_id:call.callId,output:'Genuine source result.'}]);
  compact._compactionRequest=true;
  let release!:()=>void;
  const gate=source.runExclusive(()=>new Promise<void>(resolve=>{release=resolve;}));
  await Bun.sleep(0);
  compact._continuityHistoryRevision=0;
  const pending=f.run(compact).catch(error=>error);
  const key=`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(compact)}`;
  while(!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  const reason=new DOMException('Cancel queued active-source compaction','AbortError');
  const cancellation=cancelStructuredCompactionNativeTurn(f.threadId,'turn-compaction',reason);
  release(); await gate;
  expect(await pending).toBeInstanceOf(Error); await cancellation.settlement;
  expect(cancellation.cancelled).toBe(1);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.submissions).toHaveLength(1);
  expect(source.isActive()).toBe(true);
  expect(source.supersededError).toBeUndefined();
  await Bun.sleep(5);
});

for (const manual of [false, true]) test(`Round 7: current native cross-task instruction resumes after checkpoint ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-checkpoint", [
    ...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Completed source result." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-delegation", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "function_call_output", id: "fco-checkpoint-delegation", name: "send_message_to_thread", namespace: "codex_app",
      output: "<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Perform the checkpoint delegated task.</input></codex_delegation>",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-delegation" } },
  ]);
  const before = f.submissions.length;
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(before + 1);
  expect(f.submissions.at(-1)?.prompt).toContain("Perform the checkpoint delegated task.");
  await f.run(next);
  expect(f.submissions).toHaveLength(before + 1);
});

for (const mutation of ["namespace", "identity", "foreign-turn", "payload", "call-id"] as const) test(`Round 7: malformed native delegation cannot start ordinary work: ${mutation}`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const delegation: Record<string, unknown> = {
    type: "function_call_output", id: "fco-current", name: "send_message_to_thread", namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>Current task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
  };
  if (mutation === "namespace") delegation.namespace = "foreign";
  if (mutation === "identity") delete delegation.id;
  if (mutation === "foreign-turn") delegation.internal_chat_message_metadata_passthrough = { turn_id: "foreign" };
  if (mutation === "payload") delegation.output = "<codex_delegation>unproven</codex_delegation>";
  if (mutation === "call-id") delegation.call_id = "foreign-call";
  const next = f.request("", "turn-current", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." }, delegation,
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`Round 7: conflicting queued compaction result cannot register cancellation authority ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const make = (turnId: string, output: string) => {
    const parsed = f.request("", turnId, [
      ...(first._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    parsed._compactionRequest = true;
    return parsed;
  };
  let release!: () => void;
  const gate = source.runExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await Bun.sleep(0);
  const original = make("compact-original", "Accepted result A.");
  const conflict = make("compact-conflict", "Conflicting result B.");
  const pending = f.run(original);
  original._continuityHistoryRevision = 0;
  const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`;
  while (!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  await expect(f.run(conflict)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const cancelled = cancelStructuredCompactionNativeTurn(f.threadId, "compact-conflict", new Error("Cancel unaccepted request"));
  expect(cancelled.cancelled).toBe(0);
  await cancelled.settlement;
  release();
  await gate;
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 2);
  expect(JSON.stringify(f.controls.toolResults[0])).toContain("Accepted result A.");
});

for (const manual of [false, true]) test(`Round 7: approved tool discovery remains usable on ordinary work ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const discovered = { type: "function", name: "discovered_command", description: "Locally discovered fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Current fixture discovery", parameters: { type: "object" } }];
  raw.input.push({ type: "additional_tools", tools: [{ ...discovered, name: "inline_command" }] });
  const first = parseRequest(raw);
  first._conversationPolicy = "task";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const searchResult = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [discovered] };
  const resultRaw = { ...raw, input: [...raw.input, { type: "tool_search_call", call_id: call.callId, arguments: {} }, searchResult] };
  const result = parseRequest(resultRaw);
  result._conversationPolicy = "task";
  expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(result.context.tools?.map(tool => tool.name)).toContain("discovered_command");
  expect(result.context.tools?.map(tool => tool.name)).toContain("inline_command");
  // The locally accepted definition remains authoritative even if its historical copy changes.
  const historical = structuredClone(searchResult);
  historical.tools[0]!.parameters = { type: "object", properties: { forbidden: { type: "string" } }, required: ["forbidden"] } as unknown as typeof discovered.parameters;
  const nextRaw = { ...raw, input: [...raw.input, historical,
    { type: "message", role: "assistant", content: "Completed source." },
    { type: "message", role: "user", id: "msg-discovery-next", content: "Use the approved discovered tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-discovery-next" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-discovery-next" }) } };
  const next = parseRequest(nextRaw);
  next._conversationPolicy = "task";
  f.controls.reviewWireName = "discovered_command";
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const nextSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  expect(nextSource.outstanding()[0]?.wireName).toBe("discovered_command");
  expect(next.context.tools?.find(tool => tool.name === "discovered_command")?.parameters).toEqual(discovered.parameters);
  const nextCall = nextSource.outstanding()[0]!;
  const terminal = parseRequest({ ...nextRaw, input: [...nextRaw.input,
    { type: "function_call_output", call_id: nextCall.callId, output: "Approved discovered result." }] });
  terminal._conversationPolicy = "task";
  await f.run(terminal);
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const manual of [false, true]) test(`Round 7: approved discovery survives checkpoint and current registry removal ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const spec = { type: "function", name: "discovered_checkpoint_tool", description: "Approved fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const first = parseRequest(raw);
  first._conversationPolicy = "task";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const search = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [spec] };
  const compact = parseRequest({ ...raw, input: [...raw.input, recordedCall(call), search],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-search-compact" }) } });
  compact._conversationPolicy = "task";
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  const nextRaw = { ...raw, input: [search, { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-after-search-checkpoint", content: "Use the approved checkpoint tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-search-checkpoint" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-search-checkpoint" }) } };
  const next = parseRequest(nextRaw);
  next._conversationPolicy = "task";
  f.controls.reviewWireName = "discovered_checkpoint_tool";
  f.controls.singleSourceTool = true;
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const current = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const nextCall = current.outstanding()[0]!;
  expect(nextCall.wireName).toBe("discovered_checkpoint_tool");
  // A currently removed tool still delivers its already admitted result exactly once.
  const removedRaw = { ...nextRaw, tools: [], input: [...nextRaw.input.slice(1),
    { type: "function_call_output", call_id: nextCall.callId, output: "Result from the previously admitted call." }] };
  const removed = parseRequest(removedRaw);
  removed._conversationPolicy = "task";
  expect((await f.run(removed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(removed.context.tools).toEqual([]);
  const binding = current.runtime.continuityBinding!;
  expect(binding.discoveredTools).toEqual([]);
  const count = f.controls.toolResults.length;
  await f.run(removed);
  expect(f.controls.toolResults).toHaveLength(count);
  // An old discovery copy cannot restore a permission that the current registry removed.
  f.controls.invokeSourceTools = false;
  const later = parseRequest({ ...raw, tools: [], input: [search,
    ...removedRaw.input.slice(0, -1), { type: "message", role: "assistant", content: "Completed previous work." },
    { type: "message", role: "user", id: "msg-after-removal", content: "Continue after removal.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-removal" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-removal" }) } });
  later._conversationPolicy = "task";
  await f.run(later);
  expect(later.context.tools).toEqual([]);
});

for (const manual of [false, true]) test(`Round 8: historical result collision outside current native instruction ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const prior = { type: "function_call_output", call_id: "completed-historical-call", output: "Completed historical result." };
  const first = f.request("", "turn-first", [prior, ...(f.request()._rawBody as { input: unknown[] }).input]);
  await f.run(first);
  const session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = session.outstanding()[0]!;
  const resultInput = [...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Current real result." }];
  const result = f.request("", "turn-first", resultInput);
  const cleanOutcome = await f.run(result);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  expect(cleanOutcome.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const historyChanged = structuredClone(resultInput);
  (historyChanged[0] as { call_id: string }).call_id = call.callId;
  const retry = f.request("", "turn-first", historyChanged);
  session.assertCanonicalReplayInput(retry);
  const outcome = await f.run(retry).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code, message: error.message }));
  expect(outcome).toMatchObject({ accepted: true, events: cleanOutcome });
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(delivered);
});

for (const manual of [false, true]) for (const content of ["New task B.", "Source A."]) test(`Round 8: accepted same-turn source echo cannot mask new instruction ${manual} ${content}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request("Source A.", "turn-first");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(e => e.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const newTask = { type: "message", role: "user", id: "msg-new-same-turn", content, internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const prefix = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, ...(first._rawBody as { input: unknown[] }).input, newTask];
  const tail = [...prefix, ...(first._rawBody as { input: unknown[] }).input];
  const request = f.request("", "turn-first", tail);
  const count = f.submissions.length;
  const result = await f.run(request).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code, message: error.message }));
  const control = f.request("", "turn-first", prefix);
  const controlResult = await f.run(control);
  expect(controlResult.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(count + 1);
  expect(result).toMatchObject({ accepted: true, events: controlResult });
  expect(chatGptCurrentInstructionRevision(request)?.itemId).toBe("msg-new-same-turn");
  expect(f.submissions.at(-1)?.prompt).toContain(content);
});

for (const manual of [false, true]) test(`Round 8: older accepted discovery cannot restore removed tools during compaction ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.repeatManualSourceTool = manual;
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as Record<string, unknown> & { input: unknown[]; tools: unknown[] };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const parse = (body: unknown) => {
    const parsed = parseRequest(body);
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse(raw);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const firstCall = source.outstanding()[0]!;
  const spec = { type: "function", name: "removed_discovery_tool", description: "Removed fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  const search = { type: "tool_search_output", call_id: firstCall.callId, status: "completed", tools: [spec] };
  const resultRun = f.run(parse({ ...raw, input: [...raw.input, search] }));
  if (!manual && source.runtime.mode === "tools") {
    const progress = source.runtime.externalProgress;
    let snapshot = progress.snapshot();
    const prior = snapshot.lastToolBatchRevision;
    while (snapshot.lastToolBatchRevision === prior) snapshot = await progress.waitForChange(snapshot.revision);
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  }
  expect((await resultRun).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const secondCall = source.outstanding()[0]!;
  const removal = { type: "tool_search_output", call_id: secondCall.callId, status: "completed", tools: [] };
  const acceptedHistory = [...raw.input, recordedCall(firstCall), search, recordedCall(secondCall), removal];
  expect((await f.run(parse({ ...raw, tools: [], input: [...raw.input, removal] }))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = source.runtime.continuityBinding!;
  expect(binding.discoveredTools).toEqual([]);
  const compact = parse({ ...raw, tools: [], input: acceptedHistory });
  compact._compactionRequest = true;
  let marker: unknown;
  {
    if (manual) f.controls.invokeSourceTools = false;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing summary");
    marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  }
  expect(binding.discoveredTools).toEqual([]);
  const prefix = [search, marker];
  const next = parse({ ...raw, tools: [], input: [...prefix,
    { type: "message", role: "user", id: "msg-after-removal", content: "Continue with current tools.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-removal" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-removal" }) },
  });
  f.controls.invokeSourceTools = false;
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const pending = f.run(next);
  while (!f.controls.started) await Bun.sleep(1);
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
  const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
    f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "invoke", bindingId: claim.bindingId, wireName: "removed_discovery_tool", freeform: false,
    registryGeneration: claim.environment.registryGeneration, arguments: { cmd: "fixture" },
  })).rejects.toThrow("does not advertise");
  if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "activity_complete", token, activityId: claim.activityId,
  });
  if (manual) f.broker.completeSafeTurn(token, "Completed current work.");
  else f.controls.releaseDeferredCompletion!();
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next.context.tools).toEqual([]);
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const manual of [false, true]) for (const aliasedSource of (manual ? [false, true] : [false])) test(`Round 8: real verified source alias replays checkpoint continuation ${manual} original alias ${aliasedSource}`, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-cont-alias-home-"));
  cleanups.push(async () => { rmSync(codexHome, { recursive: true, force: true }); });
  const f = fixture(manual, { codexHome, threadId: "019cbcc7-31b2-7028-a632-7f8118410711" });
  const turnId = "019cbcc7-31b2-7028-a632-7f8118410712";
  mkdirSync(join(codexHome, "sessions", "2026", "09", "30"), { recursive: true });
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T09-00-00-${f.threadId}.jsonl`);
  const append = (items: unknown[]) => writeFileSync(rolloutPath,
    readFileSync(rolloutPath, "utf8") + items.map(item => JSON.stringify(item)).join("\n") + "\n");
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: f.threadId, source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp", workspace_roots: ["/tmp"], approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  const request = (input: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({ ...f.request("", turnId, input)._rawBody as object,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: f.threadId, turn_id: turnId,
        agent_name: "/root", sandbox_mode: "danger-full-access", workspaces: { "/tmp": {} } }) },
    });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const sourceItem = { type: "message", role: "user", id: "msg-canonical-source", content: "Source instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } };
  const nativeSource = aliasedSource ? { ...sourceItem, id: "msg-initial-alias" } : sourceItem;
  // Both paths prove their original human source before compaction; turn permissions alone
  // cannot authenticate the canonical message. The aliased path also publishes its replacement.
  append([{ type: "response_item", payload: sourceItem }]);
  if (aliasedSource) append([{ type: "compacted", payload: { replacement_history: [nativeSource] } }]);
  const first = request([nativeSource]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  if (aliasedSource) expect(first._chatGptMessageIdAliases).toEqual({ "msg-initial-alias": sourceItem.id });
  const compact = request([nativeSource, recordedCall(call), { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const accepted = await f.run(request([marker, sourceItem]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const submissions = f.submissions.length;
  const renamed = { ...sourceItem, id: "msg-reidentified" };
  append([{ type: "response_item", payload: sourceItem }, { type: "compacted", payload: { replacement_history: [marker, renamed] } }]);
  const alias = request([marker, renamed]);
  expect(await f.run(alias)).toEqual(accepted);
  expect(alias._chatGptMessageIdAliases).toEqual({ "msg-reidentified": sourceItem.id });
  expect(f.submissions).toHaveLength(submissions);
  const conflicting = request([marker, { ...renamed, content: "Different current work." }]);
  await expect(f.run(conflicting)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const checkpoint of [false, true]) for (const grouped of [false, true]) test(`Round 9: current ${grouped ? "grouped preamble" : "prefix constraints"} survives ${checkpoint ? "checkpoint" : "ordinary"} boundary ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = checkpoint;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  let base = (f.next(first)._rawBody as { input: unknown[] }).input;
  if (checkpoint) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing summary");
    base = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, base.at(-1)];
    f.controls.invokeSourceTools = false;
  }
  const owner = { turn_id: "turn-next" };
  const prefix = grouped ? [{ type: "message", role: "user", id: "current-native-preamble", content: [
    { type: "input_text", text: "<recommended_plugins>Current example plugin</recommended_plugins>" },
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>CURRENT_GROUP_CONSTRAINT.</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>\n<shell>zsh</shell>\n</environment_context>" },
  ], internal_chat_message_metadata_passthrough: owner }] : (["system", "developer"] as const).map(role => ({
    type: "message", role, id: `current-prefix-${role}`, content: `CURRENT_PREFIX_${role.toUpperCase()}.`,
    internal_chat_message_metadata_passthrough: owner,
  }));
  const input = grouped ? [...base.slice(0, -1), ...prefix, base.at(-1)] : [...prefix, ...base];
  const next = f.request("", "turn-next", input);
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  if (grouped) {
    expect(prompt).toContain("CURRENT_GROUP_CONSTRAINT.");
    expect(prompt).toContain("<recommended_plugins>");
    expect(prompt.match(/CURRENT_GROUP_CONSTRAINT\./g)).toHaveLength(1);
  } else {
    expect(prompt).toContain("CURRENT_PREFIX_SYSTEM.");
    expect(prompt).toContain("CURRENT_PREFIX_DEVELOPER.");
  }
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  for (const id of grouped ? ["current-native-preamble"] : ["current-prefix-system", "current-prefix-developer"]) {
    const changed = structuredClone(input) as Array<Record<string, unknown>>;
    const item = changed.find(item => item.id === id)!;
    if (grouped) (item.content as Array<{ text: string }>)[1]!.text = "# AGENTS.md instructions\n<INSTRUCTIONS>Changed current constraint.</INSTRUCTIONS>";
    else item.content = "Changed current constraint.";
    await expect(f.run(f.request("", "turn-next", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) test(`Round 9: first checkpoint transition accepts structured source key order ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const original = { type: "message", role: "user", id: "source-instruction", content: [
    { type: "input_text", text: "Original source instruction." },
    { type: "input_text", text: "Keep the ordered second part." },
  ], internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [original]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [original,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const reordered = reverseJsonObjectKeys(original);
  const submissions = f.submissions.length;
  const accepted = await f.run(f.request("", "turn-first", [marker, reordered]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(f.request("", "turn-first", [marker, original]))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions + 1);
  for (const content of [[...original.content].reverse(), [
    { ...original.content[0], text: "Changed source instruction." }, original.content[1],
  ]]) {
    await expect(f.run(f.request("", "turn-first", [marker, { ...original, content }]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions + 1);
});

for (const manual of [false, true]) for (const parentFirst of [false, true]) for (const change of ["role", "content", "turn"] as const) test(`Round 9: first checkpoint transition rejects changed source ${change} ${manual} parent ${parentFirst}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const raw = structuredClone(f.request("Original source content.")._rawBody) as {
    input: Array<Record<string, unknown>>; client_metadata: Record<string, string>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
    request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" });
  const human = raw.input[0]!;
  const parent = { ...human, type: "agent_message", author: "/root", recipient: "/root/child" };
  delete (parent as Record<string, unknown>).role;
  const firstItem = parentFirst ? parent : human;
  const parse = (input: unknown[]) => {
    const parsed = parseRequest({ ...raw, input });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse([firstItem]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([firstItem, recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const changed = change === "role" ? parentFirst ? human : parent : change === "content"
    ? { ...firstItem, content: "Changed source content." }
    : { ...firstItem, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } };
  const submissions = f.submissions.length;
  await expect(f.run(parse([changed, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(parse([firstItem, marker]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
});

for (const manual of [false, true]) for (const field of ["author", "recipient"] as const) test(`Round 9: first checkpoint transition rejects changed parent ${field} ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const raw = structuredClone(f.request("Parent source content.")._rawBody) as { client_metadata: Record<string, string> };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
    request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" });
  const parent = { type: "agent_message", id: "parent-source", author: "/root", recipient: "/root/child",
    content: "Parent source content.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const parse = (input: unknown[]) => {
    const parsed = parseRequest({ ...raw, input });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse([parent]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([parent, recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const submissions = f.submissions.length;
  await expect(f.run(parse([{ ...parent, [field]: "/root/other" }, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(parse([parent, marker]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
});

for (const manual of [false, true]) test(`Round 9: foreign call echoes cannot hide malformed current results ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const result = { type: "function_call_output", call_id: call.callId, output: "Current source result." };
  const prefix = (first._rawBody as { input: unknown[] }).input;
  for (const type of ["function_call", "custom_tool_call", "tool_search_call"]) for (const invalid of [result,
    { ...result, call_id: "unowned-current-result" }, { ...result, type: "custom_tool_call_output" }]) {
    const request = f.request("", "turn-first", [...prefix, invalid,
      { type, call_id: "unowned-call-echo", name: "decorative-name", arguments: "{}" }, result]);
    await expect(f.run(request)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.controls.toolResults).toHaveLength(0);
    expect(source.outstanding()[0]!.callId).toBe(call.callId);
  }
  const accepted = await f.run(f.request("", "turn-first", [...prefix, result]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
});

for (const manual of [false, true]) for (const retainSource of [false, true]) test(`Round 9: checkpoint-only grouped instructions preserve source payload ${manual} retained ${retainSource}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request("Original source work.");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const sourceInput = (first._rawBody as { input: unknown[] }).input;
  const compact = f.request("", "turn-first", [...sourceInput,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const group = { type: "message", role: "user", id: "current-native-preamble", content: [
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Current checkpoint constraint.</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context><cwd>/tmp</cwd><shell>zsh</shell></environment_context>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const input = [group, ...(retainSource ? sourceInput : []), marker];
  const accepted = await f.run(f.request("", "turn-first", input));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt.match(/Current checkpoint constraint\./g)).toHaveLength(1);
  const submissions = f.submissions.length;
  const environmentChanged = structuredClone(group);
  environmentChanged.content[1]!.text = "<environment_context><cwd>/tmp/changed</cwd><shell>zsh</shell></environment_context>";
  expect(await f.run(f.request("", "turn-first", [environmentChanged, ...input.slice(1)]))).toEqual(accepted);
  const changed = structuredClone(group);
  changed.content[0]!.text = "# AGENTS.md instructions\n<INSTRUCTIONS>Changed checkpoint constraint.</INSTRUCTIONS>";
  await expect(f.run(f.request("", "turn-first", [changed, ...input.slice(1)]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  if (retainSource) {
    const changedSource = { ...(sourceInput[0] as object), content: "Changed source work." };
    await expect(f.run(f.request("", "turn-first", [group, changedSource, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) test(`Round 9: committed compaction replay rejects malformed result groups across echoes ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const prefix = (first._rawBody as { input: unknown[] }).input;
  const result = { type: "function_call_output", call_id: call.callId, output: "Accepted source result." };
  const compact = f.request("", "turn-first", [...prefix, recordedCall(call), result]);
  compact._compactionRequest = true;
  const accepted = await f.run(compact);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  for (const invalid of [result, { ...result, call_id: "unowned-current-result" }, { ...result, type: "custom_tool_call_output" }]) {
    const retry = f.request("", "turn-first", [...prefix, invalid,
      { type: "function_call", call_id: "unowned-call-echo", name: "decorative-name", arguments: "{}" }, result]);
    retry._compactionRequest = true;
    await expect(f.run(retry)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(await f.run(structuredClone(compact))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(delivered);
});

for (const manual of [false, true]) for (const retained of [false, true]) for (const idOnly of [false, true]) test(`Round 10: checkpoint-only continuation ignores completed prefix ${manual} retained ${retained} ID-only ${idOnly}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const oldUser = { type: "message", role: "user", content: "Completed historical request.",
    ...(idOnly ? { id: "historical-display-id" } : {}) };
  const oldAnswer = { type: "message", role: "assistant", content: "Completed historical answer." };
  const sourceItem = { type: "message", role: "user", id: "checkpoint-source", content: "Current source work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const constraint = { type: "message", role: "developer", content: "Keep this current constraint.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const items = [constraint, oldUser, oldAnswer, ...(retained ? [sourceItem] : []), marker];
  const continuation = f.request("", "turn-first", items);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  const accepted = await f.run(continuation);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).toContain("Keep this current constraint.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed historical request.");
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  const changedHistory = f.request("", "turn-first", [constraint, { ...oldUser, content: "Changed old history." },
    oldAnswer, ...(retained ? [sourceItem] : []), marker]);
  expect(await f.run(changedHistory)).toEqual(accepted);
  await expect(f.run(f.request("", "turn-first", [...items, { type: "message", role: "user", content: "Unidentified new task." }])))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  await expect(f.run(f.request("", "turn-first", [{ ...constraint, content: "Changed current constraint." }, ...items.slice(1)])))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  if (retained) {
    for (const changedSource of [{ ...sourceItem, content: "Changed current source." },
      { ...sourceItem, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } },
      { ...sourceItem, role: "assistant" }]) {
      await expect(f.run(f.request("", "turn-first", [constraint, oldUser, oldAnswer, changedSource, marker])))
        .rejects.toMatchObject({ code: "continuity_source_unproven" });
    }
  }
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.controls.toolResults).toHaveLength(delivered);
  expect(f.pages.size).toBe(1);
});

for (const retained of [false, true]) for (const idOnly of [false, true]) test(`Round 10: completed-source checkpoint preserves final with old prefix retained ${retained} ID-only ${idOnly}`, async () => {
  const f = fixture();
  const oldUser = { type: "message", role: "user", content: "Completed historical request.",
    ...(idOnly ? { id: "historical-display-id" } : {}) };
  const oldAnswer = { type: "message", role: "assistant", content: "Completed historical answer." };
  const sourceItem = { type: "message", role: "user", id: "completed-checkpoint-source", content: "Current source work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem]);
  const original = await f.run(first);
  const compact = structuredClone(first);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const continuation = f.request("", "turn-first", [oldUser, oldAnswer, ...(retained ? [sourceItem] : []), marker]);
  const submissions = f.submissions.length;
  const accepted = await f.run(continuation);
  expect(accepted.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.pages.size).toBe(1);
});

// Allow slower CI runners to complete all 600 sequential compaction requests.
for (const manual of [false, true]) test(`Round 10: cached compact codecs do not retain rewritten historical source evidence ${manual}`, async () => {
  const f = httpFixture(manual);
  f.controls.invokeSourceTools = manual;
  f.controls.singleSourceTool = manual;
  const parent = { type: "agent_message", id: "parent-current", author: "/root", recipient: "/root/child",
    content: "Current parent task.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const oldUser = (index: number) => ({ type: "message", role: "user", id: "old-user",
    content: [{ type: "input_text", text: `Older human text ${index}.` }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-older" } });
  const metadata = { thread_id: f.threadId, turn_id: "turn-first", subagent_kind: "thread_spawn", request_kind: "turn",
    parent_thread_id: "thread-parent", agent_name: "/root/child" };
  const body = { ...f.body, input: [oldUser(0), parent],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const first = await (await f.send(body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call");
  const result = call ? [call, { type: "function_call_output", call_id: call.call_id, output: "Accepted parent source result." }] : [];
  let checkpoint: unknown;
  let v1Output: unknown[] = [];
  for (let index = 0; index < 600; index += 1) {
    const format = index % 3;
    const compactBody = { ...body, input: [oldUser(index), parent, ...result,
      ...(format === 0 ? [{ type: "compaction_trigger" }]
        : format === 2 ? [{ type: "message", role: "user", content: COMPACT_PROMPT }] : [])],
      ...(format === 2 ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata,
        request_kind: "compaction", compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
      }) } } : {}),
    };
    const response = await f.send(compactBody, format === 1);
    expect(response.status).toBe(200);
    const output = (await response.json() as { output: unknown[] }).output;
    if (index === 0) checkpoint = output[0];
    if (index === 1) v1Output = output;
  }
  const probe = parseRequest({ ...body, input: [checkpoint] });
  routeChatGptWebRequest(probe, f.config);
  bindContinuityRequestScope(probe, chatGptWebExecutionNamespace(f.provider));
  const identity = extractChatGptTurnIdentity(probe);
  expect(isAcceptedCompactionContinuation(probe, identity, {
    itemId: parent.id, turnId: "turn-first", content: parent.content,
    instructionEnvelope: { role: "agent_message", author: parent.author, recipient: parent.recipient },
  })).toBe(true);
  for (let index = 0; index < 600; index += 1) {
    expect(isAcceptedCompactionContinuation(probe, identity, { itemId: "old-user", turnId: "turn-older",
      content: oldUser(index).content, instructionEnvelope: { role: "user" },
    })).toBe(index === 0);
  }
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), probe._continuityScope!)!;
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
  expect(f.submissions).toHaveLength(manual ? 1 : 2);
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 0);
  // A later codec replay can change its wire output, but it cannot enlarge committed evidence.
  expect(JSON.stringify(v1Output)).toContain("Older human text 1.");
}, 30_000);

test("recovery v3: an interrupted sent response resumes the same instruction on one new epoch", async () => {
  const f = fixture();
  f.controls.failAfterSendOnce = true;
  const original = f.request();
  const failed = await f.run(original);
  expect(failed.at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
  const retry = await f.run(f.request());
  expect(retry.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.claim.recovery!.epoch).toBe(f.submissions[0]!.claim.recovery!.epoch + 1);
  expect(f.submissions[1]!.claim.recovery!.logicalWorkId).toBe(f.submissions[0]!.claim.recovery!.logicalWorkId);
  expect(f.submissions[1]!.prompt).toContain("First continuity instruction.");
  expect(f.submissions[1]!.prompt).toContain("previous response was interrupted");
  expect(retry.filter(event => event.type === "text_delta" && event.text.includes("new ChatGPT conversation"))).toHaveLength(1);
});

for (const manual of [false, true]) test(`recovery v3: Windows identity admits the first request manual=${manual}`, async () => {
  const f = fixture(manual);
  f.descriptor.launcherInstance.startIdentity = "win32:134045280001234567";
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  f.controls.actualRecovery = !manual;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]!.claim.recovery!.launcherInstance).toEqual(f.descriptor.launcherInstance);
});

for (const manual of [false, true]) for (const unavailable of ["descriptor", "helper"] as const) test(`recovery v3: completed replay needs no ${unavailable} manual=${manual}`, async () => {
  const f = fixture(manual);
  const original = await f.run(f.request());
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const before = bindings.recoveryStore.get(thread)!;
  const registration = f.registrations.get(thread);
  const lastUsedAt = binding.lastUsedAt;
  const compatibleCalls = f.compatible.mock.calls.length;
  if (unavailable === "descriptor") rmSync(f.descriptorPath);
  f.compatible.mockRejectedValue(new Error("Helper unavailable"));
  const replay = await f.run(f.request());
  expect(replay.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.compatible.mock.calls.length).toBe(compatibleCalls);
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(f.registrations.get(thread)).toEqual(registration);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  await expect(f.run(f.request("Edited current instruction."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
});

for (const manual of [false, true]) for (const unavailable of ["descriptor", "helper"] as const) test(`recovery v3: completed compaction replay needs no ${unavailable} manual=${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = manual;
  f.controls.singleSourceTool = true;
  const source = f.request();
  const events = await f.run(source);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  const compact = call ? f.request("", "turn-first", [
    ...(source._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, source),
    { type: "function_call_output", call_id: call.id, output: "Actual completed tool result." },
  ]) : structuredClone(source);
  compact._compactionRequest = true;
  const original = await f.run(compact);
  expect(original.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const before = bindings.recoveryStore.get(thread)!;
  const lastUsedAt = binding.lastUsedAt;
  const registration = f.registrations.get(thread);
  const submissions = f.submissions.length;
  const compatibleCalls = f.compatible.mock.calls.length;
  if (unavailable === "descriptor") rmSync(f.descriptorPath);
  f.compatible.mockRejectedValue(new Error("Helper unavailable"));
  const replay = await f.run(structuredClone(compact));
  expect(replay.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.compatible.mock.calls.length).toBe(compatibleCalls);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.pages.size).toBe(1);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(f.registrations.get(thread)).toEqual(registration);
});

for (const history of ["omitted", "edited"] as const) test(`recovery v3: ordinary checkpoint recovery accepts ${history} covered results across attempts`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const sourceEvents = await f.run(first);
  const call = sourceEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const accepted = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), accepted]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const before = bindings.recoveryStore.get(thread)!;
  const checkpoint = Object.values(before.checkpoints)[0]!;
  expect(checkpoint.coveredCallIds).toEqual([call.id]);
  f.pages.clear(); bindings.lose(bindings.observed(thread)!);
  f.controls.invokeSourceTools = false;
  f.controls.failAfterSendOnce = true;
  const request = () => f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(history === "edited" ? [{ ...accepted, output: "Edited trusted historical result." }] : []),
  ]);
  expect((await f.run(request())).at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
  const interrupted = bindings.recoveryStore.get(thread)!;
  expect((await f.run(request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = bindings.recoveryStore.get(thread)!;
  expect(after.calls[call.id]!.firstResultDigest).toBe(before.calls[call.id]!.firstResultDigest);
  expect(after.checkpoints[checkpoint.commitId]!.continuation.consumerLogicalWorkId).toBe(interrupted.checkpoints[checkpoint.commitId]!.continuation.consumerLogicalWorkId);
  expect(f.submissions).toHaveLength(4);
});

for (const history of ["omitted", "edited"] as const) test(`recovery v3: appended checkpoint work recovers with ${history} covered results and requires uncovered results`, async () => {
  const f = fixture(false, { taskUpdates: true });
  f.controls.nativeSourceTools = true;
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const issued = await f.run(first);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const covered = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), covered]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  f.controls.singleSourceTool = true;
  const consumer = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input, marker]);
  const consumerEvents = await f.run(consumer);
  const consumerCall = consumerEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const uncovered = { type: "function_call_output", call_id: consumerCall.id, output: "Actual result before append." };
  const task = { type: "message", role: "user", id: "append-checkpoint-B", content: "Accepted appended task B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const old = history === "edited" ? [{ ...covered, output: "Edited trusted historical result." }] : [];
  const appended = f.request("", "turn-first", [marker, task, uncovered, ...old]);
  const bindings = continuityBindingsFor(f.statePath);
  const ref = bindings.observed(continuityDigest(f.threadId))!.recovery!;
  const record = bindings.recoveryStore.get(ref.thread)!;
  const logicalWorkId = recoveryDigest([record.scope, "turn-first", task.id, "ordinary"]);
  // Inject loss after the production append admission commits, before its local route publishes.
  recordRecoveryAppend(ref, { logicalWorkId, instructionIdentity: task.id, nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(appended), snapshotDigest: recoveryDigest(appended.context),
    localSessionId: "accepted-append-session", localTaskRevision: 1,
    results: [{ callId: uncovered.call_id, resultType: uncovered.type, resultDigest: recoveryResultDigest(uncovered) }] },
    [{ revision: 1, sourceMessageId: task.id, content: task.content, payloadDigest: recoveryDigest(task.content) }], 1);
  f.pages.clear(); bindings.lose(bindings.observed(ref.thread)!);
  f.controls.invokeSourceTools = false;
  evictOptionalRecoveryResults(f.statePath);
  const before = bindings.recoveryStore.get(ref.thread)!;
  await expect(f.run(f.request("", "turn-first", [marker, task, ...old]))).rejects.toMatchObject({ code: "continuity_context_missing" });
  await expect(f.run(f.request("", "turn-first", [marker, task, { ...uncovered, output: "Edited required result." }, ...old]))).rejects.toMatchObject({ code: "continuity_result_conflict" });
  expect(bindings.recoveryStore.get(ref.thread)).toEqual(before);
  expect(before.works[logicalWorkId]!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
  f.controls.acknowledgePendingUpdate = { revision: 1, sourceMessageId: task.id, content: task.content, payloadDigest: recoveryDigest(task.content) };
  expect((await f.run(appended)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const restoredTask = taskEnvelope(f.submissions.at(-1)!.prompt) as { messages: Array<{ role: string; content: unknown }> };
  expect(restoredTask.messages).toContainEqual({ role: "user", content: "First continuity instruction." });
  expect(restoredTask.messages).toContainEqual({ role: "user", content: task.content });
  const after = bindings.recoveryStore.get(ref.thread)!;
  expect(after.currentWorkId).toBe(logicalWorkId);
  expect(after.works[logicalWorkId]!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1,
    deliveries: [expect.objectContaining({ throughRevision: 1, acknowledged: true })] });
  expect(after.works[logicalWorkId]!.taskUpdateJournal!.updates).toHaveLength(1);
  expect(after.calls[call.id]!.firstResultDigest).toBe(before.calls[call.id]!.firstResultDigest);
  expect(after.calls[uncovered.call_id]!.firstResultDigest).toBe(before.calls[uncovered.call_id]!.firstResultDigest);
});

for (const manual of [false, true]) for (const pageState of ["healthy", "lost"] as const) test(`recovery v3: ${manual ? "manual" : "automatic"} completed checkpoint consumer replays after later work with a ${pageState} page`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const issued = await f.run(first);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first),
    { type: "function_call_output", call_id: call.id, output: "Actual covered result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const consumer = f.request("", "turn-first", [marker]);
  const completed = await f.run(consumer);
  expect(completed.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const originalText = completed.filter(event => event.type === "text_delta");
  expect((await f.run(f.request("", "turn-first", [marker]))).filter(event => event.type === "text_delta")).toEqual(originalText);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(consumer)}`)!;
  const answer = source.settledOutcome();
  if (answer?.type !== "final") throw new Error("Missing consumer answer");
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const consumerId = bindings.recoveryStore.get(thread)!.currentWorkId!;
  expect((await f.run(f.next(consumer, "turn-later", answer.answer))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = bindings.observed(thread)!;
  expect(binding.recovery!.logicalWorkId).not.toBe(consumerId);
  if (pageState === "lost") { f.pages.clear(); bindings.lose(binding); }
  const before = bindings.recoveryStore.get(thread)!;
  const pageBefore = structuredClone(binding);
  const sends = f.submissions.length;
  const replay = await f.run(f.request("", "turn-first", [marker]));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(replay.filter(event => event.type === "text_delta")).toEqual(originalText);
  expect(f.submissions).toHaveLength(sends);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(bindings.observed(thread)).toBe(binding);
  expect(binding).toEqual(pageBefore);
});

test("recovery v3: completed checkpoint consumer permits a new instruction after page loss", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const events = await f.run(first);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const accepted = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), accepted]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const consumer = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
  ]);
  expect((await f.run(consumer)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const before = bindings.recoveryStore.get(thread)!;
  f.pages.clear(); bindings.lose(bindings.observed(thread)!);
  expect((await f.run(f.next(consumer, "turn-new-after-completed-consumer", "Completed response 3."))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = bindings.recoveryStore.get(thread)!;
  expect(after.works[after.currentWorkId!]!.workLineageId).not.toBe(before.works[before.currentWorkId!]!.workLineageId);
  expect(after.calls[call.id]!.firstResultDigest).toBe(before.calls[call.id]!.firstResultDigest);
  expect(f.submissions).toHaveLength(4);
});

for (const manual of [false, true]) test(`recovery v3: ${manual ? "manual" : "automatic"} completed work replays after page loss and a new instruction creates a new epoch`, async () => {
  const f = fixture(manual);
  const original = f.request();
  await f.run(original);
  f.pages.clear();
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.claim.recovery!.epoch).toBe(1);
});

test("recovery v3: a real harmless command runs once and its accepted result enters the replacement prompt", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const counter = join(f.statePath, "safe-execution-count");
  f.controls.command = harmlessContinuityCommand(counter, "real recovery result");
  const original = f.request();
  const events = await f.run(original);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  expect(call).toBeDefined();
  const argumentsText = events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta")
    .map(event => event.arguments).join("");
  expect(JSON.parse(argumentsText).cmd).toBe(f.controls.command);
  const processResult = await $`${{ raw: JSON.parse(argumentsText).cmd }}`.quiet().nothrow();
  const stdout = processResult.stdout.toString();
  expect(processResult.exitCode, processResult.stderr.toString()).toBe(0);
  const raw = (original._rawBody as { input: unknown[] }).input;
  const result = { type: "function_call_output", call_id: call.id, output: stdout };
  const resultInput = [...raw, result];
  const interrupted = await f.run(f.request("", "turn-first", resultInput));
  expect(interrupted.at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
  f.controls.invokeSourceTools = false;
  await expect(f.run(f.request("", "turn-first", [...raw, { ...result, output: "Conflicting command result." }]))).
    rejects.toMatchObject({ code: "continuity_source_unproven" });
  for (const content of ["Changed source instruction.", ""]) {
    const unproven = structuredClone(raw) as Array<Record<string, unknown>>;
    unproven.find(item => item.role === "user")!.content = content;
    await expect(f.run(f.request("", "turn-first", [...unproven, result]))).
      rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(1);
  const recovered = await f.run(f.request("", "turn-first", resultInput));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(readFileSync(counter, "utf8")).toBe("x");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain(stdout);
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
});

for (const actualRecovery of [false, true]) for (const stage of ["prepared", "page-failed", "send-possible"] as const) test(`recovery v3: a real exited backend ${actualRecovery && stage === "prepared" ? "pre-RPC page-possible" : stage} attempt ${stage === "send-possible" ? "refuses unknown Send" : "resumes from durable evidence"} actualLauncher=${actualRecovery}`, async () => {
  const f = fixture();
  f.controls.actualRecovery = actualRecovery;
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const logicalWorkId = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const seed = { thread, scope: original._continuityScope!, logicalWorkId,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const oldLauncher = actualRecovery && stage === "send-possible" ? Bun.spawn([process.execPath, "-e",
    `import {continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))}; console.log(JSON.stringify(continuityProcessInstance())); setInterval(()=>{},1000);`],
    { stdout: "pipe", stderr: "pipe" }) : undefined;
  let oldLauncherIdentity: { pid: number; startIdentity: string; instanceId: string } | undefined;
  if (oldLauncher) {
    cleanups.push(async () => { oldLauncher.kill(); await oldLauncher.exited; });
    const reader = oldLauncher.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    const value = JSON.parse(new TextDecoder().decode(first.value));
    oldLauncherIdentity = { pid: value.pid, startIdentity: value.startIdentity, instanceId: "b".repeat(64) };
  }
  const script = join(f.statePath, "crashed-backend.ts");
  writeFileSync(script, `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {ContinuityRegistrationStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-registration.ts"))};
const store = new ContinuityRecoveryStore(${JSON.stringify(f.statePath)});
const owner = continuityProcessInstance();
const input = ${JSON.stringify(seed)};
store.admitWork({...input, owner});
new ContinuityRegistrationStore(${JSON.stringify(f.statePath)}).claim(input.thread,input.scope,owner.id);
${stage !== "prepared" ? `store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:"page-possible",launcherInstance:${oldLauncherIdentity ? JSON.stringify(oldLauncherIdentity) : actualRecovery ? JSON.stringify(f.descriptor.launcherInstance) : '{pid:owner.pid,startIdentity:owner.startIdentity,instanceId:"b".repeat(64)}'}});
${stage === "page-failed" ? 'store.recordFailure(input.thread,{scope:input.scope},input.logicalWorkId);' : 'store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:"send-possible"});'}` : ""}
`);
  if (actualRecovery && stage === "prepared") {
    // Run the public adapter through its durable acquisition boundary. The backend
    // exits before the worker can make its first Launcher acquisition RPC.
    writeFileSync(script, `import {createChatGptWebAdapter} from ${JSON.stringify(resolve("tests/helpers/chatgpt-web-adapter.ts"))};
import {ChatGptBrowserWorker} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
import {parseRequest} from ${JSON.stringify(resolve("src/responses/parser.ts"))};
import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const provider=${JSON.stringify(f.provider)};
const parsed=parseRequest(${JSON.stringify(original._rawBody)}); parsed._conversationPolicy="task";
const worker=ChatGptBrowserWorker.forProvider(provider);
worker.assertContinuityCompatible=async()=>{}; worker.supportsTaskUpdates=async()=>false;
worker.run=async turn=>{
  const record=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).get(${JSON.stringify(thread)});
  const attempt=record.works[record.currentWorkId].attempts.at(-1);
  if(attempt.stage!=="page-possible" || attempt.acquisitionEvidence?.status!=="possible" || attempt.sendEvidence || !turn.recoveryRequestId) process.exit(2);
  process.exit(0);
};
const adapter=createChatGptWebAdapter(provider); const context={headers:new Headers()};
await adapter.preflight(parsed,context); await adapter.runTurn(parsed,context,()=>{}); process.exit(3);
`);
  }
  const processResult = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(await processResult.exited, await new Response(processResult.stderr).text()).toBe(0);
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  if (actualRecovery && stage === "prepared") {
    const attempt = before.works[logicalWorkId]!.attempts[0]!;
    expect(continuityProcessInstanceStatus(before.owner)).toBe("exited");
    expect(attempt.stage).toBe("page-possible");
    expect(attempt.sendEvidence).toBeUndefined();
    expect(attempt.acquisitionEvidence?.status).toBe("possible");
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.recoveryHost.turnTabs.size).toBe(0);
    const identity = recoveryIdentity(before, new ContinuityRecoveryStore(f.statePath).installationId());
    launcherAuthority.bindExecutionAuthority(f.recoveryHost, identity, f.statePath);
    expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, identity)).toMatchObject({
      state: "missing", hostNoWriter: true, writerRetired: false, executionIsolated: false,
    });
    // A wrong target, wrong host, or missing no-writer proof must not borrow the
    // exact exited-before-RPC exception or advance the durable attempt.
    const query = launcherRecovery.queryContinuityTransaction;
    for (const fault of ["target", "host", "writer"] as const) {
      launcherRecovery.queryContinuityTransaction = (...args: unknown[]) => {
        const result = query(...args);
        return fault === "target" ? { ...result, recovery: { ...result.recovery, snapshotDigest: "f".repeat(64) } }
          : fault === "host" ? { ...result, launcherInstance: { ...result.launcherInstance, instanceId: "f".repeat(64) } }
          : { ...result, hostNoWriter: false };
      };
      try {
        await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
        expect(new ContinuityRecoveryStore(f.statePath).get(thread)).toEqual(before);
      } finally { launcherRecovery.queryContinuityTransaction = query; }
    }
  }
  f.controls.queryPhase = stage === "prepared" ? "missing" : "send-possible";
  const changedHistory = f.request("", "turn-first", [
    { type: "message", role: "assistant", content: "Edited completed history H2." },
    ...(original._rawBody as { input: unknown[] }).input,
  ]);
  if (stage === "send-possible") {
    // This fixture has no authenticated original submitted receipt. Backend or
    // Launcher exit proves no future writer, but cannot prove the first Send.
    if (oldLauncher) { oldLauncher.kill(); await oldLauncher.exited; }
    await expect(f.run(changedHistory)).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
    expect(f.submissions).toHaveLength(0);
    const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
    expect(after.works[logicalWorkId]!.attempts).toHaveLength(1);
    expect(after.works[logicalWorkId]!.attempts[0]!.stage).toBe("send-possible");
    return;
  }
  expect((await f.run(changedHistory)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  if (actualRecovery) expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions[0]!.prompt).toContain("Edited completed history H2.");
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(after.works[logicalWorkId]!.attempts.at(-1)!.snapshotVersion).toBe(1);
  expect(after.transaction!.transactionId).toBe(before.transaction!.transactionId);
  const expectedAttempts = stage === "prepared" && !actualRecovery && before.owner.startIdentity !== "unverified" ? 1 : 2;
  expect(after.works[logicalWorkId]!.attempts.length).toBe(expectedAttempts);
  if (expectedAttempts === 2) expect(after.works[logicalWorkId]!.attempts[0]!.writerRetired).toBe(true);
  if (actualRecovery && stage === "prepared") expect(after.epoch).toBe(before.epoch + 1);
});

test("recovery v3: real typed unacquired rollback survives backend exit with the same Launcher receipt", async () => {
  const f = fixture();
  f.controls.actualRecovery = true;
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
  const host = Object.assign(Object.setPrototypeOf(f.recoveryHost, BrowserHost.prototype), {
    manualCompletionSignals: new Map(), manualTerminalSignals: new Map(), userCancelledTurnOwners: new Map(),
    browserInteractionMode: () => "automatic", logger: { info() {}, warn() {}, error() {} },
  });
  for (let ordinal = 1; ordinal <= 5; ordinal++) host.turnTabs.set(`busy-${ordinal}`, {
    id: `busy-${ordinal}`, traceId: `busy-${ordinal}`, ordinal, status: "running",
    view: { webContents: { isDestroyed: () => false, close() { throw new Error("Active pages must remain"); } } },
  });
  const server = await new BrowserControlServer({ logger: host.logger, getPreferences: () => ({}), getBrowserHost: () => host }).start();
  cleanups.push(async () => { await server.close(); });
  const realDescriptorPath = join(f.statePath, "real-capacity-control.json");
  writeFileSync(realDescriptorPath, JSON.stringify({ ...f.descriptor, control: server.descriptor() }), { mode: 0o600 });
  const original = f.request();
  const thread = continuityDigest(f.threadId);
  const script = join(f.statePath, "known-unsent-backend.ts");
  // Capacity inspection and actual acquisition are independent: the public
  // adapter sees room at preflight, then the real host rejects a full page set.
  writeFileSync(script, `import {createChatGptWebAdapter} from ${JSON.stringify(resolve("tests/helpers/chatgpt-web-adapter.ts"))};
import {ChatGptBrowserWorker} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
import {parseRequest} from ${JSON.stringify(resolve("src/responses/parser.ts"))};
import {notifyLauncherTurn,LauncherKnownUnsentReceiptError} from ${JSON.stringify(resolve("src/launcher-browser-host.ts"))};
import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const provider=${JSON.stringify(f.provider)};
const parsed=parseRequest(${JSON.stringify(original._rawBody)}); parsed._conversationPolicy="task";
const worker=ChatGptBrowserWorker.forProvider(provider); let typed=false;
worker.assertContinuityCompatible=async()=>{}; worker.supportsTaskUpdates=async()=>false;
worker.run=async turn=>{try {
  await notifyLauncherTurn(${JSON.stringify(realDescriptorPath)}, {phase:"start",traceId:turn.traceId,helperPid:process.pid,
    conversationKey:turn.conversationKey,continuity:turn.continuity,recovery:turn.continuity.recovery,
    recoveryStoreDirectory:turn.recoveryStoreDirectory,requestId:turn.recoveryRequestId});
  throw new Error("Expected physical capacity refusal");
} catch(error) {typed=error instanceof LauncherKnownUnsentReceiptError; throw error;}};
const adapter=createChatGptWebAdapter(provider),context={headers:new Headers()};
await adapter.preflight(parsed,context); await adapter.runTurn(parsed,context,()=>{});
const record=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).get(${JSON.stringify(thread)});
const attempt=record.works[record.currentWorkId].attempts.at(-1);
if(!typed || attempt.stage!=="prepared" || attempt.acquisitionEvidence?.status!=="not-acquired" || !attempt.acquisitionEvidence.receiptId || attempt.sendEvidence) process.exit(2);
process.exit(0);
`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  expect(continuityProcessInstanceStatus(before.owner)).toBe("exited");
  const old = before.works[before.currentWorkId!]!.attempts[0]!;
  expect(old).toMatchObject({ stage: "prepared", writerRetired: false, acquisitionEvidence: { status: "not-acquired" } });
  expect(old.sendEvidence).toBeUndefined();
  const records = [...host.continuityTransactions.values()] as Array<{ state: string; writerRetired: boolean }>;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ state: "missing", writerRetired: true });
  expect(host.turnTabs.size).toBe(5);
  expect(f.submissions).toHaveLength(0);
  host.turnTabs.clear();
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(thread)!, work = after.works[after.currentWorkId!]!;
  expect(work.logicalWorkId).toBe(before.currentWorkId!);
  expect(work.attempts).toHaveLength(2);
  expect(work.attempts[0]!.writerRetired).toBe(true);
  expect(work.attempts[1]!.epoch).toBe(before.epoch + 1);
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const withResult of [false, true]) for (const stage of ["prepared", "send-possible"] as const) test(`recovery v3: checkpoint-only consumer survives ${stage} failure without allocating another consumer result=${withResult}`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const original = f.request();
  await f.run(original);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  const compact = f.request("", "turn-first", [
    ...(original._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Actual source result before consumer." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  if (stage === "prepared") f.controls.preLeaseFailures = 1;
  else f.controls.failAfterSendOnce = true;
  const request = () => f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(withResult ? [(compact._rawBody as { input: unknown[] }).input.at(-1)] : [])]);
  const failed = await f.run(request());
  expect(failed.at(-1)).toMatchObject({ type: "error" });
  const store = new ContinuityRecoveryStore(f.statePath);
  const before = store.get(continuityDigest(f.threadId))!;
  const checkpoint = Object.values(before.checkpoints)[0]!;
  const consumerId = checkpoint.continuation.consumerLogicalWorkId!;
  expect(consumerId).toBeDefined();
  const completed = await f.run(request());
  expect(completed.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.checkpoints[checkpoint.commitId]!.continuation.consumerLogicalWorkId).toBe(consumerId);
  expect(Object.keys(after.works).sort()).toEqual(Object.keys(before.works).sort());
  expect(after.works[consumerId]!.state).toBe("completed");
  expect(f.submissions.at(-1)!.prompt).toContain("Verified checkpoint.");
  expect(completed.filter(event => event.type === "tool_call_start")).toHaveLength(0);
});


for (const manual of [false, true]) test(`recovery v3: ${manual ? "manual" : "automatic"} transient inspection retries the original page without consuming a recovery attempt`, async () => {
  const f = fixture(manual);
  const original = f.request();
  await f.run(original);
  const before = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  f.controls.inspectFailures = 1;
  await expect(f.run(f.next(original))).rejects.toMatchObject({ code: "continuity_unverified", status: 503, retryable: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  const failed = new ContinuityRecoveryStore(f.statePath).get(before.thread)!;
  expect(failed.epoch).toBe(before.epoch);
  expect(Object.keys(failed.works)).toEqual(Object.keys(before.works));
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.claim.recovery!.epoch).toBe(before.epoch);
});

test("recovery v3: a lost page cannot promote historical discovery into new tool authority", async () => {
  const f = fixture();
  const original = f.request();
  await f.run(original);
  f.pages.clear();
  const next = f.next(original);
  const body = next._rawBody as { input: unknown[] };
  body.input.unshift({ type: "tool_search_output", call_id: "unowned-historical-search", status: "completed",
    tools: [{ type: "function", name: "unapproved_recovery_tool", description: "Unowned history", parameters: { type: "object" } }] });
  const replay = parseRequest({ ...next._rawBody as object });
  replay._conversationPolicy = "task";
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(replay.context.tools?.some(tool => tool.name === "unapproved_recovery_tool")).toBe(false);
  expect(f.submissions).toHaveLength(2);
});

for (const localBody of [false, true]) test(`recovery v3: consumed continuation accepts uncovered result with bounded reconciliation local=${localBody}`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const original = f.request();
  await f.run(original);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  const compact = f.request("", "turn-first", [...(original._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  f.controls.singleSourceTool = true;
  f.controls.failAfterToolsOnce = localBody;
  const consumerRequest = f.request("", "turn-first", [marker]);
  await f.run(consumerRequest);
  const consumer = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(consumerRequest)}`)!;
  const consumerCall = recordedCall(consumer.outstanding()[0]!);
  const result = { type: "function_call_output", call_id: consumer.outstanding()[0]!.callId, output: "Actual uncovered consumer result." };
  if (localBody) expect((await f.run(f.request("", "turn-first", [marker, consumerCall, result]))).at(-1)).toMatchObject({ type: "error" });
  else {
    f.pages.clear();
    const bindings = continuityBindingsFor(f.statePath);
    bindings.lose(bindings.observed(continuityDigest(f.threadId))!);
  }
  const store = new ContinuityRecoveryStore(f.statePath);
  const before = store.get(continuityDigest(f.threadId))!;
  f.controls.invokeSourceTools = false;
  const recovered = await f.run(f.request("", "turn-first", [marker, consumerCall, ...localBody ? [] : [result]]));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.currentWorkId).toBe(before.currentWorkId);
  expect(after.version - before.version).toBeLessThan(20);
  expect(after.calls[result.call_id]!.state).toBe("settled");
  expect(f.submissions.at(-1)!.prompt).toContain(result.output);
});

test("recovery v3: actual authenticated interrupt persists stopped before its HTTP receipt", async () => {
  const f = fixture(false, { threadId: "thread_real_interrupt" });
  f.controls.invokeSourceTools = true;
  await f.run(f.request());
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
  cleanups.push(async () => { provider.mockRestore(); });
  const server = startServer(config, { accessPolicy: OPENAI_ACCESS });
  cleanups.push(async () => { await server.stop(true); });
  const response = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
    method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId: f.threadId, turnId: "turn-first" }),
  });
  expect(response.status).toBe(200);
  const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(record.works[record.currentWorkId!]!.state).toBe("stopped");
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped" });
});

test("recovery v3: repeated failed acquisition consumes the persistent retry budget", async () => {
  const f = fixture();
  f.controls.actualRecovery = true;
  f.controls.acquisitionFailures = 5;
  for (let attempt = 0; attempt < 4; attempt++) {
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_unverified" });
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    expect(record.works[record.currentWorkId!]!.retryBudget?.attempts).toBe(attempt + 1);
    expect(record.works[record.currentWorkId!]!.retryBudget?.lastFailureAt).toBeNumber();
  }
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_retry_exhausted" });
  expect(f.controls.acquisitionFailures).toBe(1);
  expect(f.controls.actualAcquisitions).toBe(4);
  expect(f.submissions).toHaveLength(0);
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("recovery v3: acquisition retry exhaustion survives an actual backend exit", async () => {
  const f = fixture();
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const work = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const input = { thread, scope: original._continuityScope!, logicalWorkId: work,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const script = `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {recoveryIdentity} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);
const api=require(${JSON.stringify(resolve("launcher/electron/continuity-recovery.cjs"))});
const authority=require(${JSON.stringify(resolve("launcher/electron/continuity-execution-authority.cjs"))});
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}), input=${JSON.stringify(input)}, owner=continuityProcessInstance();
if(owner.startIdentity==='unverified'){console.log('unverified');process.exit(0);}
const launcherInstance={pid:owner.pid,startIdentity:owner.startIdentity,instanceId:'b'.repeat(64)};
const host={turnTabs:new Map(),continuityLauncherInstance:launcherInstance}; let count=0;
let record=store.admitWork({...input,owner});
for(let attempt=0;attempt<4;attempt++){
 if(attempt) record=store.reserveRecovery(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,owner,snapshotDigest:input.snapshotDigest});
 record=store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt,stage:'page-possible',launcherInstance});
 const recovery=recoveryIdentity(record,store.installationId());
 authority.bindExecutionAuthority(host,recovery,${JSON.stringify(f.statePath)});
 try{await api.acquireContinuityTransaction(host,{owner:owner.id,recovery},'trace'+attempt,owner.pid,'page'+attempt,'automatic',()=>{count++;throw Error('injected acquisition failure');});}catch{}
 store.recordFailure(input.thread,{scope:input.scope},input.logicalWorkId);
 store.retireAttempt(input.thread,{scope:input.scope},input.logicalWorkId,attempt); await api.retireContinuityWriter(host,recovery);
} console.log(count);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const output = (await new Response(child.stdout).text()).trim();
  if (output === "unverified") { expect(f.submissions).toHaveLength(0); return; }
  expect(output).toBe("4");
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(before.works[work]!.retryBudget?.attempts).toBe(4);
  await expect(f.run(original)).rejects.toMatchObject({ code: "continuity_retry_exhausted" });
  expect(f.submissions).toHaveLength(0);
});

for (const stop of ["mode-exit", "native"] as const) test(`recovery v3: ${stop} persists stop after backend restart without a live binding`, async () => {
  const f = fixture(false, { threadId: `thread_restart_stop_${stop}` });
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const work = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const input = { thread, scope: original._continuityScope!, logicalWorkId: work,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const child = Bun.spawn([process.execPath, "-e", `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
    new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).admitWork({...${JSON.stringify(input)},owner:continuityProcessInstance()});`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(continuityBindingsFor(f.statePath).observed(thread)).toBeUndefined();
  if (stop === "mode-exit") await leaveContinuityMode(f.statePath, f.threadId);
  else {
    const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
    const config = { ...defaultConfig("browser-only"), port: 0 };
    const server = startServer(config, { accessPolicy: OPENAI_ACCESS });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
        method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: f.threadId, turnId: "turn-first" }),
      });
      expect(response.status).toBe(200);
    } finally { await server.stop(true); provider.mockRestore(); }
  }
  const store = new ContinuityRecoveryStore(f.statePath);
  const stopped = store.get(thread)!;
  expect(stopped.works[work]!.state).toBe("stopped");
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped" });
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(store.get(thread)!.epoch).toBe(stopped.epoch + 1);
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped" });
  expect(f.submissions).toHaveLength(1);
});

const crashBudgetRoot = process.env.CGW_RECOVERY_CRASH_BUDGET_ROOT;
test.skipIf(!crashBudgetRoot)("recovery v3 worker: exit before acquisition failure receipt", async () => {
  const f = fixture(false, { root: crashBudgetRoot! });
  f.controls.actualRecovery = true;
  f.controls.acquisitionFailures = 1;
  const save = (code?: string) => {
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    writeFileSync(join(crashBudgetRoot!, "observed.json"), JSON.stringify({ calls: f.controls.actualAcquisitions,
      attempts: record.works[record.currentWorkId!]!.attempts.length,
      budget: record.works[record.currentWorkId!]!.retryBudget, code }));
  };
  spyOn(ContinuityRecoveryStore.prototype, "settleWriterFailure").mockImplementation(() => { save(); process.exit(0); });
  try { await f.run(f.request()); throw new Error("The acquisition should fail or exhaust its budget"); }
  catch (error) { save((error as { code?: string }).code); process.exit(0); }
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("recovery v3: five backend crashes before failure receipts permit only four actual acquisitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-budget-crash-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const observations: Array<{ calls: number; attempts: number; budget: { attempts: number; startedAt: number; lastFailureAt?: number }; code?: string }> = [];
  for (let index = 0; index < 5; index++) {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^recovery v3 worker: exit before acquisition failure receipt$"],
      { env: { ...process.env, CGW_RECOVERY_CRASH_BUDGET_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    observations.push(JSON.parse(readFileSync(join(root, "observed.json"), "utf8")));
  }
  expect(observations.map(value => value.calls)).toEqual([1, 1, 1, 1, 0]);
  expect(observations.map(value => value.attempts)).toEqual([1, 2, 3, 4, 4]);
  expect(observations.map(value => value.budget.attempts)).toEqual([1, 2, 3, 4, 4]);
  expect(observations.every(value => value.budget.lastFailureAt === undefined)).toBe(true);
  expect(observations.slice(1).map(value => value.budget.startedAt)).toEqual(Array(4).fill(observations[1]!.budget.startedAt));
  expect(observations.at(-1)?.code).toBe("continuity_retry_exhausted");
});

async function preparedMigrationFixture(creating = false, launcherInstance?: { pid: number; startIdentity: string; instanceId: string }) {
  const f = fixture();
  if (launcherInstance) {
    f.descriptor.pid = launcherInstance.pid;
    f.descriptor.launcherInstance = launcherInstance;
    f.recoveryHost.continuityLauncherInstance = launcherInstance;
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  }
  f.controls.actualRecovery = true;
  const original = f.request();
  const namespace = chatGptWebExecutionNamespace(f.provider);
  bindContinuityRequestScope(original, namespace);
  const thread = continuityDigest(f.threadId), scope = original._continuityScope!;
  const logicalWorkId = recoveryDigest([scope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const seed = { thread, scope, logicalWorkId, instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context), createPage: true, dispatchProtocolComplete: true };
  const child = Bun.spawn([process.execPath, "-e", `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),input=${JSON.stringify(seed)};
store.admitWork({...input,owner:continuityProcessInstance()});
store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:'page-possible',launcherInstance:${JSON.stringify(f.descriptor.launcherInstance)}});`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  const { recoveryIdentity } = await import("../src/adapters/chatgpt-web/continuity-recovery-runtime");
  const { chatGptConversationKey } = await import("../src/adapters/chatgpt-web/conversation-key");
  const old = recoveryIdentity(before, store.installationId());
  launcherAuthority.bindExecutionAuthority(f.recoveryHost, old, f.statePath);
  const claim = { owner: before.owner.id, recovery: old };
  original._continuityEpoch = before.epoch;
  const key = chatGptConversationKey(original, namespace)!;
  let finish!: () => void;
  const create = () => {
    const tab: any = { id: "prepared-tab", traceId: "prepared-trace", helperPid: child.pid, status: "running", destroyed: false,
      continuityLeaseId: "1".repeat(32), view: { webContents: { isDestroyed: () => tab.destroyed } } };
    launcherLease.bindContinuityTab(tab, claim);
    f.recoveryHost.turnTabs.set(tab.id, tab);
    return { continuity: launcherLease.continuityLease(tab) };
  };
  const acquired = launcherRecovery.acquireContinuityTransaction(f.recoveryHost, claim, "prepared-trace", child.pid, key, "automatic",
    () => creating ? new Promise(resolve => { finish = () => resolve(create()); }) : create());
  return { f, store, before, old, original, acquired, finish: () => finish(), recoveryIdentity };
}

for (const fault of ["creating", "before-handler", "lost-receipt"] as const) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`recovery v3: prepared migration reconciles ${fault} without another acquisition`, async () => {
    const { f, store, before, old, acquired, finish, recoveryIdentity } = await preparedMigrationFixture(fault === "creating");
    if (fault === "before-handler") f.controls.prepareBeforeFailures = 1;
    if (fault === "lost-receipt") f.controls.prepareAfterFailures = 1;
    const sameRequest = f.request();
    await expect(f.run(structuredClone(sameRequest))).rejects.toMatchObject({ code: "continuity_unverified" });
    const pending = store.get(before.thread)!;
    expect(pending.owner).toEqual(before.owner);
    expect(pending.transaction).toEqual(before.transaction);
    expect(f.submissions).toHaveLength(0);
    expect(f.controls.actualAcquisitions).toBe(0);
    if (fault === "creating") {
      expect(pending).toEqual(before);
      expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, old).state).toBe("creating");
      finish(); await acquired;
    } else {
      expect(pending.pendingPreparation?.expected).toEqual({ owner: before.owner, transaction: before.transaction! });
      await expect(f.run(f.request("Changed body under the accepted instruction ID."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
      expect(store.get(before.thread)).toEqual(pending);
      const { assertRecoveryWriter } = await import("../src/adapters/chatgpt-web/continuity-recovery-runtime");
      expect(() => assertRecoveryWriter({ directory: f.statePath, thread: before.thread, logicalWorkId: before.currentWorkId!, attempt: 0 }))
        .toThrow("still being coordinated");
      const hostTag = fault === "lost-receipt" ? recoveryIdentity({ ...pending, ...pending.pendingPreparation!.target }, store.installationId()) : old;
      expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, hostTag).state).toBe("prepared");
    }
    expect((await f.run(structuredClone(sameRequest))).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
    expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined();
    expect(after.transaction!.snapshotVersion).toBe(1);
    expect(f.submissions).toHaveLength(1);
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.recoveryHost.turnTabs.size).toBe(1);
  });
}

for (const phase of ["before-rpc", "after-rpc", "after-complete", "second-backend-exit"] as const) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`recovery v3: persisted migration survives ${phase}`, async () => {
    const { f, store, before } = await preparedMigrationFixture();
    const migrate = async (apply: boolean) => {
      const script = `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {recoveryIdentity} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
import {updateLauncherContinuityPreparation} from ${JSON.stringify(resolve("src/launcher-browser-host.ts"))};
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),thread=${JSON.stringify(before.thread)};let record=store.get(thread)!;
if(record.pendingPreparation){const p=record.pendingPreparation;await updateLauncherContinuityPreparation(${JSON.stringify(f.descriptorPath)},{expected:recoveryIdentity({...record,...p.expected},store.installationId()),recovery:recoveryIdentity({...record,...p.target},store.installationId())});record=store.completePreparation(thread,{scope:record.scope,expectedVersion:record.version},p.preparationId);}
record=store.beginPreparation(thread,{scope:record.scope,expectedVersion:record.version},{logicalWorkId:record.currentWorkId!,owner:continuityProcessInstance(),snapshotDigest:'9'.repeat(64),launcherInstance:${JSON.stringify(f.descriptor.launcherInstance)}});
const p=record.pendingPreparation!;
${apply ? `await updateLauncherContinuityPreparation(${JSON.stringify(f.descriptorPath)},{expected:recoveryIdentity({...record,...p.expected},store.installationId()),recovery:recoveryIdentity({...record,...p.target},store.installationId())});` : ""}
${phase === "after-complete" ? 'store.completePreparation(thread,{scope:record.scope,expectedVersion:record.version},p.preparationId);' : ""}
process.exit(0);`;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    };
    await migrate(phase !== "before-rpc");
    if (phase === "second-backend-exit") await migrate(false);
    if (phase === "after-complete") expect(store.get(before.thread)!.pendingPreparation).toBeUndefined();
    else expect(store.get(before.thread)!.pendingPreparation).toBeDefined();
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.transaction!.snapshotVersion).toBe(phase === "second-backend-exit" ? 3 : 2);
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
    expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined();
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.submissions).toHaveLength(1);
  });
}

for (const applied of [false, true]) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`recovery v3: stopped preparation migration permits a new task applied=${applied}`, async () => {
    const { f, store, before } = await preparedMigrationFixture();
    if (applied) f.controls.prepareAfterFailures = 1;
    else f.controls.prepareBeforeFailures = 1;
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
    expect(store.get(before.thread)!.pendingPreparation).toBeDefined();
    await leaveContinuityMode(f.statePath, f.threadId);
    expect(store.get(before.thread)!.works[before.currentWorkId!]!.state).toBe("stopped");
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped" });
    expect((await f.run(f.request("A different accepted task.", "turn-new"))).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.retiredPreparation).toBeDefined();
    expect(after.works[before.currentWorkId!]!.state).toBe("stopped");
    expect(after.epoch).toBe(before.epoch + 1);
    expect(f.controls.actualAcquisitions).toBe(1);
    expect(f.submissions).toHaveLength(1);
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_stopped" });
  });
}

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("recovery v3: an exactly retired pending target requires a new acquisition attempt", async () => {
  const { f, store, before, recoveryIdentity } = await preparedMigrationFixture();
  f.controls.prepareAfterFailures = 1;
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
  const pending = store.get(before.thread)!;
  const target = recoveryIdentity({ ...pending, ...pending.pendingPreparation!.target }, store.installationId());
  const observed = launcherRecovery.queryContinuityTransaction(f.recoveryHost, target);
  expect(observed.state).toBe("prepared");
  expect(observed.preparationExpected).toEqual(recoveryIdentity({ ...pending, ...pending.pendingPreparation!.expected }, store.installationId()));
  store.completePreparation(before.thread, { scope: before.scope, expectedVersion: pending.version }, pending.pendingPreparation!.preparationId);
  store.retireAttempt(before.thread, { scope: before.scope }, before.currentWorkId!, before.works[before.currentWorkId!]!.attempts.at(-1)!.attempt);
  const retired = await launcherRecovery.retireContinuityWriter(f.recoveryHost, target);
  expect(retired.writerRetired).toBe(true);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.pendingPreparation).toBeUndefined();
  expect(after.works[before.currentWorkId!]!.attempts).toHaveLength(2);
  expect(after.epoch).toBe(before.epoch + 1);
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("recovery v3: pending migration survives a proved Launcher restart but rejects its live predecessor", async () => {
  const launcher = Bun.spawn([process.execPath, "-e", `import {continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))}; console.log(JSON.stringify(continuityProcessInstance())); setInterval(()=>{},1000);`], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { launcher.kill(); await launcher.exited; });
  const reader = launcher.stdout.getReader();
  const output = await reader.read(); reader.releaseLock();
  const processIdentity = JSON.parse(new TextDecoder().decode(output.value));
  const oldInstance = { pid: processIdentity.pid, startIdentity: processIdentity.startIdentity, instanceId: "c".repeat(64) };
  const { f, store, before } = await preparedMigrationFixture(false, oldInstance);
  f.controls.prepareBeforeFailures = 1;
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
  const pending = store.get(before.thread)!;
  // A replacement host's empty table cannot prove that its live predecessor has
  // no page. The child is a real process; browser surfaces remain test fixtures.
  const host = f.recoveryHost as typeof f.recoveryHost & { continuityTransactions: Map<string, unknown>; continuityTransactionReceipts: Map<string, unknown> };
  host.turnTabs.clear(); host.continuityTransactions.clear(); host.continuityTransactionReceipts.clear();
  const current = continuityProcessInstance();
  const newInstance = { pid: current.pid, startIdentity: current.startIdentity, instanceId: "d".repeat(64) };
  f.descriptor.pid = newInstance.pid;
  f.descriptor.launcherInstance = newInstance; host.continuityLauncherInstance = newInstance;
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
  expect(store.get(before.thread)).toEqual(pending);
  expect(f.controls.actualAcquisitions).toBe(0);
  launcher.kill(); await launcher.exited;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.pendingPreparation).toBeUndefined();
  expect(after.works[before.currentWorkId!]!.attempts).toHaveLength(2);
  expect(after.epoch).toBe(before.epoch + 1);
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`unified recovery: Fresh chooses a cold full input and exact replay keeps it (${manual})`, async () => {
  const f = fixture(manual);
  f.provider.chatgptWeb!.experimentalFreshConversationPerTurn = true;
  const first = f.request("First task text must remain in the cold input.");
  await f.run(first);
  const next = f.next(first);
  const result = await f.run(next);
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("First task text must remain in the cold input.");
  expect(f.submissions[1]!.prompt).toContain("Completed response 1.");
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(await f.run(structuredClone(next))).toEqual(result);
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) for (const reason of ["Fresh", "budget"] as const)
for (const wait of ["source-sync", "capacity"] as const) test(`ordinary cold preflight: stale ${reason} ${wait} preserves the newer writer (${manual})`, async () => {
  const f = fixture(manual);
  f.provider.chatgptWeb!.experimentalFreshConversationPerTurn = reason === "Fresh";
  const first = f.request();
  await f.run(first);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  const preflightInput = continuityInput.preflightContinuityInput;
  const budgetCheck = reason === "budget" ? spyOn(continuityInput, "preflightContinuityInput").mockImplementation((...args) => {
    if (args[3] && args[4]?.retainedTokens !== undefined) {
      throw Object.assign(new Error("The fixture retained page has no remaining context budget."), { code: "CONTEXT_BUDGET_EXCEEDED" });
    }
    return preflightInput(...args);
  }) : undefined;
  let entered!: () => void, release!: () => void, started!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const holding = new Promise<void>(resolve => { release = resolve; });
  const starting = new Promise<void>(resolve => { started = resolve; });
  let observations = 0;
  const pauseFirst = async () => { if (++observations === 1) { entered(); await holding; } };
  if (wait === "capacity") f.controls.onCapacityQuery = pauseFirst;
  source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (wait === "source-sync") await pauseFirst();
  };
  const stale = f.run(f.next(first, "turn-stale")).catch(error => ({ code: (error as { code?: string }).code }));
  let newer: Promise<AdapterEvent[]> | undefined;
  let finishedNewer = false;
  const finishNewer = () => {
    if (!newer || finishedNewer) return;
    finishedNewer = true;
    if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "The newer task completed.");
    else f.controls.releaseDeferredCompletion?.();
  };
  try {
    expect(await Promise.race([entering.then(() => true), stale.then(() => false)])).toBe(true);
    f.controls.deferCompletion = true;
    f.controls.onStarted = started;
    newer = f.run(f.next(first, "turn-newer"));
    expect(await Promise.race([starting.then(() => true), newer.then(() => false)])).toBe(true);
    const before = bindings.recoveryStore.get(thread)!;
    const workId = before.currentWorkId!;
    expect(before.works[workId]).toMatchObject({ nativeTurnId: "turn-newer", state: "active" });
    expect(before.works[workId]!.attempts.at(-1)!.writerRetired).toBe(false);
    const active = chatGptTurnSessions.find(bindings.observed(thread)!.executionKey!)!;
    expect(active.isActive()).toBe(true);
    release();
    const rejected = await stale;
    expect(Array.isArray(rejected) ? rejected.at(-1) : rejected).toMatchObject({ code: "continuity_source_unproven" });
    const after = bindings.recoveryStore.get(thread)!;
    expect(after).toEqual(before);
    expect(after.works[workId]!.attempts.at(-1)!.writerRetired).toBe(false);
    expect(active.isActive()).toBe(true);
    expect(active.settledOutcome()).toBeUndefined();
    finishNewer();
    expect((await newer).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const completed = bindings.recoveryStore.get(thread)!;
    expect(completed.currentWorkId).toBe(workId);
    expect(completed.works[workId]!.state).toBe("completed");
    expect(completed.works[workId]!.attempts.at(-1)!.stage).toBe("completed");
    expect(active.settledOutcome()).toMatchObject({ type: "final" });
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.reused).toBe(false);
  } finally {
    release();
    try { finishNewer(); } catch { /* A failing race assertion can leave the test writer revoked. */ }
    await Promise.allSettled([stale, ...(newer ? [newer] : [])]);
    source.runtime.syncContextUsage = sync;
    f.controls.onCapacityQuery = undefined;
    budgetCheck?.mockRestore();
  }
}, 30_000);

for (const checkpoint of [false, true]) test(`unified recovery: an oversized real tool source survives fault loss and is read from the actual new entry (checkpoint=${checkpoint})`, async () => {
  const f = fixture();
  let original = f.request("Continue this accepted task after reading the stored log tail.");
  if (checkpoint) {
    f.controls.invokeSourceTools = true;
    const sourceEvents = await f.run(original);
    const sourceCall = sourceEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
    const compact = f.request("", "turn-first", [...(original._rawBody as { input: unknown[] }).input,
      currentRecordedCall(f.provider, original),
      { type: "function_call_output", call_id: sourceCall.id, output: "Completed original checkpoint source call." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    original = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  }
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const firstEvents = await f.run(original);
  const call = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const tail = "UNREAD_TAIL_6F81A9C2";
  const log = "original tool evidence line\n".repeat(80_000) + tail;
  const input = [...(original._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: log }];
  expect((await f.run(f.request("", "turn-first", input))).at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  expect(before.works[before.currentWorkId!]!.state).not.toBe("stopped");
  f.controls.invokeSourceTools = false;
  let readBody = "";
  f.automatic.mockImplementationOnce(async turn => {
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "b".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.text).not.toContain(tail);
    expect(compiled.text).toContain("Continue this accepted task after reading the stored log tail.");
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const entry = JSON.parse(compiled.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.turn_token, contract: "native", credentialKind: "ordinary", contextProtocol: 2,
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.turn_token,
        contract: "native", credentialKind: "ordinary", contextProtocol: 2, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const found = (await query("search", { query: tail })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    readBody = parseContextTextReadResult(read).body;
    expect(readBody).toContain(tail);
    f.pages.get(turn.conversationKey!)!.state = "ready";
    turn.onTextDelta("Continued from the real stored tail.");
    return "Continued from the real stored tail.";
  });
  const recovered = await f.run(f.request("", "turn-first", input));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  expect(readBody).toContain(tail);
  const after = store.get(thread)!;
  expect(Object.keys(after.calls)).toEqual(Object.keys(before.calls));
  expect(after.calls[call.id]!.firstResultDigest).toBe(before.calls[call.id]!.firstResultDigest);
  expect(f.submissions).toHaveLength(checkpoint ? 4 : 2);
}, 30_000);

test("unified recovery: non-externalized assistant text still fails before a replacement send", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const original = f.request();
  const events = await f.run(original);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const input = [...(original._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: "The actual completed return." }];
  await f.run(f.request("", "turn-first", input));
  f.controls.invokeSourceTools = false;
  const oversized = f.request("", "turn-first", [...input,
    { type: "message", role: "assistant", content: "Required assistant source text. ".repeat(60_000) }]);
  await expect(f.run(oversized)).rejects.toMatchObject({ code: "continuity_input_limit" });
  expect(f.submissions).toHaveLength(1);
}, 30_000);

for (const manual of [false, true]) for (const checkpoint of [false, true]) test(`review repair1: persistent inspection failure isolates the old writer and admits one cold successor (${manual}, checkpoint=${checkpoint})`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.repeatManualSourceTool = manual && checkpoint;
  f.controls.singleSourceTool = !checkpoint;
  const source = f.request("Continue the accepted source after an inspection failure.");
  const issued = await f.run(source);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  let next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: "The actual settled command return." }]);
  if (checkpoint) {
    const compact = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
      currentRecordedCall(f.provider, source),
      { type: "function_call_output", call_id: call.id, output: "The actual settled command return." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
    next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  }
  f.controls.invokeSourceTools = false;
  f.controls.repeatManualSourceTool = false;
  f.controls.retirementCleanup = "pending";
  f.controls.inspectFailures = 100;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const previousSubmissions = f.submissions.length;
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_unverified" });
  const result = await f.run(structuredClone(next));
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(previousSubmissions + 1);
  expect(f.submissions.at(-1)!.reused).toBe(false);
  expect(f.submissions.at(-1)!.prompt).toContain("Continue the accepted source after an inspection failure.");
  const after = store.get(thread)!;
  expect(after.epoch).toBe(before.epoch + 1);
  expect(Object.values(after.works).flatMap(work => work.attempts).filter(attempt => !attempt.writerRetired)).toHaveLength(0);
  expect(result.filter(event => event.type === "text_delta" && event.text.includes("ChatGPT's own activities may still be running"))).toHaveLength(1);
  expect(await f.run(structuredClone(next))).toEqual(result);
  expect(f.submissions).toHaveLength(previousSubmissions + 1);
}, 30_000);

for (const ordinaryRounds of [1, 2]) test(`review repair1: healthy checkpoint keeps its page only while its independent source and summary budget fits (${ordinaryRounds})`, async () => {
  const f = fixture();
  const instruction = "Repeat the same continuity instruction.";
  const first = f.request(instruction);
  await f.run(first);
  const firstCompact = structuredClone(first); firstCompact._compactionRequest = true;
  const firstCheckpointEvents = await f.run(firstCompact);
  const summary = firstCheckpointEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (summary?.type !== "text_delta") throw new Error("Missing first actual checkpoint");
  const physicalKey = f.submissions[0]!.key;
  expect(f.submissions[1]!.key).toBe(physicalKey);
  let input: unknown[] = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
  let current!: CodexParsedRequest;
  for (let index = 0; index < ordinaryRounds; index++) {
    const turnId = `turn-budget-${index}`;
    current = f.request("", turnId, [...input, { type: "message", role: "user", id: `msg-budget-${index}`, content: instruction,
      internal_chat_message_metadata_passthrough: { turn_id: turnId } }]);
    const events = await f.run(current);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.submissions.at(-1)!.key).toBe(physicalKey);
    expect(f.submissions.at(-1)!.reused).toBe(true);
    const answer = events.find(event => event.type === "text_delta" && event.phase === "final_answer");
    if (answer?.type !== "text_delta") throw new Error("Missing actual ordinary answer");
    input = [...(current._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: answer.text }] }];
  }
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const sourceWork = before.works[before.currentWorkId!]!;
  const secondCompact = structuredClone(current); secondCompact._compactionRequest = true;
  const checkpointEvents = await f.run(secondCompact);
  expect(checkpointEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const secondPage = f.submissions.at(-1)!;
  expect(secondPage.reused).toBe(ordinaryRounds === 1);
  if (ordinaryRounds === 1) {
    expect(secondPage.key).toBe(physicalKey);
  } else {
    expect(secondPage.key).not.toBe(physicalKey);
    expect(secondPage.claim.expected).toBeUndefined();
    expect(secondPage.prompt).toContain("codex_context_navigation_json");
    const turn = f.automatic.mock.calls.at(-1)![0];
    expect(turn).toMatchObject({ compaction: true, nativeConnector: true, capabilities: { localToolsEnabled: false } });
  }
  const after = store.get(thread)!;
  const checkpoint = Object.values(after.checkpoints).find(value => value.targetHistoryRevision === 2)!;
  expect(checkpoint.sourceLogicalWorkId).toBe(sourceWork.logicalWorkId);
  expect(checkpoint.acceptedTaskRevision).toBe(sourceWork.acceptedTaskRevision);
  expect(after.historyRevision).toBe(2);
  expect(after.epoch).toBe(before.epoch + (ordinaryRounds === 1 ? 0 : 1));
  const compactWork = after.works[`compaction:${checkpoint.compactionTargetId}`]!;
  expect(compactWork.attempts).toHaveLength(1);
  expect(compactWork.state).toBe("completed");
  const sends = f.submissions.length;
  const replay = await f.run(structuredClone(secondCompact));
  expect(replay.filter(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual(checkpointEvents.filter(event => event.type === "text_delta" && event.phase === "final_answer"));
  expect(replay.at(-1)).toEqual(checkpointEvents.at(-1));
  expect(f.submissions).toHaveLength(sends);
  const acceptedSummary = checkpointEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (acceptedSummary?.type !== "text_delta") throw new Error("Missing second actual checkpoint");
  const newWork = f.request("", "turn-after-budget-checkpoint", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(acceptedSummary.text) },
    { type: "message", role: "user", id: "msg-after-budget-checkpoint", content: "Continue with new work after the actual checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-budget-checkpoint" } },
  ]);
  expect((await f.run(newWork)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.key).toBe(secondPage.key);
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).not.toContain(acceptedSummary.text);
}, 30_000);

test("review repair1: persistent inspection failure cannot replace an unknown Send", async () => {
  const f = fixture();
  const original = f.request();
  f.automatic.mockImplementationOnce(async turn => {
    const lease = { owner: turn.continuity!.owner, leaseId: "d".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!();
    throw continuityError("continuity_unverified", "The original Send has no submission receipt.");
  });
  await f.run(original);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  binding.state = "unverified";
  f.controls.inspectFailures = 100;
  await expect(f.run(structuredClone(original))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  const record = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(record.works[record.currentWorkId!]!.attempts).toHaveLength(1);
  expect(record.works[record.currentWorkId!]!.attempts[0]!.stage).toBe("send-possible");
  expect(f.submissions).toHaveLength(1);
});

for (const barrier of ["missing-result", "explicit-stop", "old-protocol"] as const) test(`review repair1: persistent inspection failure preserves the ${barrier} admission barrier`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const source = f.request();
  const issued = await f.run(source);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
    ...(barrier === "missing-result" ? [] : [{ type: "function_call_output", call_id: call.id, output: "The actual completed return." }])]);
  const thread = continuityDigest(f.threadId), bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(thread)!;
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  binding.state = "unverified";
  f.controls.invokeSourceTools = false; f.controls.inspectFailures = 100;
  if (barrier === "explicit-stop") store.stopWork(thread, { scope: before.scope }, before.currentWorkId!, "user-stop");
  if (barrier === "old-protocol") {
    f.descriptor.features = f.descriptor.features.filter(feature => feature !== CONTINUITY_EXECUTION_FENCING_FEATURE);
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  }
  await expect(f.run(next)).rejects.toMatchObject({ code: barrier === "missing-result" ? "continuity_execution_unsettled"
    : barrier === "explicit-stop" ? "continuity_stopped" : "continuity_configuration_conflict" });
  expect(store.get(thread)!.epoch).toBe(before.epoch);
  expect(f.submissions).toHaveLength(1);
}, 30_000);

for (const route of [
  { source: "chatgpt-web/gpt-6-sol-instant", successor: "chatgpt-web/gpt-6-sol-instant" },
  { source: "chatgpt-web/gpt-5.6-sol-instant", successor: "chatgpt-web/gpt-5.6-sol-instant" },
]) test(`repair4: HTTP public routed source echo recovers through its actual new navigation entry (${route.source} -> ${route.successor})`, async () => {
  const f = httpFixture();
  f.body.model = route.source;
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.failAfterToolsOnce = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const calls = first.output.filter(item => item.type === "function_call");
  expect(calls).toHaveLength(1);
  const callId = calls[0]!.call_id as string;
  const tail = "SYNTHETIC_UNREAD_TAIL_74D3B1";
  const log = "Original public response tool source line.\n".repeat(60_000) + tail;
  const result = { type: "function_call_output", call_id: callId, output: log };
  const continuation = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
  const failedResponse = await f.send(continuation);
  const failed = await failedResponse.json() as { status: string; error?: { code?: string } };
  expect(failed.status).toBe("failed");
  expect(failed.error?.code).toBe("continuity_session_lost");
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const work = before.works[before.currentWorkId!]!;
  expect(work.state).toBe("active");
  expect(work.attempts).toHaveLength(1);
  expect(work.attempts[0]!.stage).toBe("accepted");
  expect(work.stopReason).toBeUndefined();
  expect(before.calls[callId]!.firstResultDigest).toBe(recoveryResultDigest(result));
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.pages.size).toBe(0);
  f.controls.invokeSourceTools = false;
  let readBody = "";
  let selectedPlan = false;
  f.automatic.mockImplementationOnce(async turn => {
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "b".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.contextPlan).toBeDefined();
    expect(compiled.text).not.toContain(tail);
    expect(compiled.text.length).toBeLessThan(log.length);
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    selectedPlan = true;
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const active = store.get(thread)!;
    const successor = active.works[active.currentWorkId!]!;
    expect(successor.logicalWorkId).toBe(work.logicalWorkId);
    expect(successor.workLineageId).toBe(work.workLineageId);
    expect(successor.acceptedTaskRevision).toBe(work.acceptedTaskRevision);
    expect(successor.retryBudget!.startedAt).toBe(work.retryBudget!.startedAt);
    expect(successor.retryBudget!.attempts).toBe(work.retryBudget!.attempts + 1);
    const entry = JSON.parse(compiled.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.turn_token, contract: "native", credentialKind: "ordinary", contextProtocol: 2,
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.turn_token,
        contract: "native", credentialKind: "ordinary", contextProtocol: 2, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const found = (await query("search", { query: tail })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    readBody = parseContextTextReadResult(read).body;
    expect(readBody).toContain(tail);
    f.pages.get(turn.conversationKey!)!.state = "ready";
    turn.onTextDelta("Completed from the actual stored public source.");
    return "Completed from the actual stored public source.";
  });
  const recoveryBody = { ...continuation, model: route.successor };
  const recoveredResponse = await f.send(recoveryBody);
  const recovered = await recoveredResponse.json() as { status: string; output: Array<Record<string, unknown>>; error?: { code?: string; message?: string } };
  expect({ httpStatus: recoveredResponse.status, code: recovered.error?.code }).toEqual({ httpStatus: 200, code: undefined });
  expect(recovered.status).toBe("completed");
  expect(recovered.output.some(item => item.type === "function_call")).toBe(false);
  expect(selectedPlan).toBe(true);
  expect(readBody).toContain(tail);
  const after = store.get(thread)!;
  expect(after.epoch).toBe(before.epoch + 1);
  expect(after.historyRevision).toBe(before.historyRevision);
  expect(after.works[after.currentWorkId!]!.logicalWorkId).toBe(work.logicalWorkId);
  expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  expect(Object.keys(after.calls)).toEqual([callId]);
  expect(after.calls[callId]!.firstResultDigest).toBe(before.calls[callId]!.firstResultDigest);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(f.controls.toolResults).toHaveLength(1);
  const replayResponse = await f.send(recoveryBody);
  expect(replayResponse.status).toBe(200);
  expect((await replayResponse.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.toolResults).toHaveLength(1);
}, 30_000);

test("repair4: HTTP public recovery preserves instruction, call, result and model-scope rejection barriers", async () => {
  const f = httpFixture();
  f.body.model = "chatgpt-web/gpt-6-sol-instant";
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  const result = { type: "function_call_output", call_id: call.call_id, output: "The actual first accepted result." };
  const body = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
  const failedResponse = await f.send(body);
  expect((await failedResponse.json()).error.code).toBe("continuity_session_lost");
  f.controls.invokeSourceTools = false;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  for (const alteration of ["instruction", "call-arguments", "first-result", "model-scope"] as const) {
    const changed = structuredClone(body);
    if (alteration === "instruction") (changed.input[0] as { content: unknown }).content = "Changed source under the same native ID.";
    else if (alteration === "call-arguments") (changed.input.find(item => (item as { type?: string }).type === "function_call") as { arguments: string })
      .arguments = JSON.stringify({ cmd: "different-work" });
    else if (alteration === "first-result") (changed.input.at(-1) as { output: string }).output = "Conflicting accepted result.";
    else changed.model = "chatgpt-web/gpt-5.6-sol-instant";
    const response = await f.send(changed);
    const rejected = await response.json() as { error: { code: string } };
    expect(response.status).toBe(409);
    expect(rejected.error.code).toBe(alteration === "model-scope" ? "continuity_configuration_conflict" : "continuity_source_unproven");
    expect(store.get(thread)).toEqual(before);
    expect(f.submissions).toHaveLength(1);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.pages.size).toBe(0);
  }
}, 30_000);

test("repair4: HTTP public uncommitted compaction retry keeps its original target and deadline and commits the actual tail once", async () => {
  const f = httpFixture();
  f.body.model = "chatgpt-web/gpt-6-sol-instant";
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const callId = first.output.find(item => item.type === "function_call")!.call_id as string;
  const head = "SYNTHETIC_PUBLIC_COMPACT_HEAD_1042";
  const tail = "SYNTHETIC_PUBLIC_COMPACT_TAIL_971E";
  const log = `${head}\n` + "Original issued tool line for public compaction.\n".repeat(50_000) + tail;
  const result = { type: "function_call_output", call_id: callId, output: log };
  const sourceInput = [...f.body.input, ...codexRoundtrippedOutput(first.output), result];
  const failedSource = await f.send({ ...f.body, input: sourceInput });
  expect((await failedSource.json()).error.code).toBe("continuity_session_lost");
  f.controls.invokeSourceTools = false;
  const compactBody = { ...f.body, input: [...sourceInput, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" } }) } };
  const encodedBody = JSON.stringify(compactBody);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  let compactStarts = 0;
  let headBody = "", tailBody = "";
  let preCommit: ReturnType<ContinuityRecoveryStore["get"]>;
  f.automatic.mockImplementation(async turn => {
    compactStarts++;
    expect(turn.compaction).toBe(true);
    expect(turn.capabilities.localToolsEnabled).toBe(false);
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "c".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.text).not.toContain(tail);
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const entry = JSON.parse(compiled.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.compaction_token, contract: "native", credentialKind: "compaction", contextProtocol: 2,
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.compaction_token,
        contract: "native", credentialKind: "compaction", contextProtocol: 2, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const marker = compactStarts === 1 ? head : tail;
    const found = (await query("search", { query: marker })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    const body = parseContextTextReadResult(read).body;
    expect(body).toContain(marker);
    if (compactStarts === 1) {
      headBody = body;
      expect(body).not.toContain(tail);
      f.pages.delete(turn.conversationKey!);
      throw continuityError("continuity_session_lost", "Synthetic compaction page fault after the confirmed head return.");
    }
    tailBody = body;
    preCommit = store.get(thread)!;
    expect(Object.values(preCommit.checkpoints)).toHaveLength(0);
    const token = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
    const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
    await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "submit_compaction_handoff", token, handoffId,
      summary: `Checkpoint from the actual read: ${body.slice(body.indexOf(tail))}` });
    await new Promise<void>(resolve => {
      if (turn.abortSignal?.aborted) resolve(); else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    f.pages.get(turn.conversationKey!)!.state = "ready";
    return "Compaction handoff physically settled.";
  });
  const firstCompact = await f.send(compactBody);
  const failed = await firstCompact.json() as { status: string };
  expect(failed.status).toBe("failed");
  expect(headBody).toContain(head);
  expect(headBody).not.toContain(tail);
  const beforeRetry = store.get(thread)!;
  expect(Object.values(beforeRetry.checkpoints)).toHaveLength(0);
  const work = Object.values(beforeRetry.works).find(value => value.purpose === "compaction")!;
  expect(work.retryBudget!.deadlineAt).toBeGreaterThan(work.retryBudget!.startedAt);
  expect(JSON.stringify(compactBody)).toBe(encodedBody);
  const retry = await f.send(compactBody);
  expect(retry.status).toBe(200);
  const completed = await retry.json() as { status: string; output: Array<{ content?: Array<{ text?: string }> }> };
  expect(completed.status).toBe("completed");
  expect(completed.output.flatMap(item => item.content ?? []).map(part => part.text ?? "").join("")).toContain(tail);
  expect(tailBody).toContain(tail);
  const active = preCommit!.works[work.logicalWorkId]!;
  expect(active.state).toBe("active");
  expect(active.compactionTargetId).toBe(work.compactionTargetId);
  expect(active.acceptedTaskRevision).toBe(work.acceptedTaskRevision);
  expect(active.retryBudget!.startedAt).toBe(work.retryBudget!.startedAt);
  expect(active.retryBudget!.deadlineAt).toBe(work.retryBudget!.deadlineAt);
  expect(active.retryBudget!.attempts).toBe(work.retryBudget!.attempts + 1);
  const after = store.get(thread)!;
  const final = after.works[work.logicalWorkId]!;
  expect(final.state).toBe("completed");
  expect(final.retryBudget).toBeUndefined();
  expect(final.attempts.at(-1)!.attempt).toBe(active.attempts.at(-1)!.attempt);
  expect(final.attempts.at(-1)!.epoch).toBe(active.attempts.at(-1)!.epoch);
  const checkpoints = Object.values(after.checkpoints);
  expect(checkpoints).toHaveLength(1);
  expect(final.terminalReceiptId).toBe(checkpoints[0]!.commitId);
  expect(checkpoints[0]!.coveredCallIds).toEqual([callId]);
  expect(after.calls[callId]!.firstResultDigest).toBe(recoveryResultDigest(result));
  expect(Object.keys(after.calls)).toEqual([callId]);
  expect(compactStarts).toBe(2);
  expect(f.controls.toolResults).toHaveLength(1);
  const replay = await f.send(compactBody);
  expect(replay.status).toBe(200);
  expect((await replay.json()).status).toBe("completed");
  expect(compactStarts).toBe(2);
  expect(Object.values(store.get(thread)!.checkpoints)).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
}, 30_000);

async function verifiedManualHttpFixture(taskUpdates = false) {
  const f = fixture(true, { taskUpdates });
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const,
    browserInteractionMode: "manual" as const, appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME, solAvailable: false, toolAuthorityMode: "delegated" as const,
    browserHostDescriptorPath: f.descriptorPath, brokerSocketPath: f.provider.chatgptWeb!.brokerSocketPath!,
    runtimeCommand: [process.execPath, resolve("src/cli.ts")], zeroRiskRequireSentConfirmation: true };
  config.manualTunnel = { binaryPath: "/fixed/local-verification-client", tunnelId: `tunnel_${"a".repeat(32)}`,
    runtimeKeyFile: "/private/local-test-key", profileDir: join(f.root, "manual"), profileName: "manual", alias: "manual" };
  config.tunnel = config.manualTunnel;
  f.provider.chatgptWeb!.threadEnvironmentStatePath = join(f.root, "runtime", "thread-environments.json");
  writeFileSync(join(f.root, "config.json"), JSON.stringify(config));
  await f.broker.listen();
  const client = new Client({ name: "ended-manual-profile-verification", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", config.brokerSocketPath], stderr: "pipe" }));
  let prompt = "";
  try {
    const evidence = await runContextCapabilityVerification(config, { home: f.root, broker: f.broker, timeoutMs: 10_000,
      manualControl: {
        async start(_descriptor, activity) { prompt = activity.prompt; return { tabId: "local-verification", reused: false,
          deadlineAt: null, state: "awaiting-user", sentConfirmationRequired: true }; },
        async waitSent() {
          const start = /First call codex_turn_start with (\{.*?\})\./.exec(prompt)!;
          expect((await client.callTool({ name: "codex_turn_start", arguments: JSON.parse(start[1]!) })).isError).not.toBe(true);
          return { sentAt: new Date().toISOString() };
        },
        async started() {
          for (const line of prompt.split("\n").filter(line => line.startsWith("Call "))) {
            const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(line)!;
            expect((await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) })).isError).not.toBe(true);
          }
        },
        waitTerminal(_descriptor, _owner, options) { return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new Error("Local verification scope closed")), { once: true });
        }); },
        async end() { return { cancelledByUser: false }; },
      } });
    expect(evidence.receipts.ordinary.text_read).toBeDefined();
    expect(evidence.receipts.compaction.text_read).toBeDefined();
  } finally { await client.close(); }
  const body = { ...(f.request()._rawBody as Record<string, unknown>), model: "chatgpt-web/zero-risk", stream: false,
    input: (f.request()._rawBody as { input: unknown[] }).input };
  const send = (value: unknown, compact = false) => {
    const request = new Request(`http://127.0.0.1/v1/responses${compact ? "/compact" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const factory = () => createVerifiedChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: f.manualControl });
    return compact ? compactRequest(request, config, factory) : responseRequest(request, config, factory);
  };
  return { ...f, config, body, send };
}

test("public ended ZeroRisk compact waits for a new manual Sent and keeps the ordinary final", async () => {
  const f = await verifiedManualHttpFixture();
  const ordinary = await f.send(f.body);
  expect(ordinary.status).toBe(200);
  const originalAnswer = await ordinary.json();
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const source = Object.values(store.get(thread)!.works).find(work => work.purpose === "ordinary")!;
  let releaseSent!: () => void;
  const sent = new Promise<void>(resolveSent => { releaseSent = resolveSent; });
  const originalWaitSent = f.manualControl.waitSent;
  f.manualControl.waitSent = async (...args) => { await sent; return originalWaitSent(...args); };
  f.controls.started = false;
  const pending = f.send(f.body, true);
  let concurrent: Promise<Response> | undefined;
  let settled = false; void pending.finally(() => { settled = true; });
  for (let i = 0; i < 500 && f.submissions.length < 2 && !settled; i++) await Bun.sleep(2);
  try {
    expect(settled).toBe(false);
    expect(f.submissions).toHaveLength(2);
    expect(f.controls.started).toBe(false);
    const before = store.get(thread)!;
    const work = Object.values(before.works).find(work => work.purpose === "compaction")!;
    expect(work).toBeDefined();
    expect(work.attempts).toHaveLength(1);
    expect(work.attempts[0]!.stage).toBe("send-possible");
    expect(work.logicalWorkId).not.toBe(source.logicalWorkId);
    expect(before.works[source.logicalWorkId]!.terminalReceiptId).toBe(source.terminalReceiptId);
    expect(Object.values(before.checkpoints)).toHaveLength(0);
    expect(f.controls.toolResults).toHaveLength(0);
    expect(f.submissions[1]!.prompt).toContain("codex_context_read");
    expect(f.submissions[1]!.prompt).toContain("Stop business work");
    expect(f.submissions[1]!.claim.expected).toBeUndefined();
    expect(f.submissions[1]!.claim.recovery!.logicalWorkId).toBe(work.logicalWorkId);
    concurrent = f.send(f.body, true);
    await Bun.sleep(10);
    expect(f.submissions).toHaveLength(2);
    const attached = store.get(thread)!.works[work.logicalWorkId]!;
    expect(attached.attempts).toEqual(work.attempts);
    expect(attached.retryBudget).toEqual(work.retryBudget);
  } finally { releaseSent(); }
  const compact = await pending;
  expect(compact.status).toBe(200);
  const compactAnswer = await compact.json();
  expect((await concurrent!).status).toBe(200);
  expect(compactAnswer.output.at(-1)).toMatchObject({ type: "message", role: "user" });
  expect(compactAnswer.output.at(-1).content[0].text).toStartWith(SUMMARY_PREFIX);
  const after = store.get(thread)!;
  expect(Object.values(after.checkpoints)).toHaveLength(1);
  expect(after.works[source.logicalWorkId]!.terminalReceiptId).toBe(source.terminalReceiptId);
  expect(after.works[source.logicalWorkId]!.terminalDigest).toBe(source.terminalDigest);
  expect((await f.send(f.body)).status).toBe(200);
  const ordinaryReplay = await (await f.send(f.body)).json();
  const outputWithoutIds = (output: Array<Record<string, unknown>>) => output.map(({ id: _id, ...item }) => item);
  expect(outputWithoutIds(ordinaryReplay.output)).toEqual(outputWithoutIds(originalAnswer.output));
  expect(await (await f.send(f.body, true)).json()).toMatchObject({ output: compactAnswer.output });
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.toolResults).toHaveLength(0);
}, 30_000);

for (const format of ["local", "v2"] as const) test(`public ended ZeroRisk ${format} compact reads its accepted tool source without issuing business work`, async () => {
  const f = await verifiedManualHttpFixture(format === "local");
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const opening = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = opening.output.find(item => item.type === "function_call")!;
  expect(call).toBeDefined();
  const tail = "MANUAL_COMPACTION_SOURCE_TAIL_59B7";
  const result = { type: "function_call_output", call_id: call.call_id, output: "Accepted source record.\n".repeat(4_000) + tail };
  const acceptedBody = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(opening.output), result] };
  const ordinaryFinal = await (await f.send(acceptedBody)).json();
  expect(ordinaryFinal.status).toBe("completed");
  expect(f.controls.toolResults).toHaveLength(1);
  f.controls.invokeSourceTools = false;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const original = store.get(thread)!, source = original.works[original.currentWorkId!]!;
  const compactBody = format === "local" ? { ...acceptedBody, input: [...acceptedBody.input,
    { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
      request_kind: "compaction", compaction: { implementation: "responses", phase: "standalone_turn", strategy: "memento" } }) } }
    : { ...acceptedBody, input: [...acceptedBody.input, { type: "compaction_trigger" }] };
  const client = new Client({ name: "ended-manual-source-reader", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
  let successfulReads = 0;
  let readStep = "awaiting start";
  f.manualControl.markStarted = async () => {
    readStep = "list";
    const prompt = f.submissions.at(-1)!.prompt;
    const sourceInstruction = (taskEnvelope(prompt) as { messages: Array<{ content: string }> }).messages[0]!.content;
    const entry = JSON.parse(/<codex_context_navigation_json>\n([^\n]+)/.exec(sourceInstruction)![1]!);
    expect((await client.callTool(entry.first_call)).isError).not.toBe(true);
    readStep = "search";
    const credential = { compaction_token: entry.first_call.arguments.compaction_token, context_id: entry.context_id };
    const search = await client.callTool({ name: "codex_context_search", arguments: { ...credential, query: tail } });
    expect(search.isError).not.toBe(true);
    readStep = "read";
    const match = (search.structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> }).hits[0]!;
    const read = await client.callTool({ name: "codex_context_read", arguments: { ...credential,
      read_ref: match.read_ref, cursor: match.read_cursor } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.content)).toContain(tail); successfulReads++;
    readStep = "complete";
    expect((await client.callTool({ name: "codex_turn_complete", arguments: { request_id: f.controls.safeToken,
      task_revision: 0, final_answer: `Checkpoint preserves accepted source ${tail}.` } })).isError).not.toBe(true);
    readStep = "completed";
  };
  try {
    const response = await f.send(compactBody);
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.status, JSON.stringify({ error: body.error, readStep })).toBe("completed");
    expect(successfulReads).toBe(1);
    const after = store.get(thread)!;
    const checkpoint = Object.values(after.checkpoints)[0]!;
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    expect(checkpoint.coveredCallIds).toEqual([call.call_id as string]);
    expect(checkpoint.ordinaryFinalReceiptId).toBe(source.terminalReceiptId);
    expect(checkpoint.acceptedTaskRevision).toBe(source.acceptedTaskRevision);
    expect(after.works[source.logicalWorkId]!.taskUpdateJournal).toEqual(source.taskUpdateJournal);
    expect(after.calls[String(call.call_id)]!.firstResultDigest).toBe(recoveryResultDigest(result));
    expect(after.calls).toEqual(original.calls);
    expect(after.works[source.logicalWorkId]!.terminalDigest).toBe(source.terminalDigest);
    const replay = await (await f.send(compactBody)).json();
    expect(replay.status).toBe("completed"); expect(successfulReads).toBe(1);
    expect(f.submissions).toHaveLength(2); expect(f.controls.toolResults).toHaveLength(1);
  } finally { await client.close(); }
}, 30_000);

test("public ended ZeroRisk compact keeps its target and deadline across a known unsent acquisition retry", async () => {
  const f = await verifiedManualHttpFixture();
  expect((await f.send(f.body)).status).toBe(200);
  f.controls.preLeaseFailures = 1;
  const rejected = await f.send(f.body, true);
  expect(rejected.status).not.toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!, work = Object.values(before.works).find(value => value.purpose === "compaction")!;
  expect(work.attempts).toHaveLength(1);
  expect(work.attempts[0]).toMatchObject({ stage: "prepared", writerRetired: false, acquisitionEvidence: { status: "not-acquired" } });
  expect(Object.values(before.checkpoints)).toHaveLength(0);
  let release!: () => void; const sent = new Promise<void>(resolveSent => { release = resolveSent; });
  const waitSent = f.manualControl.waitSent;
  f.manualControl.waitSent = async (...args) => { await sent; return waitSent(...args); };
  const pending = f.send(f.body, true);
  for (let i = 0; i < 500 && f.submissions.length < 2; i++) await Bun.sleep(2);
  try {
    const retry = store.get(thread)!.works[work.logicalWorkId]!;
    expect(retry.attempts).toHaveLength(1);
    expect(retry.compactionTargetId).toBe(work.compactionTargetId);
    expect(retry.retryBudget).toEqual(work.retryBudget);
    expect(retry.attempts[0]!.snapshotDigest).toBe(work.attempts[0]!.snapshotDigest);
    expect(retry.attempts[0]!.transactionId).toBe(work.attempts[0]!.transactionId);
    expect(retry.attempts[0]!.snapshotVersion).toBe(work.attempts[0]!.snapshotVersion);
    expect(Object.keys(store.get(thread)!.compactionTargets)).toEqual(Object.keys(before.compactionTargets));
  } finally { release(); }
  expect((await pending).status).toBe(200);
  expect(Object.values(store.get(thread)!.checkpoints)).toHaveLength(1);
  expect(f.submissions).toHaveLength(2);
}, 30_000);

for (const boundary of ["unknown-send", "stopped", "changed-source", "missing-verification"] as const) test(`public ended ZeroRisk compact rejects ${boundary} before a successor can send`, async () => {
  const f = await verifiedManualHttpFixture();
  expect((await f.send(f.body)).status).toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  let compactBody: unknown = f.body;
  if (boundary === "unknown-send") {
    f.controls.unknownPreLeaseFailures = 1;
    expect((await f.send(f.body, true)).status).not.toBe(200);
  } else if (boundary === "stopped") {
    f.controls.preLeaseFailures = 1;
    expect((await f.send(f.body, true)).status).not.toBe(200);
    const current = store.get(thread)!;
    store.stopWork(thread, { scope: current.scope }, current.currentWorkId!, "user-stop");
  } else if (boundary === "changed-source") {
    compactBody = { ...f.body, input: [{ ...f.body.input[0] as Record<string, unknown>, content: "Conflicting current source instruction." }] };
  } else rmSync(configuration.getContextCapabilityEvidencePath(f.root));
  const before = store.get(thread)!;
  const response = await f.send(compactBody, true), body = await response.json();
  expect(response.status).not.toBe(200);
  expect(body.error.code).toBe(boundary === "unknown-send" ? "continuity_execution_unsettled"
    : boundary === "stopped" ? "continuity_stopped" : boundary === "changed-source" ? "continuity_source_unproven" : "upstream_server_error");
  if (boundary === "missing-verification") expect(body.error.message).toContain("not verified");
  const after = store.get(thread)!;
  expect(Object.values(after.checkpoints)).toHaveLength(0);
  expect(Object.values(after.works).filter(work => work.purpose === "compaction").map(work => work.attempts.length))
    .toEqual(Object.values(before.works).filter(work => work.purpose === "compaction").map(work => work.attempts.length));
  expect(f.submissions).toHaveLength(1); expect(f.controls.toolResults).toHaveLength(0);
}, 30_000);

async function firstLossNativeCompactionFixture() {
  const f = httpFixture(false, true);
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  const opening = await (await f.send(f.body)).json() as {
    status: string; end_turn: boolean; output: Array<Record<string, unknown>>;
  };
  expect(opening.status).toBe("completed");
  expect(opening.end_turn).toBe(false);
  const call = opening.output.find(item => item.type === "function_call")!;
  expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id,
    output: "The actual outer return of the issued fixture gate." };
  const metadata = JSON.parse((f.body.client_metadata as Record<string, string>)["x-codex-turn-metadata"]!);
  const compactBody = { ...structuredClone(f.body),
    client_metadata: { ...f.body.client_metadata as Record<string, string>,
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "compaction",
        compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" } }) },
    input: [...structuredClone(f.body.input), ...codexRoundtrippedOutput(opening.output), result,
      { type: "message", role: "user", content: COMPACT_PROMPT }],
  };
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const store = bindings.recoveryStore, before = store.get(thread)!;
  expect(binding.state).toBe("running");
  expect(before.calls[String(call.call_id)]).toMatchObject({ state: "delivery-possible" });
  expect(before.calls[String(call.call_id)]!.firstResultDigest).toBeUndefined();
  expect(before.works[before.currentWorkId!]!.attempts.at(-1)).toMatchObject({ stage: "accepted", writerRetired: false });
  return { ...f, compactBody, call, result, bindings, thread, binding, store, before };
}

for (const boundary of ["healthy", "lost"] as const) test(`repair12: overlapping ${boundary} preview replays the same completed compaction`, async () => {
  const f = await firstLossNativeCompactionFixture();
  const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  let entered!: () => void, release!: () => void;
  const previewEntered = new Promise<void>(resolve => { entered = resolve; });
  const heldPreview = new Promise<void>(resolve => { release = resolve; });
  let previews = 0;
  source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (++previews === 1) { entered(); await heldPreview; }
  };
  const pending = f.send(f.compactBody);
  try {
    expect(await Promise.race([previewEntered.then(() => true), pending.then(() => false)])).toBe(true);
    if (boundary === "lost") {
      f.pages.clear();
      expect(recoveryRuntime.settleRecoveryFailure(f.binding.recovery!)).toBe(true);
      f.bindings.lose(f.binding, f.binding.executionKey);
    }
    const completed = await f.send(structuredClone(f.compactBody));
    const completedBody = await completed.json() as any;
    expect(completed.status, JSON.stringify(completedBody.error)).toBe(200);
    expect(completedBody.status).toBe("completed");
    const committed = f.store.get(f.thread)!;
    expect(Object.values(committed.checkpoints)).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
    release();
    const observer = await pending, observerBody = await observer.json() as any;
    expect(f.store.get(f.thread)).toEqual(committed);
    expect(f.submissions).toHaveLength(2);
    expect(observer.status, JSON.stringify(observerBody.error)).toBe(200);
    expect(observerBody.status).toBe("completed");
    const finalContent = (body: any) => body.output.filter((item: any) => item.phase === "final_answer").map((item: any) => item.content);
    expect(finalContent(observerBody)).toHaveLength(1);
    expect(finalContent(observerBody)).toEqual(finalContent(completedBody));
  } finally { release(); await pending; source.runtime.syncContextUsage = sync; }
}, 30_000);

for (const loss of ["before-preview", "during-preview", "after-usage-wait"] as const) test(`repair12: native compaction recovers the same source lost ${loss}`, async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  let losses = 0;
  const lose = () => {
    losses++;
    expect(recoveryRuntime.settleRecoveryFailure(f.binding.recovery!)).toBe(true);
    f.bindings.lose(f.binding, f.binding.executionKey);
  };
  if (loss === "before-preview") lose();
  else source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (loss === "after-usage-wait") queueMicrotask(() => queueMicrotask(lose));
    else lose();
  };
  try {
    const response = await f.send(f.compactBody), body = await response.json() as any;
    expect(response.status, JSON.stringify(body.error)).toBe(200);
    expect(body.status).toBe("completed");
    const after = f.store.get(f.thread)!;
    expect(losses).toBe(1);
    expect(Object.values(after.compactionTargets)).toHaveLength(1);
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    const compaction = Object.values(after.works).filter(work => work.purpose === "compaction");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]!.attempts).toHaveLength(1);
    expect(after.calls[String(f.call.call_id)]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(f.result) });
    expect(f.submissions).toHaveLength(2);
    const replay = await f.send(f.compactBody);
    expect(replay.status).toBe(200);
    expect(f.submissions).toHaveLength(2);
    expect(Object.values(f.store.get(f.thread)!.checkpoints)).toHaveLength(1);
  } finally { source.runtime.syncContextUsage = sync; }
}, 30000);

for (const changed of ["stopped", "lease", "source", "durable-owner", "attempt", "binding", "new-work", "missing-recovery"] as const) {
  test(`repair12: a preview interrupted by ${changed} cannot retire or replace that execution`, async () => {
    const f = await firstLossNativeCompactionFixture();
    f.pages.clear();
    const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
    const sync = source.runtime.syncContextUsage;
    if (changed === "missing-recovery") delete f.binding.lease!.recovery;
    let changedRecord: ReturnType<typeof f.store.get>;
    source.runtime.syncContextUsage = async () => {
      await sync?.call(source.runtime);
      if (changed === "stopped") f.store.stopWork(f.thread, { scope: f.before.scope }, f.before.currentWorkId!, "user-stop");
      if (changed === "lease") f.binding.lease = { ...f.binding.lease!, traceId: "competing-physical-owner" };
      if (changed === "source") f.binding.executionKey = "competing-logical-source";
      if (changed === "durable-owner") f.store.transact(f.thread, { scope: f.before.scope }, record => {
        record.owner = { ...record.owner, id: recoveryDigest("competing-runtime-owner") };
      });
      if (changed === "new-work") {
        const previous = f.before.works[f.before.currentWorkId!]!;
        const journal = previous.taskUpdateJournal;
        const revision = (journal?.acceptedRevision ?? 0) + 1;
        const task = { id: "preview-new-work", content: "A newer accepted instruction." };
        recordRecoveryAppend(f.binding.recovery!, { logicalWorkId: recoveryDigest(task.id), instructionIdentity: task.id,
          nativeTurnId: previous.nativeTurnId!, workPayloadDigest: recoveryDigest(task), snapshotDigest: recoveryDigest(task.content),
          localSessionId: "preview-append-session", localTaskRevision: revision,
          results: [{ callId: String(f.call.call_id), resultType: f.result.type, resultDigest: recoveryResultDigest(f.result) }] },
          journal ? [{ revision, sourceMessageId: task.id, content: task.content, payloadDigest: recoveryDigest(task.content) }] : undefined,
          journal ? journal.driverGeneration + 1 : undefined);
      }
      if (changed === "attempt" || changed === "binding") {
        recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
        let record = f.store.get(f.thread)!;
        const work = record.works[record.currentWorkId!]!;
        record = f.store.retireAttempt(f.thread, { scope: record.scope, expectedVersion: record.version }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
        record = f.store.reserveRecovery(f.thread, { scope: record.scope, expectedVersion: record.version }, {
          logicalWorkId: work.logicalWorkId, owner: record.owner, snapshotDigest: work.attempts.at(-1)!.snapshotDigest });
        if (changed === "binding") f.bindings.installRecovered(record, f.binding.executionKey!, continuityDigest(""), "turn-first");
      } else f.bindings.lose(f.binding, f.binding.executionKey);
      changedRecord = f.store.get(f.thread);
    };
    try {
      const response = await f.send(f.compactBody), body = await response.json() as any;
      expect(changedRecord).toBeDefined();
      expect(response.status).toBe(409);
      expect(body.error.code).toBe(changed === "stopped" ? "continuity_stopped" : "continuity_source_unproven");
      expect(f.store.get(f.thread)).toEqual(changedRecord!);
      expect(f.submissions).toHaveLength(1);
      expect(Object.values(changedRecord!.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
      expect(Object.values(changedRecord!.checkpoints)).toHaveLength(0);
    } finally { source.runtime.syncContextUsage = sync; }
  }, 30000);
}

test("repair9: the first public native memento after exact page loss settles its outer result and commits once", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear(); // The old worker still owns a running binding and waits for the actual outer result.
  const response = await f.send(f.compactBody), envelope = await response.json();
  const after = f.store.get(f.thread)!;
  console.log(JSON.stringify({ case: "repair9-first-native-memento", httpStatus: response.status,
    outcome: envelope.status ?? "rejected", code: envelope.error?.code,
    fixtureBrowserRuns: f.submissions.length, targets: Object.keys(after.compactionTargets).length,
    compactionWorks: Object.values(after.works).filter(work => work.purpose === "compaction").length,
    checkpoints: Object.keys(after.checkpoints).length }));
  expect(response.status).toBe(200);
  expect(envelope.status).toBe("completed");
  const finals = envelope.output.filter((item: { type: string; phase?: string }) => item.type === "message" && item.phase === "final_answer");
  expect(finals).toHaveLength(1);
  expect(finals[0]).toMatchObject({ type: "message", role: "assistant" });
  expect(finals[0].content[0].text).toContain(f.controls.handoffSummary);
  const structurePath = join(f.root, "checkpoint-response-structure.json");
  const checkpointResponse = actualCheckpoint(observeCheckpointResponse(envelope, structure => {
    writeFileSync(structurePath, JSON.stringify(structure));
  }));
  const structure = JSON.parse(readFileSync(structurePath, "utf8"));
  expect(structure.outputCount).toBe(envelope.output.length);
  expect(structure.items.find((item: { phase: string }) => item.phase === "final_answer").canonicalTextDigest)
    .toBe(Object.values(after.checkpoints)[0]!.summaryDigest);
  expect(readFileSync(structurePath, "utf8")).not.toContain(f.controls.handoffSummary);
  expect(readFileSync(structurePath, "utf8")).not.toContain(f.controls.sourceToken);
  expect(checkpointResponse.format).toBe("native-text");
  expect(checkpointResponse.summary).toBe(finals[0].content.map((part: { text: string }) => part.text).join(""));
  expect(Object.values(after.checkpoints)[0]!.summaryDigest).toBe(continuityDigest(checkpointResponse.summary));
  expect(after.calls[String(f.call.call_id)]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(f.result) });
  expect(Object.keys(after.calls)).toEqual(Object.keys(f.before.calls));
  const targets = Object.values(after.compactionTargets), checkpoints = Object.values(after.checkpoints);
  const compactions = Object.values(after.works).filter(work => work.purpose === "compaction");
  expect(targets).toHaveLength(1); expect(compactions).toHaveLength(1); expect(checkpoints).toHaveLength(1);
  expect(targets[0]).toMatchObject({ sourceLogicalWorkId: f.before.currentWorkId,
    sourceToolBatchHeadSequence: f.before.calls[String(f.call.call_id)]!.batchSequence,
    sourceHistoryRevision: f.before.historyRevision });
  expect(checkpoints[0]).toMatchObject({ compactionTargetId: targets[0]!.compactionTargetId,
    coveredCallIds: [f.call.call_id] });
  expect(compactions[0]).toMatchObject({ state: "completed", compactionTargetId: targets[0]!.compactionTargetId });
  expect(compactions[0]!.attempts).toHaveLength(1);
  expect(after.works[f.before.currentWorkId!]!.workPayloadDigest).toBe(f.before.works[f.before.currentWorkId!]!.workPayloadDigest);
  expect(after.works[f.before.currentWorkId!]!.taskUpdateJournal).toEqual(f.before.works[f.before.currentWorkId!]!.taskUpdateJournal);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.claim.expected).toBeUndefined();
  expect(f.automatic.mock.calls[1]![0]).toMatchObject({ compaction: true, nativeConnector: true,
    capabilities: { localToolsEnabled: false } });
  const replay = await (await f.send(f.compactBody)).json();
  const withoutIds = (items: Array<Record<string, unknown>>) => items.map(({ id: _id, ...item }) => item);
  expect(withoutIds(replay.output.filter((item: { phase?: string }) => item.phase === "final_answer"))).toEqual(withoutIds(finals));
  expect(f.store.get(f.thread)!.checkpoints).toEqual(after.checkpoints);
  expect(f.submissions).toHaveLength(2);
}, 30_000);

function firstLossInspection(f: ReturnType<typeof httpFixture>, observe: () => void | Promise<void>) {
  const fetch = globalThis.fetch;
  let observed = false;
  return spyOn(globalThis, "fetch").mockImplementation((async (...args: Parameters<typeof fetch>) => {
    if (!observed && String(args[0]) === `${f.descriptor.control.endpoint}/v1/turn/continuity`) {
      observed = true;
      await observe();
    }
    return fetch(...args);
  }) as typeof globalThis.fetch);
}

test("repair9: concurrent first-loss native memento requests share the original target, deadline and checkpoint", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolveEntered => { started = resolveEntered; });
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier; });
  const run = f.automatic.getMockImplementation()!;
  f.automatic.mockImplementation(async turn => {
    if (turn.nativeConnector) { started(); await barrier; }
    return run(turn);
  });
  const first = f.send(f.compactBody);
  const raced = await Promise.race([entered.then(() => true), first.then(() => false)]);
  expect(raced).toBe(true);
  const admitted = f.store.get(f.thread)!;
  const work = Object.values(admitted.works).find(value => value.purpose === "compaction")!;
  const target = Object.values(admitted.compactionTargets)[0]!;
  expect(work.attempts).toHaveLength(1);
  expect(work.retryBudget!.attempts).toBe(1);
  expect(work.retryBudget!.deadlineAt).toBeNumber();
  expect(work.retryBudget!.startedAt).toBeNumber();
  expect(work.retryBudget!.deadlineAt).toBeGreaterThan(work.retryBudget!.startedAt);
  let observedSecond!: () => void;
  const secondObserved = new Promise<void>(resolveObserved => { observedSecond = resolveObserved; });
  const get = ContinuityRecoveryStore.prototype.get;
  const observation = spyOn(ContinuityRecoveryStore.prototype, "get").mockImplementation(function (this: ContinuityRecoveryStore, thread) {
    const record = get.call(this, thread);
    if (thread === f.thread && record?.currentWorkId === work.logicalWorkId) observedSecond();
    return record;
  });
  const second = f.send(f.compactBody);
  try {
    expect(await Promise.race([secondObserved.then(() => true), second.then(() => false)])).toBe(true);
    const attached = f.store.get(f.thread)!;
    expect(attached.works[work.logicalWorkId]!.attempts).toEqual(work.attempts);
    expect(attached.works[work.logicalWorkId]!.retryBudget).toEqual(work.retryBudget);
    expect(Object.values(attached.compactionTargets)).toEqual([target]);
    expect(Object.values(attached.checkpoints)).toHaveLength(0);
    expect(f.submissions).toHaveLength(1);
  } finally { observation.mockRestore(); release(); }
  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(200); expect((await response.json()).status).toBe("completed");
  }
  const completed = f.store.get(f.thread)!;
  const { representationDigests, ...targetIdentity } = target;
  expect(Object.values(completed.compactionTargets)).toHaveLength(1);
  expect(Object.values(completed.compactionTargets)[0]).toMatchObject(targetIdentity);
  expect(Object.values(completed.compactionTargets)[0]!.representationDigests).toEqual(expect.arrayContaining(representationDigests));
  expect(Object.values(completed.checkpoints)).toHaveLength(1);
  expect(completed.works[work.logicalWorkId]!.attempts).toHaveLength(1);
  expect(completed.works[work.logicalWorkId]!.retryBudget).toBeUndefined();
  expect(f.submissions).toHaveLength(2);
}, 30_000);

for (const boundary of ["missing-result", "conflicting-result", "stopped", "abort", "unverified"] as const) {
  test(`repair9: first-loss public native compaction preserves the ${boundary} barrier`, async () => {
    const f = await firstLossNativeCompactionFixture();
    const controller = new AbortController();
    if (boundary === "missing-result") f.compactBody.input = f.compactBody.input.filter(item => item !== f.result);
    if (boundary === "conflicting-result") {
      recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
      f.result.output = "Conflicting outer return.";
    }
    if (boundary === "unverified") f.controls.inspectFailures = 1;
    f.pages.clear();
    const inspection = firstLossInspection(f, () => {
      if (boundary === "stopped") {
        const current = f.store.get(f.thread)!;
        f.store.stopWork(f.thread, { scope: current.scope }, current.currentWorkId!, "user-stop");
      }
      if (boundary === "abort") controller.abort();
    });
    try {
      const response = await f.send(f.compactBody, false, false, controller.signal), body = await response.json();
      expect(response.status).not.toBe(200);
      if (boundary !== "abort") expect(body.error.code).toBe(boundary === "missing-result"
        ? "continuity_source_unproven" : boundary === "conflicting-result" ? "continuity_result_conflict"
          : boundary === "stopped" ? "continuity_stopped" : "continuity_unverified");
      const after = f.store.get(f.thread)!;
      expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
      expect(Object.values(after.checkpoints)).toHaveLength(0);
      expect(after.epoch).toBe(f.before.epoch);
      expect(f.submissions).toHaveLength(1);
      if (boundary === "stopped") expect(after.works[f.before.currentWorkId!]!).toMatchObject({ state: "stopped", stopReason: "user-stop" });
      if (boundary === "conflicting-result") expect(after.calls[String(f.call.call_id)]!.firstResultDigest)
        .toBe(recoveryResultDigest({ ...f.result, output: "The actual outer return of the issued fixture gate." }));
    } finally { inspection.mockRestore(); }
  }, 30_000);
}

for (const replaceBinding of [true, false]) test(`repair9: an old physical inspection cannot retire a competing prepared attempt (bindingReplaced=${replaceBinding})`, async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  let replacement: ReturnType<typeof f.store.get>;
  const inspection = firstLossInspection(f, () => {
    recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
    let record = f.store.get(f.thread)!;
    const work = record.works[record.currentWorkId!]!;
    record = f.store.retireAttempt(f.thread, { scope: record.scope, expectedVersion: record.version }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
    record = f.store.reserveRecovery(f.thread, { scope: record.scope, expectedVersion: record.version }, {
      logicalWorkId: work.logicalWorkId, owner: record.owner, snapshotDigest: work.attempts.at(-1)!.snapshotDigest });
    if (replaceBinding) f.bindings.installRecovered(record, f.binding.executionKey!, continuityDigest(""), "turn-first");
    replacement = record;
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(response.status).toBe(409); expect(body.error.code).toBe("continuity_source_unproven");
    expect(f.store.get(f.thread)).toEqual(replacement!);
    if (replaceBinding) expect(f.bindings.observed(f.thread)).not.toBe(f.binding);
    else expect(f.bindings.observed(f.thread)).toBe(f.binding);
    expect(f.submissions).toHaveLength(1);
  } finally { inspection.mockRestore(); }
}, 30_000);

for (const changed of ["lease", "source", "durable-owner"] as const) test(`repair9: first-loss native compaction cannot use an inspection superseded by ${changed}`, async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  let observed: ReturnType<typeof f.store.get>;
  const inspection = firstLossInspection(f, () => {
    if (changed === "lease") f.binding.lease = { ...f.binding.lease!, traceId: "competing-physical-owner" };
    if (changed === "source") f.binding.executionKey = "competing-logical-source";
    if (changed === "durable-owner") f.store.transact(f.thread, { scope: f.before.scope }, record => {
      record.owner = { ...record.owner, id: recoveryDigest("competing-runtime-owner") };
    });
    observed = f.store.get(f.thread);
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(response.status).toBe(409); expect(body.error.code).toBe("continuity_source_unproven");
    const after = f.store.get(f.thread)!;
    expect(after).toEqual(observed!);
    expect(after.epoch).toBe(f.before.epoch);
    expect(after.works[f.before.currentWorkId!]!.attempts).toEqual(f.before.works[f.before.currentWorkId!]!.attempts);
    expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
    expect(Object.values(after.checkpoints)).toHaveLength(0);
    expect(f.submissions).toHaveLength(1);
  } finally { inspection.mockRestore(); }
}, 30_000);

test("repair9: an arbitrary thrown session_lost code cannot authorize cold native compaction", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const inspection = firstLossInspection(f, () => {
    throw Object.assign(new Error("Untrusted inspection failure"), { code: "continuity_session_lost" });
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(response.status).toBe(409); expect(body.error.code).toBe("continuity_session_lost");
    const after = f.store.get(f.thread)!;
    expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
    expect(Object.values(after.checkpoints)).toHaveLength(0);
    expect(after.epoch).toBe(f.before.epoch); expect(f.submissions).toHaveLength(1);
  } finally { inspection.mockRestore(); }
}, 30_000);

for (const advanceAttempt of [false, true]) test(`repair9: the exact loss write checks a real child update under its lock (advanceAttempt=${advanceAttempt})`, async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const localBefore = { state: f.binding.state, evidenceExpiresAt: f.binding.evidenceExpiresAt,
    lease: structuredClone(f.binding.lease) };
  const registrationBefore = f.bindings.registrations.get(f.thread);
  const transact = ContinuityRecoveryStore.prototype.transact;
  let childRecord: ReturnType<typeof f.store.get>, intercepted = false;
  const boundary = spyOn(ContinuityRecoveryStore.prototype, "transact").mockImplementation(function (this: ContinuityRecoveryStore, thread, guard, mutate) {
    if (!intercepted && thread === f.thread && guard.expectedOwner === f.binding.owner
      && guard.expectedEpoch === f.before.epoch) {
      intercepted = true;
      // The first request has finished its read-side checks. Another process now
      // commits immediately before the actual loss transaction acquires its lock.
      const script = `
        import { ContinuityRecoveryStore } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
        import { acceptRecoveryResults } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
        const store = new ContinuityRecoveryStore(${JSON.stringify(f.statePath)});
        const thread = ${JSON.stringify(f.thread)};
        acceptRecoveryResults(${JSON.stringify(f.binding.recovery)}, [${JSON.stringify(f.result)}]);
        let record = store.get(thread);
        if (${advanceAttempt}) {
          const work = record.works[record.currentWorkId];
          record = store.retireAttempt(thread, { scope: record.scope, expectedVersion: record.version },
            work.logicalWorkId, work.attempts.at(-1).attempt);
          record = store.reserveRecovery(thread, { scope: record.scope, expectedVersion: record.version }, {
            logicalWorkId: work.logicalWorkId, owner: record.owner,
            snapshotDigest: work.attempts.at(-1).snapshotDigest,
          });
        }
        console.log(JSON.stringify(record));
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      childRecord = JSON.parse(child.stdout.toString().trim());
      expect(childRecord!.version).toBeGreaterThan(f.before.version);
    }
    return transact.call(this, thread, guard, mutate);
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(intercepted).toBe(true);
    if (advanceAttempt) {
      expect(response.status).toBe(409);
      expect(body.error.code).toBe("continuity_source_unproven");
      expect(f.store.get(f.thread)).toEqual(childRecord!);
      expect(f.bindings.registrations.get(f.thread)).toEqual(registrationBefore);
      expect(f.bindings.observed(f.thread)).toBe(f.binding);
      expect({ state: f.binding.state, evidenceExpiresAt: f.binding.evidenceExpiresAt,
        lease: f.binding.lease }).toEqual(localBefore);
      expect(f.submissions).toHaveLength(1);
    } else {
      // A legitimate result write changes the journal version, not the writer
      // identity. It must not turn the exact identity guard into a version gate.
      expect(response.status).toBe(200); expect(body.status).toBe("completed");
      const after = f.store.get(f.thread)!;
      expect(Object.values(after.checkpoints)).toHaveLength(1);
      expect(after.calls[String(f.call.call_id)]!.firstResultDigest).toBe(recoveryResultDigest(f.result));
      expect(Object.keys(after.calls)).toEqual(Object.keys(f.before.calls));
      expect(f.submissions).toHaveLength(2);
    }
  } finally { boundary.mockRestore(); }
}, 30_000);

test("repair9: a lost lease without its original recovery identity cannot authorize cold compaction", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const { recovery: _recovery, ...legacyLease } = f.binding.lease!;
  f.binding.lease = legacyLease;
  let beforeLoss: ReturnType<typeof f.store.get>;
  const registration = f.bindings.registrations.get(f.thread);
  const inspection = firstLossInspection(f, () => { beforeLoss = f.store.get(f.thread); });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(response.status).toBe(409); expect(body.error.code).toBe("continuity_source_unproven");
    expect(beforeLoss).toBeDefined();
    expect(f.store.get(f.thread)).toEqual(beforeLoss!);
    expect(f.bindings.registrations.get(f.thread)).toEqual(registration);
    expect(f.bindings.observed(f.thread)).toBe(f.binding);
    expect(f.binding.state).toBe("running");
    expect(f.submissions).toHaveLength(1);
  } finally { inspection.mockRestore(); }
}, 30_000);

function repair11VerifiedAuthority(f: ReturnType<typeof httpFixture>) {
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  // Isolate the verified environment dependency, as the existing alias tests do.
  // The public request, compaction, durable journal and process exit remain real.
  const resolver = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolveWithRolloutPublicationRetry").mockImplementation(async parsed => ({
    cwd: "/tmp", roots: ["/tmp"], writableRoots: ["/tmp"],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: true },
    tools: structuredClone(parsed.context.tools ?? []),
  }));
  cleanups.push(async () => { resolver.mockRestore(); });
}

async function repair11CheckpointFixture(marker = false, options: { root?: string; threadId?: string; singleInstruction?: boolean; turnOnlyPrimary?: boolean } = {}) {
  const f = httpFixture(false, !options.turnOnlyPrimary, options);
  if (options.turnOnlyPrimary) repair11VerifiedAuthority(f);
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  const live = createLiveRequestBody({ case: "mcp-partial", bodies: [],
    expected: { fragments: [], priority: "", call_pairs: [] }, task: "Continue the exact accepted task." },
  { purpose: "ordinary", model: f.body.model, cwd: process.cwd(), threadId: f.threadId, turnId: "turn-1" });
  f.body.input = live.input;
  if (options.singleInstruction) f.body.input = f.body.input.filter((item: any) => item.id !== "msg_live_turn-1_1");
  if (options.turnOnlyPrimary) delete (f.body.input.find((item: any) => item.id === "msg_live_turn-1_2") as any).id;
  f.body.client_metadata = live.client_metadata;
  const openingResponse = await f.send(f.body);
  expect(openingResponse.status).toBe(200);
  const opening = await openingResponse.json() as any;
  const call = opening.output.find((item: any) => item.type === "function_call");
  expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id, output: "Original real return." };
  const sourceBody = { ...structuredClone(f.body), input: [...f.body.input, ...opening.output, result] };
  f.pages.clear();
  const handoffs: any[] = [];
  const restore = observeCompactionHandoff(f.broker, continuityDigest(f.threadId), event => handoffs.push(event));
  let compactResponse: Response;
  try { compactResponse = await f.send(compactionBody(sourceBody, COMPACT_PROMPT)); } finally { restore(); }
  const compact = await compactResponse.json() as any;
  expect(compactResponse.status, JSON.stringify(compact.error)).toBe(200);
  const { summary } = actualCheckpoint(compact);
  const store = continuityBindingsFor(f.statePath).recoveryStore, thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  expect(Object.keys(before.checkpoints)).toHaveLength(1);
  const checkpoint = Object.values(before.checkpoints)[0]!;
  expect(checkpoint.summaryDigest).toBe(continuityDigest(summary));
  expect(handoffs.map(event => event.stage)).toEqual(["arrived", "returned"]);
  expect(handoffs[1]).toMatchObject({ submitted: true, summaryDigest: continuityDigest(f.controls.handoffSummary),
    attempt: 0 });
  const continuation = marker ? { ...structuredClone(sourceBody), input: [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }, ...structuredClone(sourceBody.input)] }
    : checkpointContinuationBody(sourceBody, compact);
  f.controls.invokeSourceTools = false;
  return { ...f, store, thread, before, checkpoint, sourceBody, continuation, summary };
}

for (const marker of [false, true]) for (const lost of [true, false]) test(`repair11: accepted sibling instructions continue after checkpoint marker=${marker} lost=${lost}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  if (lost) f.pages.clear();
  const sends = f.submissions.length;
  const response = await f.send(f.continuation);
  const envelope = await response.json() as any;
  expect(response.status, JSON.stringify(envelope.error)).toBe(200);
  expect(envelope.status).toBe("completed");
  const after = f.store.get(f.thread)!;
  expect(f.submissions).toHaveLength(sends + 1);
  expect(Object.keys(after.checkpoints)).toHaveLength(1);
  expect(after.checkpoints[f.checkpoint.commitId]!.continuation.state).toBe("consumed");
  const consumer = after.works[after.checkpoints[f.checkpoint.commitId]!.continuation.consumerLogicalWorkId!]!;
  expect(consumer.state).toBe("completed");
  expect(consumer.workLineageId).toBe(f.before.works[f.checkpoint.sourceLogicalWorkId]!.workLineageId);
  expect(after.calls).toEqual(f.before.calls);
  const replay = await f.send(f.continuation);
  expect(replay.status).toBe(200);
  expect((await replay.json() as any).output.map(({ id, ...item }: any) => item))
    .toEqual(envelope.output.map(({ id, ...item }: any) => item));
  expect(f.submissions).toHaveLength(sends + 1);
  expect(f.store.get(f.thread)!.checkpoints).toEqual(after.checkpoints);
}, 30000);

for (const marker of [false, true]) {
  test(`repair11: checkpoint refuses changed source before execution marker=${marker}`, async () => {
    const f = await repair11CheckpointFixture(marker);
    f.pages.clear();
    // Every rejection must preserve this committed baseline, so the mutations can
    // share its expensive setup. Clone each request and check for state pollution.
    for (const mutation of ["payload", "identity", "role", "turn", "forged", "primary", "scope", "duplicate", "identity-role-payload", "removed"] as const) {
      const changed = structuredClone(f.continuation) as any;
      const sibling = changed.input.find((item: any) => item.id === "msg_live_turn-1_1");
      if (mutation === "payload") sibling.content = "A different instruction.";
      if (mutation === "identity") sibling.id = "forged-sibling-id";
      if (mutation === "role") sibling.role = "assistant";
      if (mutation === "turn") sibling.internal_chat_message_metadata_passthrough.turn_id = "different-turn";
      if (mutation === "forged") changed.input.splice(changed.input.indexOf(sibling), 0, { ...structuredClone(sibling), id: "new-before-old", content: "Injected older instruction." });
      if (mutation === "duplicate") changed.input.splice(changed.input.indexOf(sibling), 0, structuredClone(sibling));
      if (mutation === "removed") changed.input.splice(changed.input.indexOf(sibling), 1);
      if (mutation === "identity-role-payload") Object.assign(sibling, { id: "new-developer-id", role: "developer", content: "Changed developer directive." });
      if (mutation === "primary") changed.input.find((item: any) => item.id === "msg_live_turn-1_2").content = "Changed primary.";
      if (mutation === "scope") changed.reasoning = { effort: "high" };
      const before = f.store.get(f.thread)!, sends = f.submissions.length;
      const response = await f.send(changed);
      expect(response.status, mutation).toBe(409);
      expect(f.submissions, mutation).toHaveLength(sends);
      const after = f.store.get(f.thread)!;
      expect(after.checkpoints, mutation).toEqual(before.checkpoints);
      expect(after.calls, mutation).toEqual(before.calls);
      expect(Object.keys(after.works), mutation).toEqual(Object.keys(before.works));
      expect(after.currentWorkId, mutation).toBe(before.currentWorkId);
      expect(after, `durable baseline changed after ${mutation}`).toEqual(f.before);
    }
    const sends = f.submissions.length;
    const valid = await f.send(f.continuation);
    expect(valid.status).toBe(200);
    expect((await valid.json() as any).status).toBe("completed");
    expect(f.submissions).toHaveLength(sends + 1);
  }, 30000);
}

for (const marker of [false, true]) test(`repair11: older single-source checkpoint continues without inventing sibling proof marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker, { singleInstruction: true });
  // Reconstruct the pre-repair11 durable representation set. Keep its actual
  // source payload, primary representation, calls, summary and commit intact.
  const added = new Set([CONTINUITY_CHECKPOINT_SIBLING_PROOF, continuityCheckpointSiblingGroup([])]);
  const legacyPath = join(f.statePath, "recovery.json");
  const legacyDocument = JSON.parse(readFileSync(legacyPath, "utf8"));
  {
    const record = legacyDocument.threads[f.thread];
    record.compactionTargets[f.checkpoint.compactionTargetId]!.representationDigests =
      record.compactionTargets[f.checkpoint.compactionTargetId]!.representationDigests.filter((value: string) => !added.has(value));
    record.checkpoints[f.checkpoint.commitId]!.representationDigests =
      record.checkpoints[f.checkpoint.commitId]!.representationDigests.filter((value: string) => !added.has(value));
  }
  // Load an old-format fixture; a production transaction must never remove proof.
  writeFileSync(legacyPath, JSON.stringify(legacyDocument));
  f.pages.clear();
  const before = f.store.get(f.thread)!, sends = f.submissions.length;
  const forged = structuredClone(f.continuation) as any;
  const primary = forged.input.find((item: any) => item.id === "msg_live_turn-1_2");
  forged.input.splice(forged.input.indexOf(primary), 0, { ...structuredClone(primary), id: "unproven-old-sibling" });
  expect((await f.send(forged)).status).toBe(409);
  expect(f.submissions).toHaveLength(sends);
  expect(f.store.get(f.thread)).toEqual(before);
  const response = await f.send(f.continuation);
  expect(response.status).toBe(200);
  expect((await response.json() as any).status).toBe("completed");
  expect(f.submissions).toHaveLength(sends + 1);
  const after = f.store.get(f.thread)!;
  expect(after.calls).toEqual(before.calls);
  expect(after.checkpoints[f.checkpoint.commitId]!.representationDigests).toEqual(before.checkpoints[f.checkpoint.commitId]!.representationDigests);
  expect(after.checkpoints[f.checkpoint.commitId]!.continuation.state).toBe("consumed");
}, 30000);

for (const marker of [false, true]) test(`repair11: concurrent checkpoint observers share one consumer marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  f.pages.clear();
  f.controls.deferCompletion = true;
  const sends = f.submissions.length;
  const first = f.send(f.continuation);
  let retries = 0;
  while (!f.controls.releaseDeferredCompletion && retries++ < 200) await Bun.sleep(5);
  expect(f.controls.releaseDeferredCompletion).toBeDefined();
  const second = f.send(structuredClone(f.continuation));
  await Bun.sleep(20);
  f.controls.releaseDeferredCompletion!();
  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(200);
    expect((await response.json() as any).status).toBe("completed");
  }
  expect(f.submissions).toHaveLength(sends + 1);
  const after = f.store.get(f.thread)!;
  expect(Object.values(after.works).filter(work => work.purpose === "ordinary")).toHaveLength(2);
  expect(Object.values(after.checkpoints)).toHaveLength(1);
  expect(after.calls).toEqual(f.before.calls);
}, 30000);

for (const marker of [false, true]) test(`repair11: a new instruction after checkpoint remains new work marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  const first = await f.send(f.continuation);
  expect((await first.json() as any).status).toBe("completed");
  const before = f.store.get(f.thread)!;
  const body = structuredClone(f.continuation) as any;
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "new-turn" });
  body.input.push({ type: "message", role: "user", id: "new-after-checkpoint", content: "A new accepted task.",
    internal_chat_message_metadata_passthrough: { turn_id: "new-turn" } });
  f.pages.clear();
  const response = await f.send(body);
  expect(response.status).toBe(200);
  expect((await response.json() as any).status).toBe("completed");
  const after = f.store.get(f.thread)!;
  expect(after.works[after.currentWorkId!]!.instructionIdentity).toBe("new-after-checkpoint");
  expect(after.checkpoints).toEqual(before.checkpoints);
  expect(after.calls).toEqual(before.calls);
}, 30000);

for (const marker of [false, true]) test(`repair11: compaction retry cannot add a new sibling proof marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  const changed = structuredClone(f.sourceBody) as any;
  changed.input.find((item: any) => item.id === "msg_live_turn-1_1").id = "retry-forged-sibling";
  const before = f.store.get(f.thread)!, sends = f.submissions.length;
  const response = await f.send(compactionBody(changed, COMPACT_PROMPT));
  expect(response.status).toBe(409);
  expect(f.store.get(f.thread)!.compactionTargets).toEqual(before.compactionTargets);
  expect(f.store.get(f.thread)!.checkpoints).toEqual(before.checkpoints);
  expect(f.submissions).toHaveLength(sends);
}, 30000);

test("repair11: handoff observer preserves dispatch return identity, failures, bounds and restoration", async () => {
  const f = await repair11CheckpointFixture();
  const ref = { directory: f.statePath, thread: f.thread,
    logicalWorkId: `compaction:${f.checkpoint.compactionTargetId}`, attempt: 0 };
  const secret = "private-summary-and-error-text";
  const error = Object.assign(new Error(secret), { code: `continuity_${secret}` });
  for (const mode of ["sync", "promise", "throw", "reject"] as const) {
    const returned = { submitted: true };
    const promise = mode === "reject" ? Promise.reject(error) : Promise.resolve(returned);
    void promise.catch(() => {});
    let calls = 0;
    const receiver = {};
    const request = { method: "submit_compaction_handoff", token: "private-control-token", handoffId: "private-handoff-id", summary: secret };
    const original = function(this: unknown, ...args: unknown[]) {
      calls++; expect(this).toBe(receiver); expect(args[0]).toBe(request);
      if (mode === "throw") throw error;
      return mode === "sync" ? returned : promise;
    };
    const fake = { dispatch: original, compactionContextBindings: new Map([[request.token, { readToken: "read" }]]),
      compactionContexts: new Map([["read", { registration: { recovery: ref } }]]) };
    const events: any[] = [];
    const restore = observeCompactionHandoff(fake as unknown as TurnBroker, f.thread, event => events.push(event));
    try {
      if (mode === "throw") { try { fake.dispatch.call(receiver, request); throw new Error("Expected original error"); } catch (caught) { expect(caught).toBe(error); } }
      else {
        const actual = fake.dispatch.call(receiver, request);
        expect(actual).toBe(mode === "sync" ? returned : promise);
        if (mode !== "sync") await promise.catch(caught => { expect(caught).toBe(error); });
      }
      expect(calls).toBe(1);
      expect(events.map(event => event.stage)).toEqual(["arrived", mode === "throw" || mode === "reject" ? "rejected" : "returned"]);
      const encoded = JSON.stringify(events);
      for (const value of [secret, request.token, request.handoffId, error.code]) expect(encoded).not.toContain(value);
      if (mode === "throw" || mode === "reject") expect(events[1].code).toBeNull();
      for (let i = 0; i < 20; i++) { try { fake.dispatch.call(receiver, request); } catch {} }
      await Promise.resolve();
      expect(events.length).toBe(32);
    } finally { restore(); }
    expect(fake.dispatch).toBe(original);
    const restoreAgain = observeCompactionHandoff(fake as unknown as TurnBroker, f.thread, () => { throw new Error("Observer failed"); });
    const replacement = () => returned;
    fake.dispatch = replacement;
    restoreAgain();
    expect(fake.dispatch).toBe(replacement);
  }
}, 30000);

test.skipIf(!process.env.REPAIR11_CHECKPOINT_SEED_ROOT)("repair11 child checkpoint seed", async () => {
  const root = process.env.REPAIR11_CHECKPOINT_SEED_ROOT!;
  const f = await repair11CheckpointFixture(process.env.REPAIR11_CHECKPOINT_SEED_MARKER === "1", { root, threadId: "repair11-restarted-checkpoint",
    turnOnlyPrimary: process.env.REPAIR11_CHECKPOINT_SEED_TURN_ONLY === "1" });
  writeFileSync(join(root, "seed.json"), JSON.stringify({ continuation: f.continuation, checkpoint: f.checkpoint, before: f.before }));
}, 30000);

for (const marker of [false, true]) for (const turnOnly of [false, true]) test(`repair11: checkpoint sibling proofs survive an actual backend exit marker=${marker} turnOnly=${turnOnly}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "repair11-restarted-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const log = Bun.file(join(root, "child.log"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^repair11 child checkpoint seed$"], {
    env: { ...process.env, REPAIR11_CHECKPOINT_SEED_ROOT: root, REPAIR11_CHECKPOINT_SEED_MARKER: marker ? "1" : "0",
      REPAIR11_CHECKPOINT_SEED_TURN_ONLY: turnOnly ? "1" : "0" },
    stdout: log, stderr: log,
  });
  expect(await child.exited, await log.text()).toBe(0);
  const seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
  expect(continuityProcessInstanceStatus(seed.before.owner)).toBe("exited");
  const f = httpFixture(false, !turnOnly, { root, threadId: "repair11-restarted-checkpoint" });
  if (turnOnly) repair11VerifiedAuthority(f);
  expect(continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))).toBeUndefined();
  if (turnOnly) {
    for (const mutation of ["primary", "sibling"]) {
      const changed = structuredClone(seed.continuation);
      const item = mutation === "primary" ? changed.input.find((value: any) => value.role === "user" && !value.id
        && value.internal_chat_message_metadata_passthrough?.turn_id === "turn-1")
        : changed.input.find((value: any) => value.id === "msg_live_turn-1_1");
      if (mutation === "primary") item.content = "A different primary task.";
      else Object.assign(item, { id: "new-developer-id", role: "developer", content: "Changed developer directive." });
      expect((await f.send(changed)).status).toBe(409);
      expect(f.submissions).toHaveLength(0);
      expect(new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))).toEqual(seed.before);
    }
  }
  const response = await f.send(seed.continuation);
  const envelope = await response.json() as any;
  expect(response.status, JSON.stringify(envelope.error)).toBe(200);
  expect(envelope.status, JSON.stringify(envelope.error)).toBe("completed");
  const after = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(after.checkpoints[seed.checkpoint.commitId]!.continuation.state).toBe("consumed");
  expect(Object.values(after.checkpoints)).toHaveLength(1);
  expect(after.calls).toEqual(seed.before.calls);
  expect(f.submissions).toHaveLength(1);
}, 30000);

test("repair12: overlapping healthy preview attaches to its in-flight compaction", async () => {
  const f = fixture(); const first = f.request(); await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  const sync = source.runtime.syncContextUsage;
  const automatic = f.automatic.getMockImplementation()!;
  let enteredPreview!: () => void, releasePreview!: () => void, enteredSend!: () => void, releaseSend!: () => void;
  const preview = new Promise<void>(r => { enteredPreview = r; });
  const holdPreview = new Promise<void>(r => { releasePreview = r; });
  const send = new Promise<void>(r => { enteredSend = r; });
  const holdSend = new Promise<void>(r => { releaseSend = r; });
  let calls = 0;
  source.runtime.syncContextUsage = async () => { await sync?.call(source.runtime); if (++calls === 1) { enteredPreview(); await holdPreview; } };
  f.automatic.mockImplementation(async turn => {
    if (turn.nativeConnector) {
      const activated = turn.onSendActivated;
      turn.onSendActivated = async () => { await activated?.(); enteredSend(); await holdSend; };
    }
    return automatic(turn);
  });
  const pending = f.run(compact).catch(error => ({ diagnosticError: (error as { code?: string }).code ?? String(error) }));
  let second: Promise<AdapterEvent[] | { diagnosticError: string }> | undefined;
  try {
    expect(await Promise.race([preview.then(() => true), pending.then(() => false)])).toBe(true);
    second = f.run(structuredClone(compact)).catch(error => ({ diagnosticError: (error as { code?: string }).code ?? String(error) }));
    expect(await Promise.race([send.then(() => true), second.then(() => false)])).toBe(true);
    const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
    const inFlight = bindings.recoveryStore.get(thread)!;
    expect(Object.keys(inFlight.checkpoints)).toHaveLength(0);
    expect(inFlight.works[inFlight.currentWorkId!]!.purpose).toBe("compaction");
    releasePreview();
    const early = await Promise.race([pending.then(result => ({ settled: true, error: Array.isArray(result) ? null : result.diagnosticError })),
      Bun.sleep(100).then(() => ({ settled: false, error: null }))]);
    releaseSend();
    const [observer, owner] = await Promise.all([pending, second]);
    const after = bindings.recoveryStore.get(thread)!;
    expect(early.settled).toBe(false);
    expect(Object.keys(after.compactionTargets)).toHaveLength(1);
    expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(1);
    expect(Array.isArray(owner)).toBe(true);
    expect(f.submissions).toHaveLength(2);
    expect(Object.keys(after.checkpoints)).toHaveLength(1);
    expect(Array.isArray(observer), "An identical in-flight observer must attach to the existing healthy run.").toBe(true);
    if (Array.isArray(observer)) expect(observer.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { releasePreview(); releaseSend(); await Promise.all([pending, second]); source.runtime.syncContextUsage = sync; f.automatic.mockImplementation(automatic); }
}, 30000);


for (const manual of [false, true]) test(`completed replay: ${manual ? "Zero Risk" : "Automatic"} remote unfinished retirement preserves the submitted failure`, async () => {
  const f = fixture(manual);
  let started!: () => void, entered!: () => void, release!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const replying = new Promise<void>(resolve => { release = resolve; });
  f.controls.onStarted = started; f.controls.deferCompletion = true;
  const parsed = f.request(), original = f.adapter(), abort = new AbortController();
  await original.preflight!(parsed, { headers: new Headers() });
  const detached = original.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  await starting; abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const remote = new RemoteTurnBroker(f.broker.socketPath);
  const originalUpdate = remote.updateEnvironment.bind(remote);
  const update = spyOn(remote, "updateEnvironment").mockImplementation(async (...args) => {
    entered(); await replying; return originalUpdate(...args);
  });
  cleanups.push(async () => { release(); update.mockRestore(); });
  const adapter = createChatGptWebAdapter(f.provider, { broker: remote, zeroRiskManualControl: f.manualControl });
  const events: AdapterEvent[] = [];
  await adapter.preflight!(parsed, { headers: new Headers() });
  const reconnect = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event)).catch(error => error);
  await entering;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), record = store.get(thread)!;
  const work = record.works[record.currentWorkId!]!;
  expect(work.state).toBe("active");
  store.retireAttempt(thread, { scope: record.scope }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
  release();
  expect(await reconnect).toBeUndefined();
  expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "chatgpt_submitted_turn_failed", retryable: false });
  expect(events.some(event => event.type === "done")).toBe(false);
  expect(f.submissions).toHaveLength(1);
  expect(update).toHaveBeenCalledTimes(1);
});

for (const recovered of [false, true]) for (const boundary of ["same-work", "new-owner", "stale-observer", "broken-predecessor"] as const) test(`completed append reconnect across owner RPC: recovery=${recovered}, ${boundary}`, async () => {
  const f = fixture(false, { taskUpdates: true });
  if (recovered) {
    f.controls.failAfterSendOnce = true;
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
  }
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.pauseAfterToolResults = true;
  const initial = f.request();
  const opening = await f.run(initial);
  const call = opening.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  expect(call).toBeDefined();
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  expect(source.runtime.recoveryOrigin?.attempt).toBe(recovered ? 1 : 0);
  const text = "Keep the newly accepted review constraint.";
  const update = { revision: 1, sourceMessageId: "review-append-B", content: text, payloadDigest: recoveryDigest(text) };
  f.controls.acknowledgePendingUpdate = update;
  const next = f.request("", "turn-first", [
    ...(initial._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!),
    { type: "function_call_output", call_id: call!.id, output: "Exact result before the new instruction." },
    { type: "message", id: update.sourceMessageId, role: "user", content: text,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["user.text"] } },
  ]);
  const firstObserver = f.adapter(), abort = new AbortController();
  await firstObserver.preflight!(next, { headers: new Headers() });
  let observerEnded = false;
  const firstEvents: AdapterEvent[] = [];
  const firstRun = firstObserver.runTurn!(next, { headers: new Headers(), abortSignal: abort.signal }, event => firstEvents.push(event))
    .then(() => { observerEnded = true; }, error => { observerEnded = true; return error; });
  const until = async (condition: () => boolean, label: string) => {
    const end = Date.now() + 10_000;
    while (!condition() && Date.now() < end) await Bun.sleep(5);
    if (!condition()) throw new Error(`Probe did not reach ${label}; events=${JSON.stringify(firstEvents)}`);
  };
  let releaseInspection!: () => void, inspectionEntered!: () => void;
  const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
  f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
  let releaseRpc!: () => void, rpcEntered!: () => void, rpcRejected!: () => void;
  const rpcGate = new Promise<void>(resolve => { releaseRpc = resolve; });
  const entered = new Promise<void>(resolve => { rpcEntered = resolve; });
  const rejected = new Promise<void>(resolve => { rpcRejected = resolve; });
  const remote = new RemoteTurnBroker(f.broker.socketPath);
  const updateEnvironment = remote.updateEnvironment.bind(remote);
  const rpc = spyOn(remote, "updateEnvironment").mockImplementation(async (...args) => {
    rpcEntered(); await rpcGate;
    try { return await updateEnvironment(...args); }
    catch (error) { rpcRejected(); throw error; }
  });
  cleanups.push(async () => { releaseRpc(); releaseInspection(); rpc.mockRestore(); });
  try {
    await until(() => Boolean(f.controls.releaseAfterToolResults) || observerEnded, "accepted append tool settlement");
    if (observerEnded) throw new Error(`Append ended unexpectedly: ${JSON.stringify(await firstRun)} ${JSON.stringify(firstEvents)}`);
    expect(binding.recovery!.attempt).toBe(0);
    expect(binding.recovery!.logicalWorkId).not.toBe(source.runtime.recoveryOrigin!.logicalWorkId);
    abort.abort();
    expect(await firstRun).toMatchObject({ name: "AbortError" });
    const reconnectAdapter = createChatGptWebAdapter(f.provider, { broker: remote, zeroRiskManualControl: f.manualControl });
    await reconnectAdapter.preflight!(next, { headers: new Headers() });
    const events: AdapterEvent[] = [];
    const reconnect = reconnectAdapter.runTurn!(next, { headers: new Headers() }, event => events.push(event)).catch(error => error);
    await entered;
    f.controls.releaseAfterToolResults!();
    await inspected;
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    expect(record.works[record.currentWorkId!]!.state).toBe("completed");
    const ref = binding.recovery!, work = record.works[ref.logicalWorkId]!;
    const store = new ContinuityRecoveryStore(f.statePath);
    if (boundary === "new-owner") {
      store.transact(record.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
        draft.owner = { ...draft.owner, id: recoveryDigest("replacement-owner") };
      });
    } else if (boundary === "stale-observer") {
      // A later accepted route owns the binding, even if the old route remains in the session.
      binding.logicalExecutionKey = `${chatGptWebExecutionNamespace(f.provider)}:later-request`;
    } else if (boundary === "broken-predecessor") {
      // Matching revision and generation alone cannot prove the retained physical source.
      const get = ContinuityRecoveryStore.prototype.get;
      const read = spyOn(ContinuityRecoveryStore.prototype, "get").mockImplementation(function (this: ContinuityRecoveryStore, thread) {
        const observed = get.call(this, thread);
        if (observed?.works[ref.logicalWorkId]?.state === "completed") {
          delete observed.works[ref.logicalWorkId]!.predecessorLogicalWorkId;
        }
        return observed;
      });
      cleanups.push(async () => { read.mockRestore(); });
    }
    releaseRpc();
    await rejected;
    releaseInspection();
    const error = await reconnect;
    const originalOutcome = await source.browserOutcome;
    await source.physicalSettlement;
    expect(originalOutcome).toEqual({ type: "final", answer: "Stopped at the accepted tool boundary." });
    expect(work.terminalDigest).toBe(recoveryDigest(originalOutcome.type === "final" ? originalOutcome.answer : ""));
    if (boundary === "same-work") {
      expect(error).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
        .map(event => event.type === "text_delta" ? event.text : "").join("")).toBe(originalOutcome.type === "final" ? originalOutcome.answer : "");
    } else {
      expect(error).toMatchObject({ code: "continuity_source_unproven", status: 409 });
      expect(events.some(event => event.type === "done" || event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
    }
    expect(f.submissions).toHaveLength(recovered ? 2 : 1);
  } finally {
    releaseRpc(); releaseInspection(); abort.abort(); f.controls.releaseAfterToolResults?.();
    await firstRun;
  }
}, 30_000);
