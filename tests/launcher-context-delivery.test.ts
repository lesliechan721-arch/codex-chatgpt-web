import { afterEach, expect, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LAUNCHER_CONTEXT_DELIVERY_FEATURE,
  LauncherBrowserTurnCancelledError, LauncherManualTurnTimedOutError,
  inspectLauncherManualAttachments, startLauncherManualTurn, waitForLauncherManualAttachments,
} from "../src/launcher-browser-host";
import { LAUNCHER_SUBMISSION_RECEIPT_TIMEOUT_MS, LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { validateBrowserHelperContextPlan } from "../src/adapters/chatgpt-web/browser-helper-prompt-selection";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const full = { planId: "plan_full", contextId: "context_1", manifestDigest: "a".repeat(64), requiredAttachments: [{ id: "image_1", label: "用户消息 1，图片 1" }] };
const resume = { ...full, planId: "plan_resume", requiredAttachments: [] };
const owner = { traceId: "context_launcher", helperPid: process.pid, planId: full.planId, manifestDigest: full.manifestDigest };

function descriptor(endpoint: string, features = [LAUNCHER_CONTEXT_DELIVERY_FEATURE], helperSource = "process.exit(99)") {
  const root = mkdtempSync(join(tmpdir(), "launcher-context-delivery-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, helperSource);
  const file = join(root, "launcher.json");
  writeFileSync(file, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, features, profile: "production", pid: process.pid,
    endpoint, control: { endpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return { file, helper, config: { appName: "Codex Native5", browserHost: "launcher", browserHostDescriptorPath: file,
    browserHelperScriptPath: helper, storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: false } satisfies ResolvedBrowserConfig };
}

test("a host without plan capability receives no reduced manual prompt", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({}); } });
  try {
    const { file } = descriptor(`http://127.0.0.1:${server.port}`, []);
    await expect(startLauncherManualTurn(file, { ...owner, prompt: "reduced text", sentConfirmationRequired: true, contextPlans: { full } }))
      .rejects.toThrow("does not support context delivery plans");
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});

test("manual plan acknowledgement is explicit and an unknown plan releases the turn", async () => {
  const routes: string[] = [];
  let selectedPlanId = resume.planId;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    routes.push(path);
    if (path.endsWith("/end")) return Response.json({ ok: true, cancelledByUser: false });
    const body = await request.json() as Record<string, unknown>;
    expect(body.contextPlans).toEqual({ full, resume });
    return Response.json({ ok: true, tabId: "manual-tab", reused: true, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      state: "awaiting-user", sentConfirmationRequired: true, selectedPlanId });
  } });
  try {
    const { file } = descriptor(`http://127.0.0.1:${server.port}`);
    const activity = { ...owner, prompt: "full", resumePrompt: "resume", sentConfirmationRequired: true, contextPlans: { full, resume } };
    expect((await startLauncherManualTurn(file, activity)).selectedPlanId).toBe(resume.planId);
    selectedPlanId = "unknown";
    await expect(startLauncherManualTurn(file, activity)).rejects.toThrow("invalid manual turn lease");
    expect(routes.slice(1)).toEqual(["/v1/manual/start", "/v1/manual/start", "/v1/manual/end"]);
  } finally { server.stop(true); }
});

test("attachment observation preserves independent user attestation and rejects an unrelated manifest", async () => {
  let observations = 0;
  let wrong = false;
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(await request.json()).toEqual(owner);
    const pending = observations++ < 2;
    return Response.json({ ok: true, planId: full.planId, manifestDigest: wrong ? "b".repeat(64) : full.manifestDigest,
      requiredCount: 1, status: pending ? "pending" : "user_attested", attestedAt: pending ? null : new Date().toISOString(),
      deadlineAt: pending ? deadlineAt : null }, { status: new URL(request.url).pathname.endsWith("wait-attachments") && pending ? 202 : 200 });
  } });
  try {
    const { file } = descriptor(`http://127.0.0.1:${server.port}`);
    const result = await waitForLauncherManualAttachments(file, owner);
    expect(result).toMatchObject({ planId: full.planId, requiredCount: 1, status: "user_attested", deadlineAt: null });
    expect("verified" in result).toBe(false);
    wrong = true;
    await expect(inspectLauncherManualAttachments(file, owner)).rejects.toThrow("invalid attachment attestation");
  } finally { server.stop(true); }
});

test("media observers have timeout and cancellation exits", async () => {
  for (const timedOut of [true, false]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return Response.json({ error: "ended", code: timedOut ? "manual_turn_timed_out" : "turn_cancelled" }, { status: timedOut ? 408 : 409 });
    } });
    try {
      const { file } = descriptor(`http://127.0.0.1:${server.port}`);
      const result = await waitForLauncherManualAttachments(file, owner).catch(error => error);
      expect(result).toBeInstanceOf(timedOut ? LauncherManualTurnTimedOutError : LauncherBrowserTurnCancelledError);
      const stop = new AbortController(); stop.abort();
      await expect(inspectLauncherManualAttachments(file, owner, { abortSignal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    } finally { server.stop(true); }
  }
});

