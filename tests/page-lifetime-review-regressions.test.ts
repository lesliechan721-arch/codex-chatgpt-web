import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { createRequire } from "node:module";
import { evictOptionalRecoveryResults, recordRecoveryAppend, recoveryDigest, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as recoveryRuntime from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as continuityInput from "../src/adapters/chatgpt-web/continuity-input";
import { afterEach, expect, spyOn } from "bun:test";
import { performanceTest } from "../tests/helpers/performance-test";
import { measureRuntimeOperation, measureRuntimeAsync, runtimePerformanceContext, withRuntimePerformanceContext } from "../src/runtime-performance";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { $ } from "bun";
import { harmlessContinuityCommand } from "../tests/helpers/continuity-command";
import { controlledClock } from "../tests/helpers/controlled-clock";
import { retainedFixtureCleanup } from "../tests/helpers/retained-fixture-cleanup";
import { OPENAI_ACCESS } from "../src/api-access";
import { watch, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptToolTimeoutError } from "../src/adapters/chatgpt-web/adapter-error";
import { cancelStructuredCompactionNativeTurn, existingStructuredCompactionRun, forgetStructuredCompactionPage, registerStructuredCompactionPage, runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityClaim, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { cancelAbandonedContinuityCreation, leaveContinuityMode, stopDurableContinuity } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../tests/helpers/chatgpt-web-adapter";
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

const test = performanceTest(import.meta.path);
const cleanups: Array<() => Promise<void>> = [];
const require = createRequire(import.meta.url);
const launcherRecovery = require("../launcher/electron/continuity-recovery.cjs");
const launcherLease = require("../launcher/electron/continuity-lease.cjs");
const launcherAuthority = require("../launcher/electron/continuity-execution-authority.cjs");
async function disposeTestFixtures(): Promise<void> {
  chatGptTurnSessions.clear();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Continuity fixture cleanup failed");
}
afterEach(disposeTestFixtures);

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

function fixture(...args: Parameters<typeof createFixture>) {
  return withRuntimePerformanceContext({ ...runtimePerformanceContext(), fixtureMode: args[0] ? "manual" : "automatic" },
    () => measureRuntimeOperation("fixture.prepare", () => createFixture(...args)));
}
function createFixture(manual = false, options: { codexHome?: string; threadId?: string; turnTimeoutMs?: number; taskUpdates?: boolean; root?: string; waitForRetirement?: boolean } = {}) {
  const profileContext = runtimePerformanceContext();
  const root = options.root ?? mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-adapter-"));
  const statePath = join(root, "continuity");
  const registrations = measureRuntimeOperation("fixture.store", () => {
    const store = new ContinuityRegistrationStore(statePath); store.initialize(); return store;
  });
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  const submissions: Array<{ prompt: string; claim: ContinuityClaim; key: string; reused: boolean }> = [];
  // Fixture identity has the protocol shape; it is not evidence of a real Launcher process.
  const launcherInstance = { pid: process.pid, startIdentity: continuityProcessInstance().startIdentity === "unverified"
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
  }));
  cleanups.push(() => withRuntimePerformanceContext(profileContext, () => measureRuntimeAsync("fixture.cleanup", async () => {
    await measureRuntimeAsync("cleanup.http", () => server.stop(true));
    if (!options.root) rmSync(root, { recursive: true, force: true });
  })));
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
  const broker = measureRuntimeOperation("fixture.broker", () => TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!));
  let modelMcp: Client | undefined;
  const manualMcp = async () => {
    if (!modelMcp) {
      modelMcp = new Client({ name: "continuity-manual-model-fixture", version: "1" });
      await measureRuntimeAsync("fixture.mcp", () => modelMcp!.connect(new StdioClientTransport({ command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", "safe", "--broker-socket", provider.chatgptWeb!.brokerSocketPath!],
        cwd: process.cwd(), stderr: "pipe" })));
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
    preLeaseFailures: 0, unknownPreLeaseFailures: 0, failAfterSendOnce: false, failAfterToolsOnce: false, failAfterToolsKeepPage: false,
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
      if (controls.failAfterToolsOnce) { controls.failAfterToolsOnce = false; if (!controls.failAfterToolsKeepPage) pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost"); }
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
  cleanups.push(() => withRuntimePerformanceContext(profileContext, () => measureRuntimeAsync("fixture.cleanup", async () => {
    controls.releaseDeferredCompletion?.();
    controls.releaseAfterToolResults?.();
    automatic.mockRestore(); compatible.mockRestore(); taskUpdatesSupport.mockRestore();
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
  return { provider, request, next, adapter, run, registrations, statePath, threadId, pages, submissions, compatible, automatic, descriptor, descriptorPath, controls, broker, recoveryHost, root, manualControl };
}


for (const manual of [false, true]) test(`page lifetime review: ${manual} settled no-page preparation accepts current replacement payload`, async () => {
  const f = fixture(manual);
  f.controls.preLeaseFailures = 1;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.pages.size).toBe(0);
  const replacement = f.request("Current replacement instruction after the no-page error.", "turn-first");
  const outcome = await f.run(replacement);
  expect(outcome.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)?.prompt).toContain("Current replacement instruction after the no-page error.");
});
test("page lifetime review: Automatic unknown acquisition without a page can start a fresh generation", async () => {
  const f = fixture(false);
  f.controls.unknownPreLeaseFailures = 1;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.pages.size).toBe(0);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
});
test("page lifetime review: destroyed completed page releases backend task references", async () => {
  const f = fixture(false);
  const request = f.request();
  await f.run(request);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const executionKey = binding.executionKey!;
  expect(chatGptTurnSessions.find(executionKey)).toBeDefined();
  const old = binding.lease!.recovery!;
  const host = { continuityAuthorityDirectories: new Map([[old.installationId, f.statePath]]) };
  const notification = bindingReleaseNotification(f.statePath, binding);
  f.pages.clear();
  expect(require("../launcher/electron/continuity-page-store.cjs").removeDestroyedPage(host, old)).toBe(true);
  expect(new ContinuityRecoveryStore(f.statePath).get(thread)).toBeUndefined();
  await notification;
  expect(bindings.observed(thread)).toBeUndefined();
  expect(chatGptTurnSessions.find(executionKey)).toBeUndefined();
});
for (const corruption of ["missing", "malformed"] as const) test(`page lifetime review: ${corruption} old registration task file does not deny cold admission`, async () => {
  const f = fixture(false);
  const file = join(f.statePath, "threads.json");
  if (corruption === "missing") rmSync(file);
  else writeFileSync(file, "{malformed-task-state", { mode: 0o600 });
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
});
test("page lifetime review: page retirement releases completed structured compaction cache", async () => {
  const f = fixture(false), first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId), binding = bindings.observed(thread)!;
  const key = [...binding.checkpoints.keys()][0]!;
  expect(key).toBeDefined();
  expect(existingStructuredCompactionRun(key)).toBeDefined();
  const old = binding.lease!.recovery!;
  f.pages.clear();
  const host = { continuityAuthorityDirectories: new Map([[old.installationId, f.statePath]]) };
  expect(require("../launcher/electron/continuity-page-store.cjs").removeDestroyedPage(host, old)).toBe(true);
  bindings.forget(binding);
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
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


for (const manual of [false, true]) test(`page lifetime control: full HTTP closed page creates a new generation manual=${manual}`, async () => {
  const f = httpFixture(manual);
  expect((await f.send(f.body)).status).toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), old = store.get(thread)!;
  const oldIdentity = continuityBindingsFor(f.statePath).observed(thread)!.lease!.recovery!;
  f.pages.clear();
  const response = await f.send(f.body);
  expect(response.status).toBe(200);
  const current = store.get(thread)!;
  expect(current.epoch).not.toBe(old.epoch);
  expect(current.works[old.currentWorkId!]).toBeUndefined();
  const before = structuredClone(current);
  const host = { continuityAuthorityDirectories: new Map([[oldIdentity.installationId, f.statePath]]) };
  expect(require("../launcher/electron/continuity-page-store.cjs").removeDestroyedPage(host, oldIdentity)).toBe(false);
  expect(store.get(thread)).toEqual(before);
  expect(f.submissions).toHaveLength(2);
});
test("page lifetime control: live payload conflict preserves the existing generation", async () => {
  const f = httpFixture(false);
  expect((await f.send(f.body)).status).toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), before = store.get(thread)!;
  const changed = structuredClone(f.body);
  (changed.input[0] as Record<string, unknown>).content = "Conflicting current input";
  const rejected = await f.send(changed), error = await rejected.json();
  expect(rejected.status).toBe(409);
  expect(error.error.code).toBe("continuity_source_unproven");
  expect(store.get(thread)).toEqual(before);
  expect(f.submissions).toHaveLength(1);
});
test("page lifetime control: unknown live-page inspection uses current request without old settlement", async () => {
  const f = httpFixture(false);
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  expect((await f.send(f.body)).status).toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), before = store.get(thread)!;
  f.controls.inspectFailures = 1;
  expect((await f.send(f.body)).status).toBe(200);
  expect(store.get(thread)!.epoch).not.toBe(before.epoch);
  expect(store.get(thread)!.works[before.currentWorkId!]).toBeUndefined();
  expect(f.submissions).toHaveLength(2);
});
test("page lifetime review: migration releases closed legacy threads that are not requested again", async () => {
  const f = fixture(false);
  await f.run(f.request());
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const old = store.get(thread)!;
  f.pages.clear();
  const journalFile = join(f.statePath, "recovery.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8")); journal.version = 3;
  writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 });
  const other = fixture(false, { root: f.root, threadId: "other-thread-after-migration" });
  expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(JSON.parse(readFileSync(journalFile, "utf8")).version).toBe(4);
  expect(store.get(thread)).toBeUndefined();
  expect(other.pages.size).toBe(1);
  expect(old.currentWorkId).toBeDefined();
});
test("page lifetime review: legacy closed threads cannot occupy all fresh-thread admission slots", async () => {
  const f = fixture(false);
  const initializedFile = join(f.statePath, "initialized.json");
  const initialized = JSON.parse(readFileSync(initializedFile, "utf8")); delete initialized.recoveryVersion;
  writeFileSync(initializedFile, JSON.stringify(initialized), { mode: 0o600 });
  rmSync(join(f.statePath, "recovery-initialized.json")); rmSync(join(f.statePath, "recovery.json"));
  const registryFile = join(f.statePath, "threads.json"), registry = JSON.parse(readFileSync(registryFile, "utf8"));
  registry.entries = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [continuityDigest(`legacy-closed-${index}`),
    { scope: continuityDigest("old scope"), owner: continuityDigest("old owner"), state: "ended" }]));
  writeFileSync(registryFile, JSON.stringify(registry), { mode: 0o600 });
  f.registrations.initialize();
  expect(f.pages.size).toBe(0); expect(f.controls.capacityAvailable).toBe(true);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
}, 30000);
for (const closeDuringAwait of [false, true]) test(`page lifetime review: backend-restored live page closure during compatibility=${closeDuringAwait}`, async () => {
  const f = fixture(false); f.controls.actualRecovery = true;
  const original = f.request(), namespace = chatGptWebExecutionNamespace(f.provider);
  bindContinuityRequestScope(original, namespace);
  const thread = continuityDigest(f.threadId), scope = original._continuityScope!;
  const bindings = continuityBindingsFor(f.statePath), store = new ContinuityRecoveryStore(f.statePath);
  const logicalWorkId = recoveryDigest([scope, "turn-first", continuityInstructionIdentity(original), "ordinary", 0]);
  store.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner), logicalWorkId,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true });
  store.markAttempt(thread, { scope }, { logicalWorkId, attempt: 0, stage: "page-possible", launcherInstance: f.descriptor.launcherInstance });
  const old = recoveryIdentity(store.get(thread)!, store.installationId());
  launcherAuthority.bindExecutionAuthority(f.recoveryHost, old, f.statePath);
  const claim = { owner: bindings.owner, recovery: old };
  const { chatGptConversationKey } = await import("../src/adapters/chatgpt-web/conversation-key");
  original._continuityEpoch = 0;
  const key = chatGptConversationKey(original, namespace)!;
  original._continuityHistoryRevision = 0;
  const traceId = (await import("../src/adapters/chatgpt-web/index")).chatGptWebTraceId(f.provider, original);
  const tab: any = { id: "prepared-tab", traceId, helperPid: process.pid, status: "running", destroyed: false,
    continuityLeaseId: "1".repeat(32), view: { webContents: { isDestroyed: () => tab.destroyed } } };
  launcherLease.bindContinuityTab(tab, claim);
  await launcherRecovery.acquireContinuityTransaction(f.recoveryHost, claim, traceId, process.pid, key, "automatic", () => {
    f.recoveryHost.turnTabs.set(tab.id, tab); return { continuity: launcherLease.continuityLease(tab) };
  });
  expect(bindings.observed(thread)).toBeUndefined();
  if (closeDuringAwait) f.compatible.mockImplementationOnce(async () => { tab.destroyed = true; f.recoveryHost.turnTabs.clear(); });
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  if (closeDuringAwait) expect(store.get(thread)!.epoch).not.toBe(old.epoch);
});

