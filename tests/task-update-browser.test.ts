import { createTaskOutputControlSource, publishTaskOutputVersion } from "../src/adapters/chatgpt-web/task-update-ack";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  ChatGptExternalTurnProgress,
  ChatGptMirroredTurnProgress,
  assertChatGptTurnProgressSnapshot,
} from "../src/adapters/chatgpt-web/turn-progress";
import type { TaskUpdateState } from "../src/adapters/chatgpt-web/task-update-protocol";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function realHelperClient(browserFixture: string): LauncherBrowserHelperClient {
  const root = mkdtempSync(join(tmpdir(), "task-update-browser-helper-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { observedTaskAcknowledgement } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/task-update-ack.ts", import.meta.url).href)};
    import { ChatGptBrowserWorker, ChatGptCompletionTracker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (turn.taskUpdateProtocol !== 1) throw new Error("Task update protocol lost in IPC");
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      ${browserFixture}
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:39002", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return new LauncherBrowserHelperClient({
    appName: "Codex Native4", browserHost: "launcher", browserHostDescriptorPath: descriptor,
    browserHelperScriptPath: helper, browserDiagnosticsPath: root,
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: false,
  });
}

function directBrowserFixture(readText: () => Promise<string>, onSourceBoundary?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "task-update-browser-direct-"));
  roots.push(root);
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { appName: "Codex Native4", browserDiagnosticsPath: root },
  }) as any;
  const hidden: any = {
    last: () => hidden, filter: () => hidden, getByText: () => hidden, getByTestId: () => hidden,
    isVisible: async () => false,
  };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, locator: () => hidden, url: () => "https://chatgpt.com/",
    evaluate: async () => { throw new Error("DOM supplied by the owned-turn fixture"); },
  });
  let observations = 0;
  Object.assign(worker, {
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => ({ effort: "low", localTools: false }),
    captureSubmissionBaseline: async () => ({}),
    attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
    sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _capture: unknown, _signal: unknown,
      progress: ChatGptExternalTurnProgress, _lifecycle: unknown, tracker: ChatGptCompletionTracker) => {
      const snapshot = progress.snapshot();
      if (snapshot.lastToolBatchRevision) {
        tracker.observeToolBatch(snapshot.lastToolBatchRevision, "Before tool");
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      }
      onSourceBoundary?.();
      return "mcp_tool_call";
    },
    waitForNewAssistantTurn: async () => ({ locator: hidden, identity: "assistant", acceptedTurnIdentities: ["assistant"] }),
    responseDomSnapshot: async () => {
      observations += 1;
      const text = await readText();
      return {
        responsePresent: true, visibleText: text, fullHtml: `<p>${text}</p>`,
        markdownSegments: [{ key: "answer", tag: "p", html: `<p>${text}</p>`, text, streamable: true }],
        completionActionVisible: true, stoppedThinkingVisible: false, traceBlocks: [],
      };
    },
  });
  return {
    run: (turn: Pick<BrowserTurn, "externalProgress" | "completionFence" | "onTextDelta">) => worker.runBrowserTurn({
      ...turn, traceId: "task_update_direct", modelId: "gpt-5.6-sol", reasoning: "low", taskUpdateProtocol: 1,
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
    }, undefined, page) as Promise<string>,
    observations: () => observations,
  };
}

const initial: TaskUpdateState = {
  acceptedRevision: 0, deliveredRevision: 0, acknowledgedRevision: 0,
  driverGeneration: 0, finalOutputRevision: null,
};
const delivered: TaskUpdateState = {
  acceptedRevision: 1, deliveredRevision: 1, acknowledgedRevision: 0,
  driverGeneration: 1, finalOutputRevision: null,
};