test("helper plan validation bounds locating labels and rejects duplicated attachment IDs", () => {
  expect(() => validateBrowserHelperContextPlan(full)).not.toThrow();
  expect(() => validateBrowserHelperContextPlan({ ...full, requiredAttachments: [...full.requiredAttachments, ...full.requiredAttachments] })).toThrow("invalid");
  expect(() => validateBrowserHelperContextPlan({ ...full, requiredAttachments: [{ id: "image", label: "x".repeat(201) }] })).toThrow("invalid");
});

test("the real helper protocol returns the selected plan before Send and preserves the resume candidate", async () => {
  const helperSource = `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(true);
      const prepared = await turn.prepareResume();
      if (prepared.contextPlan.planId !== "plan_resume" || prepared.text !== "resume text") throw new Error("wrong plan");
      // Exercise the worker's local hook: it validates the finished IPC receipt, without
      // invoking the daemon's publication callback a second time.
      await turn.onContextPlanSelected(prepared.contextPlan.planId);
      try {
        await turn.onContextPlanSelected("unselected_plan");
        throw new Error("the helper accepted an unselected plan");
      } catch (error) {
        if (!error.message.includes("unacknowledged context plan")) throw error;
      }
      await turn.onSendActivated();
      await turn.onSubmitted();
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `;
  const { config } = descriptor("http://127.0.0.1:39001", [LAUNCHER_CONTEXT_DELIVERY_FEATURE], helperSource);
  const client = new LauncherBrowserHelperClient(config);
  const events: string[] = [];
  let releaseCount = 0;
  try {
    await expect(client.run({ traceId: "real-plan-selection", modelId: "gpt-6-sol", capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => { throw new Error("full was not selected"); },
      prepareResume: async () => ({ text: "resume text", images: [], contextPlan: resume, release() { releaseCount++; } }),
      onPreparedSelected: reused => { expect(reused).toBe(true); events.push("prepared"); },
      onContextPlanSelected: async planId => { expect(planId).toBe(resume.planId); await Promise.resolve(); events.push("selected"); },
      onSendActivated: () => { expect(events).toEqual(["prepared", "selected"]); events.push("send"); },
      onSubmitted: () => { events.push("submitted"); }, onTextDelta() {},
    })).resolves.toBe("done");
    expect(events).toEqual(["prepared", "selected", "send", "submitted"]);
    expect(releaseCount).toBe(1);
  } finally { await client.close(); }
});

test("old helpers and mismatched plan receipts never receive a Send acknowledgement", async () => {
  for (const old of [true, false]) {
    const { config } = descriptor("http://127.0.0.1:39001");
    const client = new LauncherBrowserHelperClient(config);
    const internal = client as unknown as { child: unknown; helperFeatures: Set<string>; ensureChild(): Promise<void>;
      send(message: Record<string, unknown>): Promise<void>; handleLine(child: unknown, line: string): void };
    const child = {};
    internal.child = child;
    internal.ensureChild = async () => {};
    internal.helperFeatures = new Set(old ? [] : [LAUNCHER_CONTEXT_DELIVERY_FEATURE]);
    const sent: Record<string, unknown>[] = [];
    internal.send = async message => {
      sent.push(message);
      const frame = message.type === "run" ? { type: "event", id: message.id, event: "prepared_selected", reused: false }
        : message.type === "prepared_selected_ack" ? { type: "event", id: message.id, event: "context_plan_selected", planId: "wrong_plan" }
        : message.type === "abort" ? { type: "error", id: message.id, message: "aborted" } : undefined;
      if (frame) queueMicrotask(() => internal.handleLine(child, JSON.stringify(frame)));
    };
    let released = false;
    const turn: BrowserTurn = { traceId: "reject-context-plan", modelId: "gpt-6-sol", capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "reduced", images: [], contextPlan: full, release() { released = true; } }), onTextDelta() {} };
    await expect(client.run(turn)).rejects.toThrow(old ? "does not support context delivery plans" : "unknown or mismatched context plan");
    expect(sent.map(item => item.type)).toEqual(old ? ["run", "abort"] : ["run", "prepared_selected_ack", "abort"]);
    expect(released).toBe(true);
  }
});

test("cancellation during selected-plan publication prevents its acknowledgement and Send", async () => {
  const { config } = descriptor("http://127.0.0.1:39001");
  const client = new LauncherBrowserHelperClient(config);
  const internal = client as unknown as { child: unknown; helperFeatures: Set<string>; ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>; handleLine(child: unknown, line: string): void };
  const child = {};
  const stop = new AbortController();
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.helperFeatures = new Set([LAUNCHER_CONTEXT_DELIVERY_FEATURE]);
  const sent: string[] = [];
  internal.send = async message => {
    sent.push(String(message.type));
    const frame = message.type === "run" ? { type: "event", id: message.id, event: "prepared_selected", reused: false }
      : message.type === "prepared_selected_ack" ? { type: "event", id: message.id, event: "context_plan_selected", planId: full.planId }
      : message.type === "abort" ? { type: "error", id: message.id, name: "AbortError", message: "aborted" } : undefined;
    if (frame) queueMicrotask(() => internal.handleLine(child, JSON.stringify(frame)));
  };
  let released = false;
  await expect(client.run({ traceId: "cancel-plan-publication", modelId: "gpt-6-sol", abortSignal: stop.signal,
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "reduced", images: [], contextPlan: full, release() { released = true; } }),
    onContextPlanSelected: () => { stop.abort(); }, onTextDelta() {},
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).toEqual(["run", "prepared_selected_ack", "abort"]);
  expect(released).toBe(true);
});