for (const { applyTarget, localBinding } of [{ applyTarget: false, localBinding: false }, { applyTarget: true, localBinding: false }, { applyTarget: true, localBinding: true }]) test(`page lifetime review: a retained prepared ${applyTarget ? "target" : "expected"} page preserves live payload protection local=${localBinding}`, async () => {
  const f = fixture(false); f.controls.actualRecovery = true;
  const original = f.request(), namespace = chatGptWebExecutionNamespace(f.provider);
  bindContinuityRequestScope(original, namespace);
  const thread = continuityDigest(f.threadId), scope = original._continuityScope!;
  const bindings = continuityBindingsFor(f.statePath), store = new ContinuityRecoveryStore(f.statePath);
  const logicalWorkId = recoveryDigest([scope, "turn-first", continuityInstructionIdentity(original), "ordinary", 0]);
  store.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner), logicalWorkId,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true });
  store.markAttempt(thread, { scope }, { logicalWorkId, attempt: 0, stage: "page-possible", launcherInstance: f.descriptor.launcherInstance });
  const old = recoveryIdentity(store.get(thread)!, store.installationId());
  launcherAuthority.bindExecutionAuthority(f.recoveryHost, old, f.statePath);
  const claim = { owner: bindings.owner, recovery: old };
  const { chatGptConversationKey } = await import("../src/adapters/chatgpt-web/conversation-key");
  original._continuityEpoch = 0; original._continuityHistoryRevision = 0;
  const key = chatGptConversationKey(original, namespace)!;
  const traceId = (await import("../src/adapters/chatgpt-web/index")).chatGptWebTraceId(f.provider, original);
  const tab: any = { id: "prepared-tab", traceId, helperPid: process.pid, status: "running", destroyed: false,
    continuityLeaseId: "1".repeat(32), view: { webContents: { isDestroyed: () => tab.destroyed } } };
  launcherLease.bindContinuityTab(tab, claim);
  await launcherRecovery.acquireContinuityTransaction(f.recoveryHost, claim, traceId, process.pid, key, "automatic", () => {
    f.recoveryHost.turnTabs.set(tab.id, tab); return { continuity: launcherLease.continuityLease(tab) };
  });
  const before = store.get(thread)!;
  if (localBinding) {
    const retained = bindings.installRecovered(before, "prepared-local-execution", continuityDigest(null), "turn-first");
    retained.state = "unverified"; retained.lease = launcherLease.continuityLease(tab);
    retained.conversation = { key, descriptor: f.descriptorPath };
  }
  const pending = store.beginPreparation(thread, { scope, expectedVersion: before.version }, {
    logicalWorkId, owner: continuityProcessInstance(bindings.owner), snapshotDigest: "9".repeat(64), launcherInstance: f.descriptor.launcherInstance });
  const target = recoveryIdentity({ ...pending, ...pending.pendingPreparation!.target }, store.installationId());
  if (applyTarget) launcherRecovery.updateContinuityPreparation(f.recoveryHost, old, target);
  const currentTag = applyTarget ? target : old;
  expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, currentTag).state).toBe("prepared");
  expect(tab.destroyed).toBe(false); expect(f.recoveryHost.turnTabs.size).toBe(1);
  expect(Boolean(bindings.observed(thread))).toBe(localBinding);
  const outcome = await f.run(f.request("Changed body under the accepted instruction ID.")).then(() => ({ code: "resolved" }), error => ({ code: error.code }));
  console.info("review prepared-page outcome", { applyTarget, ...outcome, epochChanged: store.get(thread)?.epoch !== old.epoch,
    acquisitions: f.controls.actualAcquisitions, oldTabDestroyed: tab.destroyed });
  expect(outcome.code).toBe("continuity_source_unproven");
  expect(store.get(thread)).toEqual(pending);
  expect(f.controls.actualAcquisitions).toBe(0);
  expect(tab.destroyed).toBe(false);
});