test("task state and ACK mirrors advance transport without fabricating tool activity or a lease", async () => {
  const progress = new ChatGptExternalTurnProgress();
  expect(progress.recordTaskUpdateState(initial)).toBeTrue();
  const baseline = progress.snapshot();
  assertChatGptTurnProgressSnapshot(baseline);
  const changed = progress.waitForChange(baseline.revision);
  expect(progress.recordTaskUpdateState(delivered)).toBeTrue();
  await changed;
  const acknowledged = { ...delivered, acknowledgedRevision: 1 };
  expect(progress.recordTaskUpdateState(acknowledged)).toBeTrue();
  expect(progress.recordTaskUpdateState(acknowledged)).toBeFalse();
  expect(progress.snapshot()).toMatchObject({
    lastToolBatchRevision: 0, activeToolCalls: 0, taskUpdates: acknowledged,
  });
  expect(progress.snapshot().lastProgressAt).toBeUndefined();
  expect(progress.snapshot().nativeWaiting).toBeUndefined();
  const mirror = new ChatGptMirroredTurnProgress();
  expect(mirror.apply(progress.snapshot())).toBeTrue();
  const returned = mirror.snapshot();
  returned.taskUpdates!.acceptedRevision = 99;
  expect(mirror.snapshot().taskUpdates).toEqual(acknowledged);
});

test("task state frames cannot regress or drop the negotiated control protocol", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(delivered);
  const mirror = new ChatGptMirroredTurnProgress();
  mirror.apply(progress.snapshot());
  expect(() => mirror.apply({ ...progress.snapshot(), revision: 2, taskUpdates: initial })).toThrow();
  expect(() => mirror.apply({ revision: 2, lastToolBatchRevision: 0, activeToolCalls: 0, lastProgressAt: 1 })).toThrow();
  expect(() => progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 2 })).toThrow();
});

test("an old answer candidate keeps its captured revision and driver after an async update", () => {
  const tracker = new ChatGptCompletionTracker(0);
  const candidate = tracker.captureTaskOutputCandidate(initial);
  expect(candidate).toEqual({ taskRevision: 0, expectedDriverGeneration: 0, acknowledgedRevision: 0 });
  expect(tracker.captureTaskOutputCandidate({ ...delivered, acknowledgedRevision: 1 })).toEqual(candidate);
  expect(Object.isFrozen(candidate)).toBeTrue();
});

test("ACK cannot rewrite the acknowledgment head of an already observed final projection", () => {
  const tracker = new ChatGptCompletionTracker(0);
  tracker.beginTaskOutputObservation(delivered);
  const candidate = tracker.captureTaskOutputCandidate(delivered, "Unacknowledged answer");
  expect(candidate).toEqual({ taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 0 });
  const acknowledged = { ...delivered, acknowledgedRevision: 1 };
  expect(tracker.beginTaskOutputObservation(acknowledged)).toBeFalse();
  expect(tracker.captureTaskOutputCandidate(acknowledged, "Unacknowledged answer")).toBe(candidate);
  expect(candidate?.acknowledgedRevision).toBe(0);
});

test("a changed task invalidates its settle candidate but cannot upgrade the same old final projection", () => {
  const tracker = new ChatGptCompletionTracker(10);
  tracker.beginTaskOutputObservation(initial);
  const old = tracker.captureTaskOutputCandidate(initial, "Old final answer");
  const finished = {
    responsePresent: true, running: false, currentText: "Old final answer", completionActionVisible: true,
  };
  expect(tracker.update(finished, 100)).toBeFalse();
  const acknowledged = { ...delivered, acknowledgedRevision: 1 };
  expect(tracker.beginTaskOutputObservation(acknowledged)).toBeTrue();
  expect(tracker.captureTaskOutputCandidate(acknowledged, "Old final answer")).toEqual(old);
  expect(tracker.update(finished, 110)).toBeFalse();
  expect(tracker.captureTaskOutputCandidate(acknowledged, "Fresh revised final answer")).toEqual({
    taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1,
  });
  expect(tracker.beginTaskOutputObservation(acknowledged)).toBeFalse();
});