test("the helper terminates a stalled selected-plan acknowledgement before exposing the prompt", async () => {
  const helperSource = `
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === 15000 ? 10 : delay, ...args);
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      return "should not send";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `;
  const { config } = descriptor("http://127.0.0.1:39001", [LAUNCHER_CONTEXT_DELIVERY_FEATURE], helperSource);
  const client = new LauncherBrowserHelperClient(config);
  let sent = false;
  let released = false;
  try {
    await expect(client.run({ traceId: "stalled-plan-ack", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "reduced", images: [], contextPlan: full, release() { released = true; } }),
      onContextPlanSelected: () => new Promise<void>(() => {}), onSendActivated: () => { sent = true; }, onTextDelta() {},
    })).rejects.toThrow("context plan acknowledgement timed out");
    expect(sent).toBe(false);
    expect(released).toBe(true);
  } finally { await client.close(); }
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const receiptWorkerSource = `
  import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
  // Keep actual Launcher acquisition and terminal release; substitute only the browser work.
  ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
    await turn.prepare();
    await turn.onSendActivated();
    await turn.onSubmitted();
    turn.onTextDelta("done");
    return "done";
  };
  await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
`;

test("the real helper waits for a delayed receipt before output, success and Launcher retirement", async () => {
  const received = deferred();
  const receipt = deferred();
  const ended: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    if (body.phase === "start") return Response.json({ ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: false });
    if (body.phase === "end") ended.push(body.status as string);
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  const { config } = descriptor(`http://127.0.0.1:${server.port}`, [LAUNCHER_CONTEXT_DELIVERY_FEATURE], receiptWorkerSource);
  const client = new LauncherBrowserHelperClient(config);
  let released = false;
  let settled = false;
  const deltas: string[] = [];
  try {
    const result = client.run({ traceId: "delayed_submission_receipt", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary full prompt", images: [], release() { released = true; } }),
      onSubmitted: async () => { received.resolve(); await receipt.promise; }, onTextDelta: text => { deltas.push(text); },
    }).finally(() => { settled = true; });
    await received.promise;
    await Bun.sleep(20);
    expect(settled).toBeFalse();
    expect(released).toBeFalse();
    expect(deltas).toEqual([]);
    expect(ended).toEqual([]);
    receipt.resolve();
    await expect(result).resolves.toBe("done");
    expect(deltas).toEqual(["done"]);
    expect(ended).toEqual(["completed"]);
    expect(released).toBeTrue();
  } finally { receipt.resolve(); await client.close(); server.stop(true); }
});

test("a rejected receipt aborts the real helper and waits for physical Launcher retirement", async () => {
  const received = deferred();
  const receipt = deferred();
  const endReceived = deferred<Record<string, unknown>>();
  const endReleased = deferred();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    if (body.phase === "start") return Response.json({ ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: false });
    if (body.phase === "end") { endReceived.resolve(body); await endReleased.promise; }
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  const { config } = descriptor(`http://127.0.0.1:${server.port}`, [LAUNCHER_CONTEXT_DELIVERY_FEATURE], receiptWorkerSource);
  const client = new LauncherBrowserHelperClient(config);
  let released = false;
  let settled = false;
  const rejection = new Error("submission receipt persistence failed");
  const deltas: string[] = [];
  try {
    const outcome = client.run({ traceId: "rejected_submission_receipt", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary full prompt", images: [], release() { released = true; } }),
      onSubmitted: async () => { received.resolve(); await receipt.promise; }, onTextDelta: text => { deltas.push(text); },
    }).catch(error => error).finally(() => { settled = true; });
    await received.promise;
    receipt.reject(rejection);
    expect((await endReceived.promise).status).toBe("aborted");
    expect(settled).toBeFalse();
    expect(released).toBeFalse();
    expect(deltas).toEqual([]);
    endReleased.resolve();
    expect(await outcome).toBe(rejection);
    expect(released).toBeTrue();
  } finally { endReleased.resolve(); await client.close(); server.stop(true); }
});

