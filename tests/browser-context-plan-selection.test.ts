import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const full = { planId: "full_plan", contextId: "context", manifestDigest: "a".repeat(64), requiredAttachments: [] };
const resume = { ...full, planId: "resume_plan" };
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "browser-context-plan-"));
  roots.push(root);
  const worker = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { appName: "Codex Native5", browserDiagnosticsPath: root } }) as any;
  const events: string[] = [];
  const reachedBrowser = new Error("browser acquisition reached");
  worker.runStage = async () => { events.push("browser"); throw reachedBrowser; };
  let releases = 0;
  const turn: BrowserTurn = { traceId: "single-process-context", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
    prepare: async () => { events.push("prepare-full"); return { text: "full", images: [], contextPlan: full, release() { releases++; } }; },
    prepareResume: async () => { events.push("prepare-resume"); return { text: "resume", images: [], contextPlan: resume, release() { releases++; } }; },
    onTextDelta() {} };
  return { worker, turn, events, reachedBrowser, releases: () => releases };
}

test("the direct worker awaits the actual full or resume plan before acquiring a page", async () => {
  for (const resumed of [false, true]) {
    const { worker, turn, events, reachedBrowser, releases } = fixture();
    let publish!: () => void;
    const publication = new Promise<void>(resolve => { publish = resolve; });
    let observed!: () => void;
    const selected = new Promise<void>(resolve => { observed = resolve; });
    turn.onContextPlanSelected = async planId => {
      expect(planId).toBe(resumed ? resume.planId : full.planId);
      events.push("selected"); observed(); await publication; events.push("published");
    };
    const result = worker.runBrowserTurn(turn, undefined, undefined, resumed).catch((error: Error) => error);
    await Promise.race([selected, result.then((error: Error) => { throw error; })]);
    expect(events).toEqual([resumed ? "prepare-resume" : "prepare-full", "selected"]);
    publish();
    expect(await result).toBe(reachedBrowser);
    expect(events).toEqual([resumed ? "prepare-resume" : "prepare-full", "selected", "published", "browser"]);
    expect(releases()).toBe(1);
  }
});

test("a direct navigation turn without a plan callback fails before browser or upload side effects", async () => {
  const { worker, turn, events, releases } = fixture();
  await expect(worker.runBrowserTurn(turn)).rejects.toMatchObject({ code: "codex_context_selection_required", retryable: false });
  expect(events).toEqual(["prepare-full"]);
  expect(releases()).toBe(1);
});

test("a rejected or cancelled direct plan selection cannot reach the browser", async () => {
  for (const cancelled of [false, true]) {
    const { worker, turn, events, releases } = fixture();
    const stop = new AbortController();
    turn.abortSignal = stop.signal;
    const rejection = new Error("plan publication failed");
    turn.onContextPlanSelected = async () => { if (cancelled) stop.abort(); else throw rejection; };
    const result = await worker.runBrowserTurn(turn).catch((error: Error) => error);
    if (cancelled) expect(result).toMatchObject({ name: "AbortError" });
    else expect(result).toBe(rejection);
    expect(events).toEqual(["prepare-full"]);
    expect(releases()).toBe(1);
  }
});

test("ordinary direct turns still reach browser preparation without a context plan callback", async () => {
  const { worker, turn, events, reachedBrowser, releases } = fixture();
  turn.prepare = async () => ({ text: "ordinary", images: [], release() { events.push("released"); } });
  await expect(worker.runBrowserTurn(turn)).rejects.toBe(reachedBrowser);
  expect(events).toEqual(["browser", "released"]);
  expect(releases()).toBe(0);
});

test("native compaction selects the public app but only requests its read-only context and instructed submission tools", async () => {
  for (const compaction of [false, true]) {
    const { worker, turn, events } = fixture();
    const reachedAttachment = new Error("prompt attachment captured");
    let submittedText = "";
    const page = Object.assign(new EventEmitter(), {
      isClosed: () => false, url: () => "https://chatgpt.com/",
      evaluate: async () => { throw new Error("No browser DOM in this fixture"); },
    });
    Object.assign(worker, {
      runStage: async (_trace: string, _stage: string, _timeout: number, run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal),
      prepareChatSurface: async () => {},
      selectModelAndEffort: async () => ({ effort: "low", localTools: true }),
      captureSubmissionBaseline: async () => ({}),
      attachPromptWithCompactionRetry: async (_page: unknown, text: string, localTools: boolean, actualCompaction: boolean) => {
        submittedText = text;
        expect(localTools).toBeTrue();
        expect(actualCompaction).toBe(compaction);
        throw reachedAttachment;
      },
    });
    turn.prepare = async () => ({ text: "source instructions", images: [], release() { events.push("released"); } });
    turn.nativeConnector = true;
    turn.compaction = compaction;
    await expect(worker.runBrowserTurn(turn, undefined, page)).rejects.toBe(reachedAttachment);
    expect(submittedText).toStartWith("source instructions\n");
    expect(submittedText).toContain('selected app "Codex Native5"');
    expect(submittedText).toContain("Do not use another Codex app or connector");
    if (compaction) {
      expect(submittedText).toContain("Use only the compaction read-only context tools");
      expect(submittedText).toContain("the submission entry specified in the current instructions");
      expect(submittedText).toContain("Do not call the business gateway");
      expect(submittedText).not.toContain("Use codex_tool_call");
    } else {
      expect(submittedText).toContain('Use codex_tool_call from the selected app "Codex Native5"');
    }
    expect(events).toEqual(["released"]);
  }
});

test("the direct Send path awaits its actual submission receipt and propagates a rejected receipt", async () => {
  for (const reject of [false, true]) {
    const { worker } = fixture();
    const events: string[] = [];
    const hidden: any = { filter: () => hidden, last: () => hidden, isVisible: async () => false };
    const page = { isClosed: () => false, locator: () => hidden };
    const send = { waitFor: async () => {}, isEnabled: async () => true, press: async () => { events.push("send"); } };
    worker.activeComposer = async () => ({ locator: () => ({ locator: () => send }) });
    worker.waitForSubmissionAcceptedWithRecovery = async () => { events.push("evidence"); return "user_turn"; };
    let acknowledge!: () => void;
    let rejectReceipt!: (reason: Error) => void;
    const receipt = new Promise<void>((resolve, fail) => { acknowledge = resolve; rejectReceipt = fail; });
    let observed!: () => void;
    const receiptObserved = new Promise<void>(resolve => { observed = resolve; });
    let settled = false;
    const rejection = new Error("direct submission receipt rejected");
    const outcome = worker.sendAttachedPrompt(page, {}, undefined, undefined, undefined, {
      onSubmitted: async () => { events.push("receipt"); observed(); await receipt; events.push("receipt-complete"); },
    }).catch((error: Error) => error).finally(() => { settled = true; });
    await receiptObserved;
    expect(events).toEqual(["send", "evidence", "receipt"]);
    expect(settled).toBeFalse();
    if (reject) rejectReceipt(rejection); else acknowledge();
    expect(await outcome).toBe(reject ? rejection : "user_turn");
    expect(events).toEqual(reject ? ["send", "evidence", "receipt"] : ["send", "evidence", "receipt", "receipt-complete"]);
  }
});
