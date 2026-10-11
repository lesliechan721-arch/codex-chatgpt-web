import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LAUNCHER_CONTEXT_DELIVERY_FEATURE,
  LauncherBrowserTurnCancelledError, LauncherManualTurnTimedOutError,
  inspectLauncherManualAttachments, startLauncherManualTurn, waitForLauncherManualAttachments,
} from "../src/launcher-browser-host";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
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