test("a stalled submission receipt has a finite exit through real Launcher failure retirement", async () => {
  const ended: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    if (body.phase === "start") return Response.json({ ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: false });
    if (body.phase === "end") ended.push(body.status as string);
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  const acceleratedSource = `
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === 15000 ? 20 : delay, ...args);
    ${receiptWorkerSource}
  `;
  const { config } = descriptor(`http://127.0.0.1:${server.port}`, [LAUNCHER_CONTEXT_DELIVERY_FEATURE], acceleratedSource);
  const client = new LauncherBrowserHelperClient(config);
  let released = false;
  try {
    await expect(client.run({ traceId: "stalled_submission_receipt", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary full prompt", images: [], release() { released = true; } }),
      onSubmitted: () => new Promise<void>(() => {}), onTextDelta() {},
    })).rejects.toThrow("submission receipt acknowledgement timed out");
    expect(ended).toEqual(["failed"]);
    expect(released).toBeTrue();
  } finally { await client.close(); server.stop(true); }
});

test("an older real helper cannot finish ahead of a delayed or rejected local receipt", async () => {
  const legacySource = `
    import { createInterface } from "node:readline";
    const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
    emit({ type: "ready", features: [] });
    createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "run") emit({ type: "event", id: message.id, event: "prepared_selected", reused: false });
      if (message.type === "prepared_selected_ack") {
        emit({ type: "event", id: message.id, event: "submitted" });
        emit({ type: "result", id: message.id, text: "legacy result" });
      }
      if (message.type === "shutdown") process.exit(0);
    });
  `;
  for (const reject of [false, true]) {
    const { config } = descriptor("http://127.0.0.1:39001", [], legacySource);
    const client = new LauncherBrowserHelperClient(config);
    const received = deferred();
    const receipt = deferred();
    const rejection = new Error("legacy receipt rejected");
    let settled = false;
    let released = false;
    try {
      const outcome = client.run({ traceId: `legacy_receipt_${reject}`, modelId: "gpt-6-sol",
        capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        prepare: async () => ({ text: "ordinary", images: [], release() { released = true; } }),
        onSubmitted: async () => { received.resolve(); await receipt.promise; }, onTextDelta() {},
      }).catch(error => error).finally(() => { settled = true; });
      await received.promise;
      await Bun.sleep(20);
      expect(settled).toBeFalse();
      expect(released).toBeFalse();
      if (reject) receipt.reject(rejection); else receipt.resolve();
      expect(await outcome).toBe(reject ? rejection : "legacy result");
      expect(released).toBeTrue();
    } finally { receipt.resolve(); await client.close(); }
  }
});

const terminalReceiptSource = `
  import { createInterface } from "node:readline";
  const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "ready", features: ["submission-receipt-ack-v1"] });
  createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.type === "run") emit({ type: "event", id: message.id, event: "prepared_selected", reused: false });
    if (message.type === "prepared_selected_ack") emit({ type: "event", id: message.id, event: "submitted" });
    if (message.type === "test_result") emit({ type: "result", id: message.id, text: "legacy result" });
    if (message.type === "test_failure") emit({ type: "error", id: message.id, message: "physical turn ended" });
    if (message.type === "test_exit") process.exit(17);
    if (message.type === "abort") emit({ type: "error", id: message.id, name: "AbortError", message: "physical turn aborted" });
    if (message.type === "shutdown") process.exit(0);
  });
`;

test("a legacy successful terminal has a finite receipt deadline and never treats timeout as success", async () => {
  const { config } = descriptor("http://127.0.0.1:39001", [], terminalReceiptSource);
  const client = new LauncherBrowserHelperClient(config);
  const received = deferred();
  const receipt = deferred();
  let releases = 0;
  const internal = client as unknown as { send(message: Record<string, unknown>): Promise<void>; pending: Map<string, unknown> };
  const originalTimer = globalThis.setTimeout;
  let restoreTimer: (() => void) | undefined;
  try {
    const outcome = client.run({ traceId: "legacy_stalled_terminal", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }),
      onSubmitted: async () => { received.resolve(); await receipt.promise; }, onTextDelta() {},
    }).catch(error => error);
    await received.promise;
    // Ready has already completed. Accelerate only the parent's fixed receipt deadline.
    const acceleratedTimer = (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
      if (args[1] === LAUNCHER_SUBMISSION_RECEIPT_TIMEOUT_MS) args[1] = 20;
      return originalTimer(...args);
    };
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(acceleratedTimer as typeof setTimeout);
    restoreTimer = () => timer.mockRestore();
    await internal.send({ type: "test_result", id: "legacy_stalled_terminal" });
    expect(await outcome).toMatchObject({ message: "Launcher browser helper submission receipt persistence timed out" });
    expect(releases).toBe(1);
    expect(internal.pending.size).toBe(0);
    receipt.resolve();
    await Promise.resolve();
    expect(releases).toBe(1);
  } finally { restoreTimer?.(); receipt.resolve(); await client.close(); }
});

