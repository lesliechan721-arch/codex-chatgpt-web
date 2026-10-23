import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test.each([
  { owned: true },
  { owned: false },
  { owned: true, tools: true },
  { owned: true, cancellationCase: true },
  { owned: true, sizeRejected: true },
  { owned: true, tools: true, retained: true },
  { owned: true, sizeRejected: true, sseRejection: true },
  { owned: true, gpt6Pro: true },
  { owned: true, unknownSend: true },
  { owned: true, preflightRejected: true },
])("browser turns preserve one Send, recovery and tool ownership (%j)", async ({ owned, tools = false,
  cancellationCase = false, sizeRejected = false, retained = false, sseRejection = false,
  gpt6Pro = false, unknownSend = false, preflightRejected = false }) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const effort = gpt6Pro ? "max" : tools ? "xhigh" : "high";
  const finalResponse = cancellationCase ? chatGptBrowserTabClosedError() : new Error("fixture reached final response observation");
  const unknownSubmission = new ChatGptWebAdapterError("The physical Send has no acceptance evidence", {
    status: 502, errorType: "server_error", code: "chatgpt_submission_ambiguous", retryable: false,
  });
  const capabilities = { localToolsEnabled: tools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const progress = tools ? new ChatGptExternalTurnProgress() : undefined;
  const recoveryCallbacks: unknown[] = [];
  const actions: string[] = [];
  const sendBudgets: number[] = [];
  let released = false;
  let activated = 0;
  let freshChatPreparations = 0;
  let rejectionAbortedWait = false;
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    evaluate: async () => ({}),
    evaluateHandle: async () => ({ evaluate: async () => false, dispose: async () => {} }),
    isClosed: () => false,
    mainFrame: () => frame,
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native4", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      if (name === "send") sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => { freshChatPreparations += 1; },
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, _capabilities: unknown,
      _diagnostic: unknown, trackUsage: boolean, family: string) => {
      expect(trackUsage).toBe(false);
      expect(family).toBe(gpt6Pro && effort === "max" ? "6" : "5.6");
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    captureSubmissionBaseline: async (_page: unknown, _text: string, turnToken?: string) => {
      expect(turnToken).toBeUndefined();
      return {};
    },
    attachPromptWithCompactionRetry: async (_page: unknown, _text: string, localTools: boolean) => {
      expect(localTools).toBe(tools);
      actions.push(localTools ? "attach:tools" : "attach:plain");
    },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async (...args: unknown[]) => {
      expect(args[4]).toBe(progress);
      const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
      await lifecycle.onSendActivated();
      // This fixture replaces physical Send, which now owns the observer window.
      // Keep the real rejection observer active for the emitted service responses.
      const observer = args[9] as { begin(observedPage: typeof page): void; endSubmissionIdentity(): void };
      observer.begin(page);
      if (cancellationCase || sizeRejected) {
        // An observed size rejection must not replace the user's explicit tab-close verdict.
        const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
        page.emit("request", request);
        page.emit("response", {
          request: () => request, status: () => sseRejection ? 200 : 413,
          headers: () => ({ "content-type": sseRejection ? "text/event-stream" : "application/json" }),
          json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
          text: async () => 'data: {"error":"The message you submitted was too long, please edit it and resubmit.","error_code":"input_too_large","error_reason":"last_user_message"}\n\ndata: [DONE]\n\n',
        });
        page.emit("requestfinished", request);
      }
      observer.endSubmissionIdentity();
      recoveryCallbacks.push(args[7]);
      actions.push("send");
      if (unknownSend) throw unknownSubmission;
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      expect(args[4]).toBe(progress);
      recoveryCallbacks.push(args[7]);
      actions.push("observe");
      if (sizeRejected) {
        const signal = args[3] as AbortSignal;
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("rejected input kept waiting")), 250);
          const onAbort = () => { clearTimeout(timer); rejectionAbortedWait = true; reject(signal.reason); };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      throw finalResponse;
    },
  });
  if (retained) {
    // Exercise the real attachment path: the previous Send cleared its mention,
    // even though this conversation still belongs to the same launcher task.
    let connectorSelected = false;
    const composer = {
      fill: async () => { connectorSelected = false; },
      focus: async () => {}, press: async () => {},
    };
    const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
    Object.assign(page, { locator: () => absentDialog });
    Object.assign(worker, {
      attachPrompt: (ChatGptBrowserWorker.prototype as any).attachPrompt,
      attachPromptWithCompactionRetry: (ChatGptBrowserWorker.prototype as any).attachPromptWithCompactionRetry,
      activeComposer: async () => composer,
      connectorIsSelected: async () => connectorSelected,
      selectConnector: async () => { connectorSelected = true; actions.push("attach:tools"); return composer; },
      insertPromptText: async () => { expect(connectorSelected).toBeTrue(); },
      assertPromptAttached: async () => {},
      clearChatGptComposerState: async () => { connectorSelected = false; },
    });
  }
  const prepare = async () => ({ text: preflightRejected ? "word ".repeat(120_000) : "Summarize the context",
    images: [], release: () => { released = true; } });
  try {
    const run = worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      modelFamily: gpt6Pro ? "6" : "5.6",
      reasoning: effort,
      onSendActivated: () => { activated += 1; },
      capabilities,
      compaction: !tools,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare,
      prepareResume: prepare,
    }, owned ? "owned-surface" : undefined, page, retained);
    if (preflightRejected) {
      await expect(run).rejects.toMatchObject({ code: "context_length_exceeded", retryable: false });
      expect(actions).toEqual([]);
      expect(sendBudgets).toEqual([]);
      expect(activated).toBe(0);
      expect(freshChatPreparations).toBe(0);
    } else if (sizeRejected) {
      await expect(run).rejects.toMatchObject({ code: "context_length_exceeded", retryable: false });
      expect(rejectionAbortedWait).toBeTrue();
    } else await expect(run).rejects.toBe(unknownSend ? unknownSubmission : finalResponse);
    if (!preflightRejected) {
      expect(freshChatPreparations).toBe(retained ? 0 : 1);
      expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
        Array(unknownSend ? 1 : 2).fill(owned ? "function" : "undefined"),
      );
      expect(actions).toEqual([
        `effort:${effort}`, tools ? "attach:tools" : "attach:plain", "files", "send",
        ...(!unknownSend ? ["observe"] : []),
      ]);
      expect(sendBudgets).toEqual([180_000]);
      expect(activated).toBe(1);
    }
    expect(released).toBe(true);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