function bindingReleaseNotification(directory: string, binding: import("../src/adapters/chatgpt-web/continuity-binding").ContinuityBinding): Promise<void> {
  return new Promise<void>((resolveNotification, reject) => {
    let notified = false;
    const listener = watch(directory, { persistent: false }, () => { notified = true; });
    const check = setInterval(() => {
      if (!notified || binding.state !== "lost") return;
      clearTimeout(timeout); clearInterval(check); listener.close(); resolveNotification();
    }, 5);
    const timeout = setTimeout(() => { clearInterval(check); listener.close(); reject(new Error("Backend did not release the destroyed page after file notification")); }, 2000);
  });
}

test("page lifetime review: two local observers keep the creation lock against a real third backend", async () => {
  const f = fixture(), one = f.request(), two = f.request();
  const a = f.adapter(), b = f.adapter();
  const thread = continuityDigest(f.threadId), lock = join(f.statePath, `${thread}.admission.lock`);
  await a.preflight!(one, { headers: new Headers() });
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  await b.preflight!(two, { headers: new Headers() });
  expect(existsSync(lock)).toBe(true); expect(f.pages.size).toBe(0);
  const code = `import {prepareContinuityRequest} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-request.ts"))};
    try { await prepareContinuityRequest(${JSON.stringify(one)},${JSON.stringify(f.provider)},${JSON.stringify(chatGptWebExecutionNamespace(f.provider))},
    {localToolsEnabled:true,solAvailable:true,proAvailable:false,extraHighAvailable:false},{assertContinuityCompatible:async()=>{}});process.exit(2); }
    catch(error) { console.log(error.message);process.exit(/storage (?:is )?busy/.test(error.message)?0:3); }`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(await new Response(child.stdout).text()).toContain("storage is busy");
  expect(new ContinuityRecoveryStore(f.statePath).get(thread)).toEqual(before);
  const events: AdapterEvent[] = [];
  await a.runTurn!(one, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(existsSync(lock)).toBe(false); expect(f.submissions).toHaveLength(1);
});

test("page lifetime review: authenticated old interrupt does not block same-turn new-page compaction", async () => {
  const f = fixture(false, { threadId: "review-auth-interrupt-thread" }), first = f.request(); await f.run(first);
  const bindings = continuityBindingsFor(f.statePath), old = bindings.recoveryStore.get(continuityDigest(f.threadId))!;
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
  f.pages.clear();
  const compact = f.request(); compact._compactionRequest = true;
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(bindings.recoveryStore.get(old.thread)!.epoch).not.toBe(old.epoch);
  expect(f.submissions).toHaveLength(2);
});

test("page lifetime review: migration retries a closed thread skipped under its active admission lock", async () => {
  const { acquireContinuityStorageLock } = await import("../src/adapters/chatgpt-web/continuity-recovery-store");
  const f = fixture(); await f.run(f.request());
  const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
  f.pages.clear();
  const unlock = acquireContinuityStorageLock(join(f.statePath, `${thread}.admission.lock`));
  const other = fixture(false, { root: f.root, threadId: "busy-migration-new-thread" });
  try {
    expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(store.get(thread)).toBeDefined();
  } finally { unlock(); }
  expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(store.get(thread)).toBeUndefined();
});

test("page lifetime review: duplicate file replacements preserve the successor and close the old listener", async () => {
  const f = fixture(); await f.run(f.request());
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId), old = bindings.observed(thread)!;
  const identity = old.lease!.recovery!;
  const host = { continuityAuthorityDirectories: new Map([[identity.installationId, f.statePath]]) };
  const notified = bindingReleaseNotification(f.statePath, old);
  f.pages.clear(); launcherRecovery.removedContinuityTab(host, { continuityRecovery: identity, view: { webContents: { isDestroyed: () => true } } });
  await notified;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const successor = bindings.observed(thread)!, before = bindings.recoveryStore.get(thread)!;
  expect(successor).not.toBe(old);
  launcherRecovery.removedContinuityTab(host, { continuityRecovery: identity, view: { webContents: { isDestroyed: () => true } } });
  const file = join(f.statePath, "recovery.json");
  writeFileSync(file, readFileSync(file));
  await new Promise(resolveNotification => setTimeout(resolveNotification, 20));
  expect(bindings.observed(thread)).toBe(successor); expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(f.submissions).toHaveLength(2);
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("page lifetime review: a stale backend preserves another backend's confirmed live page", async () => {
  const filesystem = await import("node:fs"), realWatch = filesystem.watch;
  const notifications: Array<() => void> = [];
  const pausedWatch = spyOn(filesystem, "watch").mockImplementation(((path: string, options: object, listener: (...args: any[]) => void) =>
    realWatch(path, options, (...args) => { notifications.push(() => listener(...args)); })) as typeof filesystem.watch);
  const f = fixture();
  try {
    const original = f.request(); await f.run(original);
    const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId), oldBinding = bindings.observed(thread)!;
    f.pages.clear();
    const code = `import {prepareContinuityRequest} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-request.ts"))};
      const prepared=await prepareContinuityRequest(${JSON.stringify(original)},${JSON.stringify(f.provider)},${JSON.stringify(chatGptWebExecutionNamespace(f.provider))},
      {localToolsEnabled:true,solAvailable:true,proAvailable:false,extraHighAvailable:false},{assertContinuityCompatible:async()=>{}});
      prepared.releaseAdmission?.(); console.log(JSON.stringify({conversationKey:prepared.conversationKey}));`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const prepared = JSON.parse(stdout), store = new ContinuityRecoveryStore(f.statePath);
    const next = store.get(thread)!, work = next.works[next.currentWorkId!]!;
    const possible = store.markAttempt(thread, { scope: next.scope, expectedVersion: next.version }, {
      logicalWorkId: work.logicalWorkId, attempt: 0, stage: "page-possible", launcherInstance: f.descriptor.launcherInstance });
    const identity = recoveryIdentity(possible, store.installationId());
    f.controls.actualRecovery = true; launcherAuthority.bindExecutionAuthority(f.recoveryHost, identity, f.statePath);
    const claim = { owner: next.owner.id, recovery: identity };
    const tab: any = { id: "other-backend-live", traceId: "other-backend-live", helperPid: process.pid, status: "ready",
      continuityLastSuccessAt: Date.now(), destroyed: false, continuityLeaseId: "2".repeat(32) };
    tab.view = { webContents: { isDestroyed: () => tab.destroyed } };
    const receipt = await launcherRecovery.acquireContinuityTransaction(f.recoveryHost, claim, tab.traceId, process.pid,
      prepared.conversationKey, "automatic", () => {
        launcherLease.bindContinuityTab(tab, claim); f.recoveryHost.turnTabs.set(tab.id, tab);
        return { continuity: launcherLease.continuityLease(tab) };
      });
    f.pages.set(prepared.conversationKey, { continuity: receipt.continuity, state: "ready" });
    expect(bindings.observed(thread)).toBe(oldBinding);
    expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, identity).state).toBe("prepared");
    const before = store.get(thread)!;
    await expect(f.adapter().preflight!(f.request("Conflicting replacement payload."), { headers: new Headers() }))
      .rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(store.get(thread)).toEqual(before); expect(tab.destroyed).toBe(false);
    await f.adapter().preflight!(f.request(), { headers: new Headers() });
    expect(store.get(thread)!.epoch).toBe(before.epoch);
    expect(store.get(thread)!.currentWorkId).toBe(before.currentWorkId);
    expect(tab.destroyed).toBe(false); expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.submissions).toHaveLength(1);
  } finally { pausedWatch.mockRestore(); for (const notification of notifications) notification(); }
});