for (const terminal of ["failure", "abort", "exit"] as const) {
  for (const rejectReceipt of [false, true]) {
    test(`a ${terminal} terminal does not wait for its observed receipt and ignores a late ${rejectReceipt ? "rejection" : "resolution"}`, async () => {
      const endReceived = deferred();
      const endReleased = deferred();
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        if (body.phase === "end") { endReceived.resolve(); await endReleased.promise; }
        return Response.json({ ok: true, cancelledByUser: false });
      } });
      const { config } = descriptor(`http://127.0.0.1:${server.port}`, [], terminalReceiptSource);
      const client = new LauncherBrowserHelperClient(config);
      const received = deferred();
      const callbackEnded = deferred();
      const receipt = deferred();
      const stop = new AbortController();
      const traceId = `terminal_${terminal}_${rejectReceipt}`;
      const sent: string[] = [];
      let settled = false, releases = 0, callbacks = 0, deltas = 0;
      const internal = client as unknown as { send(message: Record<string, unknown>): Promise<void>; pending: Map<string, unknown> };
      const send = internal.send.bind(client);
      internal.send = async message => { sent.push(String(message.type)); await send(message); };
      try {
        const outcome = client.run({ traceId, modelId: "gpt-6-sol", abortSignal: stop.signal,
          capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
          prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }),
          onSubmitted: async () => { callbacks++; received.resolve(); try { await receipt.promise; } finally { callbackEnded.resolve(); } },
          onTextDelta() { deltas++; },
        }).catch(error => error).finally(() => { settled = true; });
        await received.promise;
        if (terminal === "abort") stop.abort();
        else await internal.send({ type: terminal === "exit" ? "test_exit" : "test_failure", id: traceId });
        if (terminal === "exit") {
          await endReceived.promise;
          expect(settled).toBeFalse();
          expect(releases).toBe(0);
          endReleased.resolve();
        }
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(releases).toBe(1);
        expect(internal.pending.size).toBe(0);
        if (rejectReceipt) receipt.reject(new Error("late persistence rejection")); else receipt.resolve();
        await callbackEnded.promise;
        await Bun.sleep(0);
        expect(callbacks).toBe(1);
        expect(sent).not.toContain("submitted_ack");
        expect(releases).toBe(1);
        expect(deltas).toBe(0);
      } finally { endReleased.resolve(); receipt.resolve(); await client.close(); server.stop(true); }
    });
  }
}

test("explicit abort after a legacy successful terminal ends receipt waiting immediately", async () => {
  const { config } = descriptor("http://127.0.0.1:39001", [], terminalReceiptSource);
  const client = new LauncherBrowserHelperClient(config);
  const received = deferred();
  const stop = new AbortController();
  let released = false;
  const internal = client as unknown as { send(message: Record<string, unknown>): Promise<void> };
  try {
    const outcome = client.run({ traceId: "legacy_result_abort", modelId: "gpt-6-sol", abortSignal: stop.signal,
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary", images: [], release() { released = true; } }),
      onSubmitted: () => { received.resolve(); return new Promise<void>(() => {}); }, onTextDelta() {},
    }).catch(error => error);
    await received.promise;
    await internal.send({ type: "test_result", id: "legacy_result_abort" });
    // Wait for the terminal frame, rather than for a guessed transport delay.
    const pending = (client as unknown as { pending: Map<string, { terminalReceived?: boolean }> }).pending;
    while (!pending.get("legacy_result_abort")?.terminalReceived) await Bun.sleep(0);
    stop.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(released).toBeTrue();
  } finally { await client.close(); }
});

test("a late old receipt cannot acknowledge or finish a new run that reuses the trace", async () => {
  const { config } = descriptor("http://127.0.0.1:39001", [], terminalReceiptSource);
  const client = new LauncherBrowserHelperClient(config);
  const oldReceived = deferred(), oldReceipt = deferred(), oldEnded = deferred();
  const nextReceived = deferred(), nextReceipt = deferred();
  let releases = 0;
  const sent: string[] = [];
  const internal = client as unknown as { send(message: Record<string, unknown>): Promise<void> };
  const send = internal.send.bind(client);
  internal.send = async message => { sent.push(String(message.type)); await send(message); };
  const traceId = "reused_receipt_trace";
  const base: BrowserTurn = { traceId, modelId: "gpt-6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }), onTextDelta() {},
  };
  try {
    const oldOutcome = client.run({ ...base, onSubmitted: async () => {
      oldReceived.resolve(); await oldReceipt.promise; oldEnded.resolve();
    } }).catch(error => error);
    await oldReceived.promise;
    await internal.send({ type: "test_failure", id: traceId });
    expect(await oldOutcome).toBeInstanceOf(Error);
    let nextSettled = false;
    const nextOutcome = client.run({ ...base, onSubmitted: async () => { nextReceived.resolve(); await nextReceipt.promise; } })
      .finally(() => { nextSettled = true; });
    await nextReceived.promise;
    oldReceipt.resolve();
    await oldEnded.promise;
    await Bun.sleep(0);
    expect(sent.filter(type => type === "submitted_ack")).toHaveLength(0);
    expect(nextSettled).toBeFalse();
    expect(releases).toBe(1);
    nextReceipt.resolve();
    await Bun.sleep(0);
    expect(sent.filter(type => type === "submitted_ack")).toHaveLength(1);
    await internal.send({ type: "test_result", id: traceId });
    expect(await nextOutcome).toBe("legacy result");
    expect(releases).toBe(2);
  } finally { oldReceipt.resolve(); nextReceipt.resolve(); await client.close(); }
});