test("ACK followed by a direct final answer reuses the real source tool observation", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(initial);
  const tracker = new ChatGptCompletionTracker(10);
  const batchRevision = progress.recordToolBatch(1, 1_000);
  tracker.observeToolBatch(batchRevision, "Before tool");
  progress.recordTaskUpdateState(delivered);
  progress.recordToolResult(2_000);
  progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
  const finished = {
    responsePresent: true, running: false, currentText: "Complete revised answer",
    completionActionVisible: true,
  };
  expect(tracker.captureTaskOutputCandidate(progress.snapshot().taskUpdates)).toEqual({
    taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1,
  });
  expect(tracker.update(finished, 2_000)).toBeFalse();
  progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
  expect(tracker.update(finished, 2_010)).toBeTrue();
  expect(progress.snapshot().lastToolBatchRevision).toBe(batchRevision);
  expect(progress.snapshot().lastProgressAt).toBe(2_000);
});

test("real helper preserves one candidate when completion commits before the first final text", async () => {
  const client = realHelperClient(`
    const tracker = new ChatGptCompletionTracker(0);
    let snapshot = turn.externalProgress.snapshot();
    if (!snapshot.taskUpdates) snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal);
    tracker.observeToolBatch(snapshot.lastToolBatchRevision, "Before tool");
    await turn.externalProgress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
    turn.onSubmitted();
    do { snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal); }
    while (snapshot.taskUpdates.acknowledgedRevision !== 1);
    if (snapshot.activeToolCalls !== 0 || snapshot.lastProgressAt === undefined || snapshot.nativeWaiting)
      throw new Error("Task control fabricated work or a Native lease");
    tracker.beginTaskOutputObservation(snapshot.taskUpdates);
    const candidate = tracker.captureTaskOutputCandidate(snapshot.taskUpdates, "Revised final answer");
    turn.onCommentary("Continuing after acknowledged instructions");
    turn.onReasoningSummary("Checking result");
    const ticket = await turn.completionFence.begin(candidate);
    if (!await turn.completionFence.commit(ticket, candidate)) throw new Error("Completion refused");
    turn.onTextDelta("Revised final answer", candidate);
    return "Revised final answer";
  `);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(initial);
  const batch = progress.recordToolBatch(1, 1_000);
  const calls: unknown[] = [];
  try {
    expect(await client.supportsTaskUpdates()).toBeTrue();
    await expect(client.run({
      traceId: "completed_before_text", modelId: "gpt-5.6-sol", capabilities: {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      },
      taskUpdateProtocol: 1, externalProgress: progress,
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      onSubmitted: () => {
        progress.recordTaskUpdateState(delivered);
        progress.recordToolResult(2_000);
        progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
      },
      onCommentary: text => { calls.push(["commentary", text]); },
      onReasoningSummary: text => { calls.push(["reasoning", text]); },
      completionFence: {
        begin: async candidate => { calls.push(["begin", candidate]); return 7; },
        commit: async (ticket, candidate) => { calls.push(["commit", ticket, candidate]); return true; },
      },
      onTextDelta: (text, candidate) => { calls.push(["text", text, candidate]); },
    })).resolves.toBe("Revised final answer");
    const candidate = { taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1 };
    expect(calls).toEqual([
      ["commentary", "Continuing after acknowledged instructions"], ["reasoning", "Checking result"],
      ["begin", candidate], ["commit", 7, candidate], ["text", "Revised final answer", candidate],
    ]);
    await expect(progress.waitForToolBatchObservation(batch)).resolves.toBeUndefined();
    expect(progress.snapshot()).toMatchObject({ lastToolBatchRevision: batch, lastProgressAt: 2_000, activeToolCalls: 0 });
  } finally { await client.close(); }
});