for (const unsafe of ["permissions", "symlink"] as const) test.skipIf(process.platform === "win32")(`page lifetime control: unsafe ${unsafe} registration task file is not replaced`, async () => {
  const f = fixture(), file = join(f.statePath, "threads.json");
  const installation = readFileSync(join(f.statePath, "initialized.json"), "utf8");
  if (unsafe === "permissions") chmodSync(file, 0o644);
  else { rmSync(file); symlinkSync("missing-registration-target", file); }
  await expect(f.run(f.request())).rejects.toBeDefined();
  expect(readFileSync(join(f.statePath, "initialized.json"), "utf8")).toBe(installation);
  if (unsafe === "permissions") expect(lstatSync(file).mode & 0o077).toBe(0o044);
  else expect(lstatSync(file).isSymbolicLink()).toBe(true);
  expect(f.pages.size).toBe(0);
});

test("page lifetime control: cancellation before registration stays exact to the original page", async () => {
  const f = fixture(), nativeThreadId = `${f.threadId}-cancel-control`, nativeTurnId = "cancel-before-registration";
  const page = { directory: f.statePath, thread: continuityDigest(nativeThreadId), epoch: 1 };
  const owner = { ownerKey: `${nativeThreadId}:old`, traceIds: [], nativeThreadId, nativeTurnId, page };
  registerStructuredCompactionPage(nativeThreadId, nativeTurnId, page);
  const reason = new Error("Stop this original page before its compaction registers");
  const cancelled = cancelStructuredCompactionNativeTurn(nativeThreadId, nativeTurnId, reason);
  expect(cancelled.cancelled).toBe(0);
  let started = false;
  await expect(runStructuredCompactionOnce(`${nativeThreadId}:old`, owner, async () => { started = true; return "old"; })).rejects.toBe(reason);
  expect(started).toBe(false);
  const other = { ownerKey: `${nativeThreadId}:non-task`, traceIds: [], nativeThreadId: `${nativeThreadId}:non-task`, nativeTurnId };
  const otherReason = new Error("Keep the independent non-task cancellation");
  cancelStructuredCompactionNativeTurn(other.nativeThreadId, nativeTurnId, otherReason);
  forgetStructuredCompactionPage(page.directory, page.thread, page.epoch);
  await expect(runStructuredCompactionOnce(`${nativeThreadId}:non-task`, other, async () => "unreachable")).rejects.toBe(otherReason);
  const successor = { ...owner, ownerKey: `${nativeThreadId}:new`, page: { ...page, epoch: 2 } };
  registerStructuredCompactionPage(nativeThreadId, nativeTurnId, successor.page);
  expect(await runStructuredCompactionOnce(`${nativeThreadId}:new`, successor, async () => "new page summary")).toBe("new page summary");
  forgetStructuredCompactionPage(page.directory, page.thread, 2);
});