for (const fragmentProtocol of [false, true]) for (const failCleanup of [false, true]) test(`a real helper retires only the aborted run and ${failCleanup ? "reports failed cleanup" : "holds resources until cleanup"}${fragmentProtocol ? " with fragmented protocol" : ""}`, async () => {
  const endReceived = deferred(), endReleased = deferred(), workerReleased = deferred(), workerSettled = deferred();
  const started = deferred();
  let endpoint: string;
  const ended: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/worker-gate") { await workerReleased.promise; return Response.json({ ok: true }); }
    if (path === "/test/worker-settled") { workerSettled.resolve(); return Response.json({ ok: true }); }
    const body = await request.json() as Record<string, unknown>;
    if (body.phase === "end") {
      ended.push(body.traceId as string); endReceived.resolve(); await endReleased.promise;
      if (failCleanup) return Response.json({ error: "physical release failed" }, { status: 500 });
    }
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  endpoint = `http://127.0.0.1:${server.port}`;
  const source = `
    const originalTimer = globalThis.setTimeout;
    // This fixture has no context-plan or submission-receipt timers. Its first
    // 15s timer is the abort watchdog; leave the later HTTP cleanup deadline intact.
    let shortenedWatchdog = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000 && !shortenedWatchdog) {
        shortenedWatchdog = true;
        return originalTimer(callback, 20, ...args);
      }
      return originalTimer(callback, delay, ...args);
    };
    ${fragmentProtocol ? `
    const originalWrite = process.stdout.write.bind(process.stdout);
    let outputTail = Promise.resolve();
    process.stdout.write = (chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      const line = String(chunk);
      outputTail = outputTail.then(async () => {
        for (let offset = 0; offset < line.length; offset += 17) {
          await new Promise((resolve, reject) => originalWrite(line.slice(offset, offset + 17), error => error ? reject(error) : resolve()));
          await new Promise(resolve => originalTimer(resolve, 1));
        }
        done?.();
      });
      void outputTail.catch(error => done?.(error));
      return true;
    };
    ` : ""}
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      if (turn.traceId === "ignored_abort_worker") {
        turn.onHeartbeat();
        await fetch(${JSON.stringify(endpoint + "/test/worker-gate")});
        await fetch(${JSON.stringify(endpoint + "/test/worker-settled")});
        return "old worker ignored abort";
      }
      return "other run remains healthy";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `;
  const { config } = descriptor(endpoint, [], source);
  const client = new LauncherBrowserHelperClient(config);
  const stop = new AbortController();
  let releases = 0, settled = false;
  // Keep stage failures inside the test, before Bun's outer timeout kills the
  // process and hides which pipe or retirement boundary stopped progressing.
  const frames: string[] = [];
  const record = (frame: string) => { frames.push(frame); if (frames.length > 24) frames.shift(); };
  const internal = client as unknown as {
    child?: ChildProcessWithoutNullStreams;
    pending: Map<string, { preparing?: boolean; prepared?: unknown; terminalReceived?: boolean; retirement?: Promise<void> }>;
    unfinishedAborts: Map<string, unknown>;
    send(message: { type?: string; id?: string }): Promise<void>;
    sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  if (fragmentProtocol) {
    // Pipe chunks need not align with JSON frames. Queue complete frames so the
    // delayed chunks preserve the transport's normal write order in both directions.
    let inputTail = Promise.resolve();
    internal.sendTo = (child, message) => {
      const encoded = `${JSON.stringify(message)}\n`;
      const next = inputTail.then(async () => {
        for (let offset = 0; offset < encoded.length; offset += 64) {
          await new Promise<void>((resolve, reject) => child.stdin.write(encoded.slice(offset, offset + 64), error => error ? reject(error) : resolve()));
          await Bun.sleep(1);
        }
      });
      inputTail = next.catch(() => {});
      return next;
    };
  }
  const send = internal.send.bind(client);
  internal.send = async message => {
    const frame = `${message.type}:${message.id ?? "helper"}`;
    record(`write-start:${frame}`);
    try { await send(message); record(`write-complete:${frame}`); }
    catch (error) { record(`write-failed:${frame}`); throw error; }
  };
  const handleLine = internal.handleLine.bind(client);
  internal.handleLine = (child, line) => {
    try {
      const frame = JSON.parse(line) as { type: string; id?: string; event?: string };
      record(`read:${frame.type}:${frame.id ?? "helper"}${frame.event ? `:${frame.event}` : ""}`);
    } catch { record("read:invalid-json"); }
    handleLine(child, line);
  };
  const withinStage = async <T>(name: string, operation: Promise<T>): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const child = internal.child;
        const state = {
          child: child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
            killed: child.killed, inputDestroyed: child.stdin.destroyed, inputEnded: child.stdin.writableEnded,
            inputBufferedBytes: child.stdin.writableLength } : null,
          pending: [...internal.pending].map(([id, turn]) => ({ id, preparing: Boolean(turn.preparing),
            prepared: Boolean(turn.prepared), terminalReceived: Boolean(turn.terminalReceived), retiring: Boolean(turn.retirement) })),
          unfinishedAborts: internal.unfinishedAborts.size, releases, settled, ended,
        };
        reject(new Error(`Helper retirement stage '${name}' stalled for 5000ms; state=${JSON.stringify(state)}; frames=${JSON.stringify(frames)}`));
      }, 5_000);
    });
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); }
  };
  const base: BrowserTurn = { traceId: "ignored_abort_worker", modelId: "gpt-6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }), onTextDelta() {},
  };
  try {
    const outcome = client.run({ ...base, abortSignal: stop.signal, onHeartbeat() { started.resolve(); } })
      .catch(error => error).finally(() => { settled = true; });
    await withinStage("aborted worker prepared and started", started.promise);
    stop.abort();
    await withinStage("watchdog target cleanup started", endReceived.promise);
    expect(settled).toBeFalse();
    expect(releases).toBe(0);
    // Let the underlying worker settle while its watchdog target-end is still blocked.
    workerReleased.resolve();
    await withinStage("aborted worker reached settlement", workerSettled.promise);
    expect(await withinStage("healthy sibling during cleanup", client.run({ ...base, traceId: "healthy_sibling_worker" })))
      .toBe("other run remains healthy");
    expect(settled).toBeFalse();
    expect(releases).toBe(1);
    endReleased.resolve();
    const error = await withinStage("target cleanup and aborted terminal", outcome);
    expect(error).toBeInstanceOf(Error);
    if (failCleanup) expect(error.message).toContain("could not release the aborted turn");
    else expect(error.name).toBe("AbortError");
    expect(releases).toBe(2);
    expect(ended).toEqual(["ignored_abort_worker"]);
    // The already settled worker must not leave a tombstone or affect later runs.
    expect(await withinStage("healthy run after retirement", client.run({ ...base, traceId: "healthy_after_retirement" })))
      .toBe("other run remains healthy");
  } finally { workerReleased.resolve(); endReleased.resolve(); await client.close(); server.stop(true); }
});