test("real helper forwards an old completion ticket with its original generation after a delayed update", async () => {
  const client = realHelperClient(`
    let snapshot = turn.externalProgress.snapshot();
    if (!snapshot.taskUpdates) snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal);
    const tracker = new ChatGptCompletionTracker(0);
    tracker.beginTaskOutputObservation(snapshot.taskUpdates);
    const candidate = tracker.captureTaskOutputCandidate(snapshot.taskUpdates, "Old final answer");
    const ticket = await turn.completionFence.begin(candidate);
    do { snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal); }
    while (snapshot.taskUpdates.driverGeneration !== 1);
    await turn.completionFence.commit(ticket, candidate);
    throw new Error("Old completion unexpectedly succeeded");
  `);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(initial);
  const contexts: unknown[] = [];
  try {
    await expect(client.run({
      traceId: "stale_helper_completion", modelId: "gpt-5.6-sol", capabilities: {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      },
      taskUpdateProtocol: 1, externalProgress: progress,
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      completionFence: {
        begin: async candidate => {
          contexts.push(candidate);
          progress.recordTaskUpdateState(delivered);
          return 9;
        },
        commit: async (ticket, candidate) => {
          contexts.push([ticket, candidate]);
          throw new ChatGptWebAdapterError("Captured driver is stale", {
            status: 409, errorType: "invalid_request_error", code: "task_update_driver_stale", retryable: false,
          });
        },
      },
      onTextDelta() { throw new Error("Old text must not escape completion"); },
    })).rejects.toMatchObject({ code: "task_update_driver_stale", retryable: false });
    expect(contexts).toEqual([
      { taskRevision: 0, expectedDriverGeneration: 0, acknowledgedRevision: 0 },
      [9, { taskRevision: 0, expectedDriverGeneration: 0, acknowledgedRevision: 0 }],
    ]);
  } finally { await client.close(); }
});

test("direct production DOM loop completes after ACK with no new tools and rereads before commit", async () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(initial);
  const batch = progress.recordToolBatch(1, 1_000);
  const browser = directBrowserFixture(async () => "Complete revised answer", () => {
    progress.recordTaskUpdateState(delivered);
    progress.recordToolResult(2_000);
    progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
  });
  let beginObservation = 0;
  const candidates: unknown[] = [];
  const deltas: unknown[] = [];
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async candidate => { beginObservation = browser.observations(); candidates.push(candidate); return 0; },
      commit: async (ticket, candidate) => {
        expect(browser.observations()).toBeGreaterThan(beginObservation);
        expect(ticket).toBe(0);
        candidates.push(candidate);
        return true;
      },
    },
    onTextDelta: (text, candidate) => { deltas.push([text, candidate]); },
  })).resolves.toBe("Complete revised answer");
  const candidate = { taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1 };
  expect(candidates).toEqual([candidate, candidate]);
  expect(deltas).toEqual([["Complete revised answer", candidate]]);
  expect(progress.snapshot().lastToolBatchRevision).toBe(batch);
});

test("ACK that settles during the first DOM read qualifies the returned projection without upgrading its task", async () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(delivered);
  const browser = directBrowserFixture(async () => {
    progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
    return "Confirmed answer";
  });
  const candidates: unknown[] = [];
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async candidate => { candidates.push(candidate); return 0; },
      commit: async (_ticket, candidate) => { candidates.push(candidate); return true; },
    },
    onTextDelta: (_text, candidate) => { candidates.push(candidate); },
  })).resolves.toBe("Confirmed answer");
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates) expect(candidate).toEqual({
    taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1,
  });
});

test("a version publication during the DOM read cannot upgrade the read's original binding", async () => {
  const directory = createTaskOutputControlSource();
  roots.push(directory);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState({ ...initial, acknowledgementDirectory: directory });
  let firstRead = true;
  const browser = directBrowserFixture(async () => {
    if (firstRead) {
      firstRead = false;
      publishTaskOutputVersion(directory, 1, 1);
      writeFileSync(join(directory, "1.ack"), "", { flag: "wx", mode: 0o600 });
    }
    return "Old projection returned after takeover";
  });
  const seen: unknown[] = [];
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async candidate => {
        seen.push(candidate);
        throw new ChatGptWebAdapterError("The read predates the task takeover", {
          status: 502, errorType: "server_error", code: "task_update_driver_stale", retryable: false,
        });
      },
      commit: async () => { throw new Error("The old read must not commit"); },
    },
    onTextDelta: (_text, candidate) => { seen.push(candidate); },
  })).rejects.toMatchObject({ code: "task_update_driver_stale" });
  expect(seen).toEqual(Array(2).fill({ taskRevision: 0, expectedDriverGeneration: 0, acknowledgedRevision: 0 }));
});