test("page lifetime control: exact cleanup removes lookup while in-flight and successor summaries finish", async () => {
  const f = fixture(), thread = continuityDigest(`${f.threadId}-lookup-control`), prefix = `${f.statePath}:lookup-control`;
  const page = { directory: f.statePath, thread, epoch: 1 };
  let finish!: (summary: string) => void, entered!: () => void;
  const started = new Promise<void>(resolveStarted => { entered = resolveStarted; });
  const transport = new Promise<string>(resolveSummary => { finish = resolveSummary; });
  const old = runStructuredCompactionOnce(`${prefix}:old`, { ownerKey: `${prefix}:old`, traceIds: [], page }, async () => { entered(); return transport; });
  await started;
  const successor = runStructuredCompactionOnce(`${prefix}:new`, { ownerKey: `${prefix}:new`, traceIds: [], page: { ...page, epoch: 2 } }, async () => "successor");
  const nonTask = runStructuredCompactionOnce(`${prefix}:independent`, { ownerKey: `${prefix}:independent`, traceIds: [] }, async () => "independent");
  await Promise.all([successor, nonTask]);
  forgetStructuredCompactionPage(page.directory, page.thread, 1);
  expect(existingStructuredCompactionRun(`${prefix}:old`)).toBeUndefined();
  expect(existingStructuredCompactionRun(`${prefix}:new`)).toBe(successor);
  expect(existingStructuredCompactionRun(`${prefix}:independent`)).toBe(nonTask);
  finish("in-flight original summary");
  expect(await old).toBe("in-flight original summary");
  expect(existingStructuredCompactionRun(`${prefix}:old`)).toBeUndefined();
  forgetStructuredCompactionPage(page.directory, page.thread, 2);
});

