import { validateSkillFiles } from "./skill-attachments";
import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { assertBrowserTurnExecutionAuthority, ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import { createBrowserHelperPromptSelection, validateBrowserHelperContextPlan } from "./browser-helper-prompt-selection";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, getLauncherKnownUnsentReceipt, LAUNCHER_CONTEXT_DELIVERY_FEATURE, notifyLauncherTurn } from "../../launcher-browser-host";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, isContinuityClaim, sameContinuityRecoveryIdentity, type ContinuityClaim, type ContinuityRecoveryIdentity } from "./continuity-contract";
import { isChatGptWebMultipartPartCount, type CompiledChatGptWebPrompt } from "./prompt";
import { ChatGptMirroredTurnProgress } from "./turn-progress";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
    useSavedChats?: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    modelFamily?: "5.6" | "6";
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    continuity?: ContinuityClaim;
    recoveryStoreDirectory?: string;
    recoveryRequestId?: string;
    compaction?: boolean;
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
    taskUpdateProtocol?: 1;
    submissionReceiptAcknowledgement?: boolean;
  };
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

interface LimitsMessage {
  type: "limits";
  id: string;
  config: VerifyMessage["config"];
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage | LimitsMessage;
type InputMessage = { recovery?: ContinuityRecoveryIdentity } & (RunMessage
  | MaintenanceMessage
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "context_plan_selected_ack"; id: string; planId: string }
  | { type: "send_activation_ack"; id: string }
  | { type: "submitted_ack"; id: string }
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string; reason?: "compaction_handoff_accepted" }
  | { type: "shutdown" });

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): boolean => protocolOutput.write(JSON.stringify(message));

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
const turnRecoveryIdentities = new Map<string, ContinuityRecoveryIdentity>();
const turnAuthorityChecks = new Map<string, () => void>();
const acknowledgedSendTurns = new Set<string>();
interface RunControl {
  failure?: Error;
  ended: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retire: () => Promise<void>;
  retirement?: Promise<void>;
  reject: (error: Error) => void;
}
const runControls = new Map<string, RunControl>();
// Only trace identities remain here after forced per-turn retirement. The worker must
// actually settle before that identity can be reused; no prepared prompt is retained.
const unfinishedWorkers = new Set<string>();
const retiredWorkers = new Set<string>();
const ABORT_RETIREMENT_TIMEOUT_MS = 15_000;
const MAX_UNFINISHED_ABORTS = 5;
const turnProgress = new Map<string, ChatGptMirroredTurnProgress>();
const taskUpdateTurns = new Set<string>();
const preparedSelections = new Map<string, ReturnType<typeof createBrowserHelperPromptSelection>>();
const contextPlanSelections = new Map<string, { prepared: CompiledChatGptWebPrompt; timer: ReturnType<typeof setTimeout> }>();
const acknowledgedContextPlanIds = new Map<string, string>();
const CONTEXT_PLAN_ACK_TIMEOUT_MS = 15_000;
function clearContextPlanSelection(id: string): void {
  const pending = contextPlanSelections.get(id);
  if (pending) clearTimeout(pending.timer);
  contextPlanSelections.delete(id);
}
const sendActivationWaiters = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
}>();
const submissionReceiptWaiters = new Map<string, {
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}>();
function clearSubmissionReceiptWaiter(id: string): ReturnType<typeof submissionReceiptWaiters.get> {
  const waiter = submissionReceiptWaiters.get(id);
  if (waiter) clearTimeout(waiter.timer);
  submissionReceiptWaiters.delete(id);
  return waiter;
}
const completionFenceBeginWaiters = new Map<string, {
  requestId: number;
  resolve: (revision: number | undefined) => void;
  reject: (error: Error) => void;
}>();
const completionFenceCommitWaiters = new Map<string, {
  requestId: number;
  resolve: (committed: boolean) => void;
  reject: (error: Error) => void;
}>();
let completionFenceRequestId = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function abortRun(id: string, failure?: Error, reason?: Error): void {
  const control = runControls.get(id);
  if (!control || control.ended) return;
  if (failure) control.failure ??= failure;
  const aborted = failure ?? reason ?? new DOMException("Browser helper turn aborted", "AbortError");
  abortControllers.get(id)?.abort(reason ?? failure);
  preparedSelections.get(id)?.cancel();
  clearContextPlanSelection(id);
  const sendWaiter = sendActivationWaiters.get(id);
  sendActivationWaiters.delete(id);
  sendWaiter?.reject(aborted);
  if (!turnRecoveryIdentities.has(id) || !acknowledgedSendTurns.has(id)) {
    clearSubmissionReceiptWaiter(id)?.reject(aborted);
  }
  const beginWaiter = completionFenceBeginWaiters.get(id);
  completionFenceBeginWaiters.delete(id);
  beginWaiter?.reject(aborted);
  const commitWaiter = completionFenceCommitWaiters.get(id);
  completionFenceCommitWaiters.delete(id);
  commitWaiter?.reject(aborted);
  if (control.timer) return;
  control.timer = setTimeout(() => {
    if (control.ended) return;
    retiredWorkers.add(id);
    control.retirement = control.retire();
    void control.retirement.then(
      () => {
        control.ended = true;
        control.reject(control.failure ?? aborted);
      },
      error => {
        control.ended = true;
        control.reject(new AggregateError([control.failure ?? aborted, error], "Browser helper could not release the aborted turn"));
      },
    );
  }, ABORT_RETIREMENT_TIMEOUT_MS);
  control.timer.unref?.();
}

function requestShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  for (const control of runControls.values()) if (control.timer) clearTimeout(control.timer);
  protocolOutput.close();
  diagnosticOutput.close();
  for (const controller of abortControllers.values()) controller.abort();
  for (const selection of preparedSelections.values()) selection.cancel();
  preparedSelections.clear();
  for (const id of contextPlanSelections.keys()) clearContextPlanSelection(id);
  acknowledgedContextPlanIds.clear();
  for (const waiter of sendActivationWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  sendActivationWaiters.clear();
  for (const id of submissionReceiptWaiters.keys()) {
    clearSubmissionReceiptWaiter(id)?.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  for (const waiter of completionFenceBeginWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceBeginWaiters.clear();
  for (const waiter of completionFenceCommitWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceCommitWaiters.clear();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id) || unfinishedWorkers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (retiredWorkers.size >= MAX_UNFINISHED_ABORTS) throw new Error("Browser helper has too many unfinished aborted turns");
  if (message.turn.resumeAvailable !== undefined && typeof message.turn.resumeAvailable !== "boolean") {
    throw new Error("Browser helper resume availability is invalid");
  }
  if (message.turn.nativeConnector !== undefined && typeof message.turn.nativeConnector !== "boolean") {
    throw new Error("Browser helper native connector flag is invalid");
  }
  if (message.turn.retainConversation !== undefined && typeof message.turn.retainConversation !== "boolean") {
    throw new Error("Browser helper conversation retention flag is invalid");
  }
  if (message.turn.requireRetainedConversation !== undefined
    && typeof message.turn.requireRetainedConversation !== "boolean") {
    throw new Error("Browser helper retained-conversation requirement is invalid");
  }
  if (message.turn.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(message.turn.conversationKey)) {
    throw new Error("Browser helper conversation key is invalid");
  }
  if (message.turn.continuity !== undefined && !isContinuityClaim(message.turn.continuity)) {
    throw new Error("Browser helper continuity claim is invalid");
  }
  if (message.turn.compaction !== undefined && typeof message.turn.compaction !== "boolean") {
    throw new Error("Browser helper compaction flag is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  if (message.turn.externalProgress !== undefined && typeof message.turn.externalProgress !== "boolean") {
    throw new Error("Browser helper external progress flag is invalid");
  }
  if (message.turn.taskUpdateProtocol !== undefined
    && (message.turn.taskUpdateProtocol !== 1 || message.turn.externalProgress !== true)) {
    throw new Error("Browser helper task update protocol is invalid");
  }
  if (message.turn.submissionReceiptAcknowledgement !== undefined
    && typeof message.turn.submissionReceiptAcknowledgement !== "boolean") {
    throw new Error("Browser helper submission receipt acknowledgement flag is invalid");
  }
  const recovery = message.turn.continuity?.recovery;
  if (message.turn.recoveryRequestId !== undefined && (typeof message.turn.recoveryRequestId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(message.turn.recoveryRequestId))) throw new Error("Browser helper acquisition request identity is invalid");
  const assertExecutionAuthority = () => assertBrowserTurnExecutionAuthority(message.turn);
  assertExecutionAuthority();
  if (recovery) turnRecoveryIdentities.set(message.id, recovery);
  if (recovery) turnAuthorityChecks.set(message.id, assertExecutionAuthority);
  const writeTurnProtocol = (value: Record<string, unknown>): boolean => writeProtocol({ ...value, ...(recovery ? { recovery } : {}) });
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      browserDiagnosticsPath: message.config.browserDiagnosticsPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
      useSavedChats: message.config.useSavedChats === true,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  let rejectRetirement!: (error: Error) => void;
  const retirement = new Promise<never>((_, reject) => { rejectRetirement = reject; });
  const control: RunControl = { ended: false, reject: rejectRetirement, retire: async () => {
    await notifyLauncherTurn(message.config.browserHostDescriptorPath, {
      phase: "end", traceId: message.id, helperPid: process.pid, status: "failed",
      message: "Browser helper did not finish the aborted turn",
      ...(recovery ? { recovery } : {}),
      ...(message.turn.recoveryStoreDirectory ? { recoveryStoreDirectory: message.turn.recoveryStoreDirectory } : {}),
    });
  } };
  runControls.set(message.id, control);
  const assertActiveOutput = () => {
    if (control.ended) throw new DOMException("Browser helper turn has ended", "AbortError");
    if (control.failure) throw control.failure;
    assertExecutionAuthority();
    if (abortController.signal.aborted) throw abortController.signal.reason;
  };
  // The Codex MCP broker runs in the daemon process, so this mirror is the only way the worker can
  // observe that a turn is still executing while its ChatGPT DOM is unavailable. Trace ids are
  // derived deterministically and can repeat, so each run starts a fresh mirror rather than
  // inheriting revisions recorded for an earlier turn that happened to share the id.
  const progress = message.turn.externalProgress
    ? new ChatGptMirroredTurnProgress(revision => {
      if (!writeTurnProtocol({ type: "event", id: message.id, event: "tool_batch_observed", revision })) {
        throw new Error("Browser helper could not acknowledge the observed Codex tool boundary");
      }
    })
    : undefined;
  if (progress) turnProgress.set(message.id, progress);
  if (message.turn.taskUpdateProtocol) taskUpdateTurns.add(message.id);
  const promptSelection = createBrowserHelperPromptSelection();
  preparedSelections.set(message.id, promptSelection);
  const prepareSelected = async () => ({ ...await promptSelection.wait(), release: () => {} });
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    ...(message.turn.modelFamily ? { modelFamily: message.turn.modelFamily } : {}),
    capabilities: message.turn.capabilities,
    ...(message.turn.nativeConnector ? { nativeConnector: true } : {}),
    prepare: prepareSelected,
    ...(message.turn.resumeAvailable ? { prepareResume: prepareSelected } : {}),
    ...(message.turn.retainConversation ? { retainConversation: true } : {}),
    ...(message.turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    ...(message.turn.conversationKey ? { conversationKey: message.turn.conversationKey } : {}),
    ...(message.turn.continuity ? {
      continuity: message.turn.continuity,
      ...(message.turn.recoveryStoreDirectory ? { recoveryStoreDirectory: message.turn.recoveryStoreDirectory } : {}),
      ...(message.turn.recoveryRequestId ? { recoveryRequestId: message.turn.recoveryRequestId } : {}),
      assertExecutionAuthority,
      onContinuityLease: lease => {
        assertExecutionAuthority();
        if (!writeTurnProtocol({ type: "event", id: message.id, event: "continuity_lease", lease })) {
          throw new Error("Browser helper could not return the continuity lease");
        }
      },
    } : {}),
    abortSignal: abortController.signal,
    ...(message.turn.compaction ? { compaction: true } : {}),
    ...(message.turn.taskUpdateProtocol ? { taskUpdateProtocol: message.turn.taskUpdateProtocol } : {}),
    ...(progress ? {
      externalProgress: progress,
      completionFence: {
        begin: candidate => new Promise<number | undefined>((resolve, reject) => {
          if (completionFenceBeginWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a begin result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceBeginWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeTurnProtocol({ type: "event", id: message.id, event: "completion_fence_begin", requestId,
            ...(candidate ? { candidate } : {}) })) {
            completionFenceBeginWaiters.delete(message.id);
            reject(new Error("Browser helper could not begin the broker completion fence"));
          }
        }),
        commit: (revision, candidate) => new Promise<boolean>((resolve, reject) => {
          if (completionFenceCommitWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a commit result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceCommitWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeTurnProtocol({ type: "event", id: message.id, event: "completion_fence_commit", requestId, revision,
            ...(candidate ? { candidate } : {}) })) {
            completionFenceCommitWaiters.delete(message.id);
            reject(new Error("Browser helper could not commit the broker completion fence"));
          }
        }),
      },
    } : {}),
    onHeartbeat: () => !control.ended && writeTurnProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onGenerationProgress: () => !control.ended && writeTurnProtocol({ type: "event", id: message.id, event: "generation_progress" }),
    onPreparedSelected: reused => {
      assertActiveOutput();
      if (!writeTurnProtocol({ type: "event", id: message.id, event: "prepared_selected", reused })) {
        throw new Error("Browser helper could not request prompt selection");
      }
      return promptSelection.wait().then(() => undefined);
    },
    onContextPlanSelected: planId => {
      // The daemon already confirmed this plan through the two-way IPC handshake.
      // A direct worker still executes its selection hook, without repeating that IPC.
      if (acknowledgedContextPlanIds.get(message.id) !== planId) {
        throw new Error("Browser helper worker prepared an unacknowledged context plan");
      }
    },
    onSendActivated: () => new Promise<void>((resolve, reject) => {
      assertActiveOutput();
      if (sendActivationWaiters.has(message.id)) {
        reject(new Error("Browser helper Send activation already awaits acknowledgement"));
        return;
      }
      sendActivationWaiters.set(message.id, { resolve, reject });
      if (!writeTurnProtocol({ type: "event", id: message.id, event: "send_activated" })) {
        sendActivationWaiters.delete(message.id);
        reject(new Error("Browser helper could not request the Send activation boundary"));
      }
    }),
    onSubmitted: () => {
      if (control.ended) throw new DOMException("Browser helper turn has ended", "AbortError");
      if (recovery && !acknowledgedSendTurns.has(message.id)) {
        throw new Error("Browser helper submission has no acknowledged Send for this run");
      }
      if (!message.turn.submissionReceiptAcknowledgement) {
        if (!writeTurnProtocol({ type: "event", id: message.id, event: "submitted" })) {
          throw new Error("Browser helper could not persist ChatGPT submission evidence");
        }
        return;
      }
      if (submissionReceiptWaiters.has(message.id)) {
        throw new Error("Browser helper submission receipt already awaits acknowledgement");
      }
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
      // The real worker awaits this callback. Also retain a handled promise if a substituted
      // worker returns early, so run() can still enforce the terminal receipt barrier.
      void promise.catch(() => {});
      const timer = setTimeout(() => {
        clearSubmissionReceiptWaiter(message.id)?.reject(new Error("Browser helper submission receipt acknowledgement timed out"));
      }, 15_000);
      timer.unref?.();
      submissionReceiptWaiters.set(message.id, { promise, timer, resolve, reject });
      if (!writeTurnProtocol({ type: "event", id: message.id, event: "submitted" })) {
        clearSubmissionReceiptWaiter(message.id)?.reject(new Error("Browser helper could not persist ChatGPT submission evidence"));
      }
      return promise;
    },
    onMultipartStageAcknowledged: stageIndex => {
      assertActiveOutput();
      if (!writeTurnProtocol({ type: "event", id: message.id, event: "multipart_stage_acknowledged", stageIndex })) {
        throw new Error("Browser helper could not persist multipart acknowledgement evidence");
      }
    },
    onReasoningSummary: (text, continuation) => {
      assertActiveOutput();
      writeTurnProtocol({ type: "event", id: message.id, event: "reasoning", text, ...(continuation ? { continuation: true } : {}) });
    },
    onCommentary: (text, continuation) => {
      assertActiveOutput();
      writeTurnProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) });
    },
    onTextDelta: (text, candidate) => {
      assertActiveOutput();
      writeTurnProtocol({ type: "event", id: message.id, event: "text", text,
        ...(candidate ? { candidate } : {}) });
    },
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => {
        assertActiveOutput();
        writeTurnProtocol({ type: "event", id: message.id, event: "luna_checkpoint", ...captured });
      },
    } : {}),
  };
  try {
    unfinishedWorkers.add(message.id);
    const workerResult = Promise.resolve().then(() => ChatGptBrowserWorker.forProvider(provider).run(turn));
    const workerSettled = () => { unfinishedWorkers.delete(message.id); retiredWorkers.delete(message.id); };
    void workerResult.then(workerSettled, workerSettled);
    const text = await Promise.race([workerResult, retirement]);
    await submissionReceiptWaiters.get(message.id)?.promise;
    assertActiveOutput();
    writeTurnProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    error = control.failure ?? error;
    // A worker can settle while watchdog cleanup is in flight. Its terminal must
    // still wait for that cleanup, and a failed release must remain visible.
    if (control.retirement) {
      try { await control.retirement; }
      catch (cleanupError) { error = new AggregateError([error, cleanupError], "Browser helper could not release the aborted turn"); }
    }
    writeTurnProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
      } : {}),
      ...(getLauncherKnownUnsentReceipt(error) ? { sendUnsentReceipt: getLauncherKnownUnsentReceipt(error) } : {}),
    });
  } finally {
    control.ended = true;
    if (control.timer) clearTimeout(control.timer);
    if (!unfinishedWorkers.has(message.id)) retiredWorkers.delete(message.id);
    runControls.delete(message.id);
    preparedSelections.get(message.id)?.cancel();
    preparedSelections.delete(message.id);
    clearContextPlanSelection(message.id);
    acknowledgedContextPlanIds.delete(message.id);
    const sendWaiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    sendWaiter?.reject(new DOMException("Browser helper turn ended before Send acknowledgement", "AbortError"));
    clearSubmissionReceiptWaiter(message.id)?.reject(new DOMException("Browser helper turn ended before submission receipt acknowledgement", "AbortError"));
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence commit", "AbortError"));
    abortControllers.delete(message.id);
    turnRecoveryIdentities.delete(message.id);
    turnAuthorityChecks.delete(message.id);
    acknowledgedSendTurns.delete(message.id);
    turnProgress.delete(message.id);
    taskUpdateTurns.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector(message.id);
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage | LimitsMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : message.type === "limits" ? await worker.inspectLimitsPlan()
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type !== "run" && "id" in message) {
    const recovery = turnRecoveryIdentities.get(message.id);
    if (recovery && (!message.recovery || !sameContinuityRecoveryIdentity(message.recovery, recovery))) return;
    // Abort and the original semantic Send receipt remain valid after withdrawal. They cannot
    // grant execution rights. Every other delayed control frame must read current authority.
    if (message.type !== "abort" && message.type !== "submitted_ack") {
      try { turnAuthorityChecks.get(message.id)?.(); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // A rejected control frame is not a worker terminal. Preserve its error and
        // allow the acknowledged original Send to report its trusted receipt first.
        abortRun(message.id, failure);
        return;
      }
    }
  }
  if (message.type === "prepared_selected_ack") {
    const prepared = message.prepared;
    if (!prepared || typeof prepared.text !== "string" || !Array.isArray(prepared.images)) {
      abortRun(message.id, new Error("Browser helper prompt selection is invalid"));
      return;
    }
    try {
      validateSkillFiles(prepared.skillFiles);
      validateBrowserHelperContextPlan(prepared.contextPlan);
    }
    catch (error) {
      abortRun(message.id, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (prepared.multipart !== undefined) {
      const multipart = prepared.multipart;
      if (!multipart || !Array.isArray(multipart.parts)
        || !isChatGptWebMultipartPartCount(multipart.parts.length)
        || multipart.parts.some(part => typeof part !== "string")
        || typeof multipart.commit !== "string") {
        abortRun(message.id, new Error("Browser helper multipart prompt is invalid"));
        return;
      }
    }
    const selection = preparedSelections.get(message.id);
    if (!selection) {
      abortRun(message.id, new Error("Browser helper has no pending prompt selection"));
      return;
    }
    if (prepared.contextPlan) {
      if (contextPlanSelections.has(message.id)) {
        abortRun(message.id, new Error("Browser helper context plan selection is already pending"));
        return;
      }
      const recovery = turnRecoveryIdentities.get(message.id);
      const timer = setTimeout(() => {
        abortRun(message.id, new Error("Browser helper context plan acknowledgement timed out"));
      }, CONTEXT_PLAN_ACK_TIMEOUT_MS);
      timer.unref?.();
      contextPlanSelections.set(message.id, { prepared, timer });
      if (!writeProtocol({ type: "event", id: message.id, event: "context_plan_selected", planId: prepared.contextPlan.planId,
        ...(recovery ? { recovery } : {}) })) {
        abortRun(message.id, new Error("Browser helper could not request context plan selection"));
      }
    } else {
      selection.select(prepared);
    }
  } else if (message.type === "context_plan_selected_ack") {
    const prepared = contextPlanSelections.get(message.id)?.prepared;
    const selection = preparedSelections.get(message.id);
    if (!prepared?.contextPlan || !selection || message.planId !== prepared.contextPlan.planId) {
      abortRun(message.id, new Error("Browser helper received a mismatched context plan acknowledgement"));
      return;
    }
    clearContextPlanSelection(message.id);
    acknowledgedContextPlanIds.set(message.id, message.planId);
    selection.select(prepared);
  } else if (message.type === "send_activation_ack") {
    const waiter = sendActivationWaiters.get(message.id);
    if (!waiter) {
      abortRun(message.id, new Error("Browser helper has no pending Send activation"));
      return;
    }
    sendActivationWaiters.delete(message.id);
    acknowledgedSendTurns.add(message.id);
    waiter.resolve();
  } else if (message.type === "submitted_ack") {
    const waiter = clearSubmissionReceiptWaiter(message.id);
    if (!waiter) {
      abortRun(message.id, new Error("Browser helper has no pending submission receipt"));
      return;
    }
    waiter.resolve();
  } else if (message.type === "completion_fence_begin_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || (message.revision !== null && (!Number.isSafeInteger(message.revision) || message.revision < 0))) {
      abortRun(message.id, new Error("Browser helper completion fence revision is invalid"));
      return;
    }
    const waiter = completionFenceBeginWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceBeginWaiters.delete(message.id);
    waiter.resolve(message.revision ?? undefined);
  } else if (message.type === "completion_fence_commit_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || typeof message.committed !== "boolean") {
      abortRun(message.id, new Error("Browser helper completion fence result is invalid"));
      return;
    }
    const waiter = completionFenceCommitWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceCommitWaiters.delete(message.id);
    waiter.resolve(message.committed);
  } else if (message.type === "progress") {
    // Progress is meaningful only for a turn this helper is currently running. Ignore every other
    // id so the mirror map remains owned by active turn lifecycles.
    if (!abortControllers.has(message.id)) return;
    const progress = turnProgress.get(message.id) ?? new ChatGptMirroredTurnProgress();
    turnProgress.set(message.id, progress);
    try {
      progress.apply(message.snapshot);
    } catch (error) {
      if (taskUpdateTurns.has(message.id)
        && (progress.snapshot().taskUpdates !== undefined || message.snapshot?.taskUpdates !== undefined)) {
        abortRun(message.id, new ChatGptWebAdapterError("Browser helper lost valid negotiated task update control state", {
          status: 503, errorType: "server_error", code: "task_update_protocol_missing", retryable: false,
        }));
        return;
      }
      // Progress carries liveness and tool-boundary state, never response content. Invalid progress
      // cannot determine the outcome of the active ChatGPT turn, so it is logged and ignored.
      diagnostic(
        `[chatgpt-web] discarded an invalid MCP progress frame for ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.type === "abort") {
    abortRun(message.id, undefined, message.reason === "compaction_handoff_accepted"
      ? new ChatGptCompactionHandoffAccepted()
      : undefined);
  }
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke" || message.type === "limits") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "run") {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
      ...(message.turn.continuity?.recovery ? { recovery: message.turn.continuity.recovery } : {}),
      ...(error instanceof ChatGptWebAdapterError ? { status: error.status, errorType: error.errorType,
        code: error.code, retryable: error.retryable } : {}),
      ...(getLauncherKnownUnsentReceipt(error) ? { sendUnsentReceipt: getLauncherKnownUnsentReceipt(error) } : {}),
    }));
  } else {
    // Never treat an unrecognised frame as a run; unsupported protocol data fails explicitly.
    const id = (message as { id?: string }).id ?? "unknown";
    const failure = new Error(`Browser helper received an unsupported message type: ${String((message as { type?: unknown }).type)}`);
    if (runControls.has(id)) abortRun(id, failure);
    else writeProtocol({ type: "error", id, message: failure.message });
  }
});
input.on("close", () => {
  void requestShutdown();
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

// Advertise the optional frames this helper understands so the daemon can negotiate them explicitly.
writeProtocol({ type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence", "native-tool-wait-v1", "task-updates-v1", "task-output-ack-v3", "multipart-stage-ack", "skill-attachments", "submission-receipt-ack-v1", "preparation-termination-v1", CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_CONTEXT_DELIVERY_FEATURE] });