test("the production DOM loop retains pre-ACK provenance when ACK settles after its first text callback", async () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(delivered);
  const browser = directBrowserFixture(async () => "Unacknowledged answer");
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async candidate => {
        expect(progress.snapshot().taskUpdates?.acknowledgedRevision).toBe(1);
        expect(candidate?.acknowledgedRevision).toBe(0);
        throw new ChatGptWebAdapterError("The candidate predates ACK", {
          status: 409, errorType: "invalid_request_error", code: "task_update_unacknowledged", retryable: false,
        });
      },
      commit: async () => { throw new Error("Rejected text must not commit"); },
    },
    onTextDelta: (_text, candidate) => {
      expect(candidate?.acknowledgedRevision).toBe(0);
      progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
    },
  })).rejects.toMatchObject({ code: "task_update_unacknowledged" });
});

test("real helper reads the same-host ACK publication while its progress mirror remains unacknowledged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-update-helper-ack-"));
  roots.push(directory);
  const client = realHelperClient(`
    let snapshot = turn.externalProgress.snapshot();
    if (!snapshot.taskUpdates) snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal);
    if (snapshot.taskUpdates.acknowledgedRevision !== 0) throw new Error("The mirror must still be delayed");
    const tracker = new ChatGptCompletionTracker(0);
    const captured = { ...snapshot.taskUpdates, acknowledgedRevision: observedTaskAcknowledgement(snapshot.taskUpdates) };
    const candidate = tracker.captureTaskOutputCandidate(captured, "Acknowledged answer");
    turn.onTextDelta("Acknowledged answer", candidate);
    const ticket = await turn.completionFence.begin(candidate);
    if (!await turn.completionFence.commit(ticket, candidate)) throw new Error("Completion refused");
    return "Acknowledged answer";
  `);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState({ ...delivered, acknowledgementDirectory: directory });
  const seen: unknown[] = [];
  try {
    await expect(client.run({
      traceId: "helper_lagged_ack_mirror", modelId: "gpt-5.6-sol", capabilities: {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      }, taskUpdateProtocol: 1, externalProgress: progress,
      prepare: async () => {
        // Broker uses the same atomic empty-file publication before returning ACK. Do not mirror it.
        writeFileSync(join(directory, "1.ack"), "", { flag: "wx", mode: 0o600 });
        return { text: "inspect", images: [], release() {} };
      },
      onTextDelta: (_text, candidate) => { seen.push(candidate); },
      completionFence: {
        begin: async candidate => { seen.push(candidate); return 1; },
        commit: async (_ticket, candidate) => { seen.push(candidate); return true; },
      },
    })).resolves.toBe("Acknowledged answer");
    expect(seen).toEqual(Array(3).fill({ taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1 }));
    expect(progress.snapshot().taskUpdates?.acknowledgedRevision).toBe(0);
  } finally { await client.close(); }
});