test("page lifetime control: an interrupted directory migration retries after format promotion", async () => {
  const f = fixture(); await f.run(f.request());
  const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
  f.pages.clear();
  const file = join(f.statePath, "recovery.json"), document = JSON.parse(readFileSync(file, "utf8"));
  document.version = 3; writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
  const other = fixture(false, { root: f.root, threadId: "interrupted-directory-migration" });
  const remove = spyOn(ContinuityRecoveryStore.prototype, "removePage").mockImplementationOnce(() => { throw new Error("Simulated interruption before removing the old thread"); });
  try { await expect(other.run(other.request())).rejects.toThrow("Simulated interruption"); }
  finally { remove.mockRestore(); }
  expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(4);
  expect(store.get(thread)).toBeDefined();
  expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(store.get(thread)).toBeUndefined();
});

test("page lifetime control: a live manual checkpoint keeps its retained physical lease and result conflict gate", async () => {
  const f = fixture(true); f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const thread = continuityDigest(f.threadId), bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(thread)!, oldLease = structuredClone(binding.lease!);
  const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(key)!, call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call), { type: "function_call_output", call_id: call.callId, output: "Actual manual checkpoint result." }]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing manual checkpoint summary");
  const checkpoint = bindings.recoveryStore.get(thread)!;
  expect(binding.lease).toEqual(oldLease);
  expect(checkpoint.epoch).toBe(oldLease.recovery!.epoch);
  expect(checkpoint.transaction!.transactionId).not.toBe(oldLease.recovery!.transactionId);
  expect(checkpoint.works[oldLease.recovery!.logicalWorkId]!.attempts[oldLease.recovery!.attempt]!.writerRetired).toBe(true);
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  expect((await f.run(resumed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(bindings.observed(thread)).toBe(binding);
  expect(bindings.recoveryStore.get(thread)!.epoch).toBe(checkpoint.epoch);
  expect(chatGptTurnSessions.find(key)).toBe(source);
  const changed = structuredClone(compact);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.type === "function_call_output")!.output = "Conflicting checkpoint result.";
  const sends = f.submissions.length;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_result_conflict" });
  expect(f.submissions).toHaveLength(sends);
  f.pages.clear();
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(bindings.recoveryStore.get(thread)!.epoch).not.toBe(checkpoint.epoch);
});