test("an ignored legacy abort uses target cleanup, keeps a bounded trace quarantine and leaves other runs alive", async () => {
  const ended: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    expect(body.phase).toBe("end");
    ended.push(body.traceId as string);
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  const ignoredAbortSource = terminalReceiptSource.replace(/    if \(message.type === "abort"\).*\n/, "");
  const { config } = descriptor(`http://127.0.0.1:${server.port}`, [], ignoredAbortSource);
  const client = new LauncherBrowserHelperClient(config);
  const internal = client as unknown as { send(frame: Record<string, unknown>): Promise<void>; unfinishedAborts: Map<string, unknown> };
  const originalTimer = globalThis.setTimeout;
  let timer: ReturnType<typeof spyOn> | undefined;
  const base: BrowserTurn = { traceId: "legacy_abort_initial", modelId: "gpt-6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "ordinary", images: [], release() {} }), onTextDelta() {},
  };
  try {
    const received = deferred();
    const stop = new AbortController();
    const first = client.run({ ...base, abortSignal: stop.signal,
      onSubmitted: () => { received.resolve(); return new Promise<void>(() => {}); },
    }).catch(error => error);
    await received.promise;
    const abortWithFastWatchdog = (controller: AbortController) => {
      timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 15_000) args[1] = 20;
        return originalTimer(...args);
      }) as typeof setTimeout);
      try { controller.abort(); }
      finally { timer.mockRestore(); }
    };
    abortWithFastWatchdog(stop);
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(internal.unfinishedAborts.size).toBe(1);
    for (let index = 1; index < 5; index++) {
      const observed = deferred();
      const controller = new AbortController();
      const outcome = client.run({ ...base, traceId: `legacy_abort_${index}`, abortSignal: controller.signal,
        onSubmitted: () => { observed.resolve(); return new Promise<void>(() => {}); },
      }).catch(error => error);
      await observed.promise;
      abortWithFastWatchdog(controller);
      expect(await outcome).toMatchObject({ name: "AbortError" });
    }
    expect(internal.unfinishedAborts.size).toBe(5);
    await expect(client.run({ ...base, traceId: "quarantine_capacity" })).rejects.toThrow("unfinished aborted turn");
    await expect(client.run(base)).rejects.toThrow("unfinished aborted turn");
    expect(ended).toHaveLength(5);
    await internal.send({ type: "test_failure", id: base.traceId });
    while (internal.unfinishedAborts.size === 5) await Bun.sleep(0);
    const nextReceived = deferred();
    const healthy = client.run({ ...base, traceId: "legacy_healthy_after_abort", onSubmitted() { nextReceived.resolve(); } });
    await nextReceived.promise;
    await internal.send({ type: "test_result", id: "legacy_healthy_after_abort" });
    expect(await healthy).toBe("legacy result");
    expect(internal.unfinishedAborts.size).toBe(4);
  } finally { timer?.mockRestore(); await client.close(); server.stop(true); }
});