test("real helper preserves a pre-ACK candidate even after observing the acknowledged head", async () => {
  const client = realHelperClient(`
    const tracker = new ChatGptCompletionTracker(0);
    let snapshot = turn.externalProgress.snapshot();
    if (!snapshot.taskUpdates) snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal);
    const candidate = tracker.captureTaskOutputCandidate(snapshot.taskUpdates, "Unacknowledged answer");
    turn.onSubmitted();
    do { snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal); }
    while (snapshot.taskUpdates.acknowledgedRevision !== 1);
    turn.onTextDelta("Unacknowledged answer", candidate);
    await turn.completionFence.begin(candidate);
    throw new Error("The pre-ACK candidate must not complete");
  `);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(delivered);
  const seen: unknown[] = [];
  try {
    await expect(client.run({
      traceId: "helper_ack_provenance", modelId: "gpt-5.6-sol", capabilities: {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      },
      taskUpdateProtocol: 1, externalProgress: progress,
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      onSubmitted: () => { progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 }); },
      onTextDelta: (_text, candidate) => { seen.push(candidate); },
      completionFence: {
        begin: async candidate => {
          seen.push(candidate);
          throw new ChatGptWebAdapterError("The captured ACK is stale", {
            status: 409, errorType: "invalid_request_error", code: "task_update_unacknowledged", retryable: false,
          });
        },
        commit: async () => false,
      },
    })).rejects.toMatchObject({ code: "task_update_unacknowledged", retryable: false });
    expect(seen).toEqual([
      { taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 0 },
      { taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 0 },
    ]);
  } finally { await client.close(); }
});

test("direct production DOM loop cannot upgrade an async old final projection to the new head", async () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(initial);
  let read = 0;
  const browser = directBrowserFixture(async () => {
    if (++read === 1) progress.recordTaskUpdateState({ ...delivered, acknowledgedRevision: 1 });
    return "Old final answer";
  });
  const contexts: unknown[] = [];
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async candidate => {
        contexts.push(candidate);
        throw new ChatGptWebAdapterError("Old candidate cannot complete", {
          status: 409, errorType: "invalid_request_error", code: "task_update_driver_stale", retryable: false,
        });
      },
      commit: async () => { throw new Error("Old candidate must not reach commit"); },
    },
    onTextDelta: (_text, candidate) => { contexts.push(candidate); },
  })).rejects.toMatchObject({ code: "task_update_driver_stale" });
  expect(contexts.length).toBeGreaterThan(0);
  expect(contexts.every(value => JSON.stringify(value) === JSON.stringify({ taskRevision: 0, expectedDriverGeneration: 0, acknowledgedRevision: 0 }))).toBeTrue();
});

test("unacknowledged stable final fails explicitly instead of spinning the production fence", async () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordTaskUpdateState(delivered);
  const browser = directBrowserFixture(async () => "Unacknowledged final answer");
  let attempts = 0;
  await expect(browser.run({
    externalProgress: progress,
    completionFence: {
      begin: async () => {
        attempts += 1;
        throw new ChatGptWebAdapterError("Task updates remain unacknowledged", {
          status: 409, errorType: "invalid_request_error", code: "task_update_unacknowledged", retryable: false,
        });
      },
      commit: async () => { throw new Error("Unacknowledged answer must not commit"); },
    },
    onTextDelta() {},
  })).rejects.toMatchObject({ code: "task_update_unacknowledged", retryable: false });
  expect(attempts).toBe(1);
});

for (const priorTaskProtocol of [0, 1, 2]) test(`older helper task capability tier ${priorTaskProtocol} opts out before execution`, async () => {
  const client = realHelperClient("");
  const internal = client as any;
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.handleLine(child, JSON.stringify({
    type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence", "native-tool-wait-v1",
      ...(priorTaskProtocol ? ["task-updates-v1"] : []), ...(priorTaskProtocol === 2 ? ["task-output-ack-v2"] : [])],
  }));
  let prepared = false;
  const sent: unknown[] = [];
  internal.send = async (message: unknown) => { sent.push(message); };
  expect(await client.supportsTaskUpdates()).toBeFalse();
  await expect(client.run({
    traceId: "enabled_old_helper", modelId: "gpt-5.6-sol", capabilities: {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
    },
    taskUpdateProtocol: 1, externalProgress: new ChatGptExternalTurnProgress(),
    prepare: async () => { prepared = true; return { text: "inspect", images: [], release() {} }; },
    completionFence: { begin: async () => 0, commit: async () => true }, onTextDelta() {},
  })).rejects.toMatchObject({ code: "task_update_protocol_missing", retryable: false });
  expect(prepared).toBeFalse();
  expect(sent).toEqual([]);
  internal.child = undefined;
});