test("page lifetime control: removed installation directory fails before lock or page creation", async () => {
  const f = fixture(); rmSync(f.statePath, { recursive: true, force: true });
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(existsSync(f.statePath)).toBe(false); expect(f.pages.size).toBe(0); expect(f.submissions).toHaveLength(0);
});

test("page lifetime R3: destroying a retained MCP page clears its task generation after the writer advances", async () => {
  const f = fixture(true); f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const start = f.manualControl.start.bind(f.manualControl);
  let observedSendBeforeReceipt = false;
  f.manualControl.start = async (...args) => {
    const lease = await start(...args);
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    const attempt = record.works[record.currentWorkId!]!.attempts.at(-1)!;
    expect(attempt.stage).toBe("send-possible");
    expect(attempt.pageReceiptId).toBeUndefined();
    observedSendBeforeReceipt = true;
    return lease;
  };
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(observedSendBeforeReceipt).toBe(true);
  f.manualControl.start = start;
  const thread = continuityDigest(f.threadId), bindings = continuityBindingsFor(f.statePath), binding = bindings.observed(thread)!;
  const lease = structuredClone(binding.lease!), identity = lease.recovery!;
  const accepted = bindings.recoveryStore.get(thread)!.works[identity.logicalWorkId]!.attempts[identity.attempt]!;
  expect(accepted.stage).toBe("accepted");
  expect(accepted.pageReceiptId).toBe(lease.leaseId);
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!, call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call), { type: "function_call_output", call_id: call.callId, output: "Actual retained MCP result." }]);
  compact._compactionRequest = true;
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const before = bindings.recoveryStore.get(thread)!, compactKey = [...binding.checkpoints.keys()][0]!;
  expect(before.epoch).toBe(identity.epoch);
  expect(before.transaction!.transactionId).not.toBe(identity.transactionId);
  expect(binding.lease).toEqual(lease);
  expect(existingStructuredCompactionRun(compactKey)).toBeDefined();
  expect(() => bindings.recoveryStore.assertExecutionAuthority(identity)).toThrow();
  const page = { directory: f.statePath, thread, epoch: binding.pageGeneration ?? binding.epoch! };
  const interruptionKey = `${f.statePath}:destroyed-interruption-control`;
  const interruptionOwner = { ownerKey: interruptionKey, traceIds: [], nativeThreadId: f.threadId, nativeTurnId: "turn-first", page };
  registerStructuredCompactionPage(f.threadId, "turn-first", page);
  const interrupted = new Error("Stop only the retained physical page");
  await cancelStructuredCompactionNativeTurn(f.threadId, "turn-first", interrupted).settlement;
  await expect(runStructuredCompactionOnce(interruptionKey, interruptionOwner, async () => "unreachable")).rejects.toBe(interrupted);
  const host = { continuityAuthorityDirectories: new Map([[identity.installationId, f.statePath]]) };
  const pageStore = require("../launcher/electron/continuity-page-store.cjs");
  const tab = { continuityRecovery: identity, continuityCreationRecovery: identity, continuityLeaseId: lease.leaseId,
    view: { webContents: { isDestroyed: () => true } } };
  // An old writer tag alone, a live document, or a different physical receipt cannot clear the page.
  expect(pageStore.removeDestroyedPage(host, identity)).toBe(false);
  expect(pageStore.removeDestroyedPage(host, identity, { ...tab, view: { webContents: { isDestroyed: () => false } } })).toBe(false);
  expect(pageStore.removeDestroyedPage(host, identity, { ...tab, continuityLeaseId: "0".repeat(32) })).toBe(false);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  const notified = bindingReleaseNotification(f.statePath, binding);
  f.pages.clear(); launcherRecovery.removedContinuityTab(host, tab);
  await notified;
  expect(bindings.recoveryStore.get(thread)).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.statePath, "threads.json"), "utf8")).entries[thread]).toBeUndefined();
  expect(bindings.observed(thread)).toBeUndefined();
  expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
  expect(binding.checkpoints.size).toBe(0);
  expect(existingStructuredCompactionRun(compactKey)).toBeUndefined();
  expect(await runStructuredCompactionOnce(interruptionKey, interruptionOwner, async () => "interruption index released")).toBe("interruption index released");
  forgetStructuredCompactionPage(page.directory, page.thread, page.epoch);
  expect(() => bindings.recoveryStore.assertExecutionAuthority(identity)).toThrow();
  f.controls.invokeSourceTools = false;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const successor = bindings.recoveryStore.get(thread)!, successorBinding = bindings.observed(thread)!;
  expect(successor.epoch).not.toBe(identity.epoch);
  launcherRecovery.removedContinuityTab(host, tab);
  expect(bindings.recoveryStore.get(thread)).toEqual(successor);
  expect(bindings.observed(thread)).toBe(successorBinding);
  expect(f.pages.size).toBe(1);
});