test("helper exit cleanup has its own finite control deadline and never waits for a receipt", async () => {
  const endReceived = deferred();
  const endReleased = deferred();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    expect(body.phase).toBe("end");
    endReceived.resolve();
    await endReleased.promise;
    return Response.json({ ok: true, cancelledByUser: false });
  } });
  const { config } = descriptor(`http://127.0.0.1:${server.port}`, [], terminalReceiptSource);
  const client = new LauncherBrowserHelperClient(config);
  const received = deferred();
  let released = false;
  const internal = client as unknown as { send(frame: Record<string, unknown>): Promise<void> };
  const originalTimer = globalThis.setTimeout;
  let timer: ReturnType<typeof spyOn> | undefined;
  try {
    const outcome = client.run({ traceId: "exit_cleanup_deadline", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary", images: [], release() { released = true; } }),
      onSubmitted: () => { received.resolve(); return new Promise<void>(() => {}); }, onTextDelta() {},
    }).catch(error => error);
    await received.promise;
    timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 15_000) args[1] = 20;
      return originalTimer(...args);
    }) as typeof setTimeout);
    await internal.send({ type: "test_exit", id: "exit_cleanup_deadline" });
    await endReceived.promise;
    expect(released).toBeFalse();
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.some((failure: Error) => failure.message.includes("timed out after 15000ms"))).toBeTrue();
    expect(released).toBeTrue();
  } finally { timer?.mockRestore(); endReleased.resolve(); await client.close(); server.stop(true); }
});

for (const earlyText of [false, true]) test(`a helper ${earlyText ? "text and result" : "result"} without its required submitted frame fails and cannot adopt a first late receipt`, async () => {
  const source = terminalReceiptSource.replace(
    'if (message.type === "prepared_selected_ack") emit({ type: "event", id: message.id, event: "submitted" });',
    `if (message.type === "prepared_selected_ack") {
      ${earlyText ? 'emit({ type: "event", id: message.id, event: "text", text: "unproven text" });' : ""}
      emit({ type: "result", id: message.id, text: "unproven success" });
    }`,
  ).replace(
    'if (message.type === "test_result") emit({ type: "result", id: message.id, text: "legacy result" });',
    'if (message.type === "test_result") emit({ type: "event", id: message.id, event: "submitted" });',
  );
  const { config } = descriptor("http://127.0.0.1:39001", [], source);
  const client = new LauncherBrowserHelperClient(config);
  let callbacks = 0, releases = 0, outputs = 0;
  const internal = client as unknown as { send(frame: Record<string, unknown>): Promise<void>; pending: Map<string, unknown> };
  try {
    await expect(client.run({ traceId: "missing_required_receipt", modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }),
      onSubmitted() { callbacks++; }, onTextDelta() { outputs++; },
    })).rejects.toThrow(earlyText ? "published output before submission receipt persistence" : "completed without a submission receipt");
    await internal.send({ type: "test_result", id: "missing_required_receipt" });
    // The old frame is received through the real child, with no run left to authorize it.
    await Bun.sleep(0);
    expect(callbacks).toBe(0);
    expect(outputs).toBe(0);
    expect(releases).toBe(1);
    expect(internal.pending.size).toBe(0);
  } finally { await client.close(); }
});

for (const event of ["text", "completion_fence_begin"] as const) test(`legacy ${event} cannot cross a stalled submission receipt`, async () => {
  const source = terminalReceiptSource.replace(
    'if (message.type === "test_result") emit({ type: "result", id: message.id, text: "legacy result" });',
    `if (message.type === "test_result") emit({ type: "event", id: message.id, event: ${JSON.stringify(event)}, text: "premature output", requestId: 1 });`,
  );
  const { config } = descriptor("http://127.0.0.1:39001", [], source);
  const client = new LauncherBrowserHelperClient(config);
  const received = deferred(), receipt = deferred();
  let outputs = 0, fences = 0, releases = 0;
  const internal = client as unknown as { send(frame: Record<string, unknown>): Promise<void> };
  try {
    const outcome = client.run({ traceId: `receipt_barrier_${event}`, modelId: "gpt-6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "ordinary", images: [], release() { releases++; } }),
      onSubmitted: async () => { received.resolve(); await receipt.promise; }, onTextDelta() { outputs++; },
      completionFence: { async begin() { fences++; return 0; }, async commit() { fences++; return true; } },
    }).catch(error => error);
    await received.promise;
    await internal.send({ type: "test_result", id: `receipt_barrier_${event}` });
    expect(await outcome).toMatchObject({ message: "Launcher browser helper published output before submission receipt persistence" });
    expect(outputs).toBe(0);
    expect(fences).toBe(0);
    expect(releases).toBe(1);
  } finally { receipt.resolve(); await client.close(); }
});