test("page lifetime R3: registry-only migration frees 10000 admission slots without changing installation identity", async () => {
  const f = fixture();
  const markerFile = join(f.statePath, "initialized.json"), marker = readFileSync(markerFile, "utf8");
  const registryFile = join(f.statePath, "threads.json"), registry = JSON.parse(readFileSync(registryFile, "utf8"));
  registry.entries = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [continuityDigest(`orphan-${index}`), {
    scope: continuityDigest("old scope"), owner: continuityDigest("old owner"), state: "ended", epoch: 1,
    transactionId: continuityDigest(`orphan-transaction-${index}`),
  }]));
  writeFileSync(registryFile, JSON.stringify(registry), { mode: 0o600 });
  expect(f.pages.size).toBe(0);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(Object.keys(JSON.parse(readFileSync(registryFile, "utf8")).entries)).toEqual([continuityDigest(f.threadId)]);
  expect(readFileSync(markerFile, "utf8")).toBe(marker);
  expect(f.pages.size).toBe(1);
}, 30000);

test("page lifetime R3: another thread retries naturally interrupted orphan cleanup after its admission lock releases", async () => {
  const { acquireContinuityStorageLock } = await import("../src/adapters/chatgpt-web/continuity-recovery-store");
  const f = fixture(); await f.run(f.request());
  const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  const file = join(f.statePath, "threads.json"), markerFile = join(f.statePath, "initialized.json"), marker = readFileSync(markerFile, "utf8");
  f.pages.clear(); chmodSync(file, 0o644);
  try { expect(() => store.removePage(thread, before)).toThrow(); }
  finally { chmodSync(file, 0o600); }
  expect(store.get(thread)).toBeUndefined();
  expect(JSON.parse(readFileSync(file, "utf8")).entries[thread]).toBeDefined();
  const unlock = acquireContinuityStorageLock(join(f.statePath, `${thread}.admission.lock`));
  const other = fixture(false, { root: f.root, threadId: "orphan-cleanup-retry-other" });
  try {
    expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(JSON.parse(readFileSync(file, "utf8")).entries[thread]).toBeDefined();
  } finally { unlock(); }
  const live = store.get(continuityDigest(other.threadId))!;
  const orphanLock = join(f.statePath, `${thread}.admission.lock`), unsafeUnlock = acquireContinuityStorageLock(orphanLock);
  try {
    chmodSync(orphanLock, 0o755);
    if (process.platform !== "win32") {
      await expect(other.run(other.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
      expect(JSON.parse(readFileSync(file, "utf8")).entries[thread]).toBeDefined();
    }
  } finally { chmodSync(orphanLock, 0o700); unsafeUnlock(); }
  expect((await other.run(other.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(JSON.parse(readFileSync(file, "utf8")).entries[thread]).toBeUndefined();
  expect(store.get(continuityDigest(other.threadId))).toEqual(live);
  expect(other.pages.size).toBe(1);
  expect(readFileSync(markerFile, "utf8")).toBe(marker);
});
