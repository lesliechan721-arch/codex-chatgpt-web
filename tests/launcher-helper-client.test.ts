import { selectedSkillFile } from "../src/adapters/chatgpt-web/skill-attachments";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { assertBrowserTurnExecutionAuthority, ChatGptBrowserWorker, dispatchBrowserTurnWithExecutionAuthority, resolveChatGptToolConfirmation } from "../src/adapters/chatgpt-web/browser-worker";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, getLauncherKnownUnsentReceipt, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityRecoveryIdentity } from "../src/adapters/chatgpt-web/continuity-contract";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryIdentity } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";

const roots: string[] = [];
const recovery: ContinuityRecoveryIdentity = { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64),
  epoch: 1, transactionId: "c".repeat(64), transactionVersion: 2, logicalWorkId: "d".repeat(64), attempt: 1,
  snapshotVersion: 2, snapshotDigest: "e".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "helper-test-instance" },
  launcherInstance: { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) } };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const boundary of ["response", "dom", "submit", "multipart", "observation-loop"] as const) for (const userClosed of [false, true]) {
  test(`repair6: real helper classifies ${boundary} physical page loss with user-close=${userClosed}`, async () => {
    let ended: Record<string, unknown> | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as Record<string, any>;
      if (body.phase === "start") return Response.json({ ok: true, executionProtocol: 1,
        surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: false,
        continuity: { owner: body.continuity.owner, leaseId: "1".repeat(32), traceId: body.traceId,
          recovery: body.continuity.recovery } });
      if (body.phase === "end") ended = body;
      return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, cancelledByUser: userClosed });
    } });
    const f = fencedHelperFixture(`
      const originalBrowserTurn = ChatGptBrowserWorker.prototype.runBrowserTurn;
      ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn, surface) {
        if (${JSON.stringify(boundary)} === "observation-loop") {
          const { EventEmitter } = await import("node:events");
          let closed = false;
          const page = Object.assign(new EventEmitter(), { isClosed: () => closed,
            url: () => "https://chatgpt.com/", evaluate: async () => { throw new Error("Fixture has no renderer"); } });
          this.captureSubmissionBaseline = async () => ({});
          this.waitForNewAssistantTurn = async () => { closed = true; return {}; };
          this.runStage = async (_trace, stage) => {
            if (stage === "browser_page") return page;
            if (stage === "effort_selection") return { effort: "low", localTools: false };
            if (stage === "send") { await turn.onSendActivated(); await turn.onSubmitted(); return "user_turn"; }
          };
          return originalBrowserTurn.call(this, turn, surface, page);
        }
        await turn.prepare();
        await turn.onSendActivated();
        await turn.onSubmitted();
        const page = { isClosed: () => true };
        if (${JSON.stringify(boundary)} === "dom") return this.responseDomSnapshot({
          evaluate: async () => { throw new Error("fixture renderer disconnected"); }, page: () => page,
        });
        if (${JSON.stringify(boundary)} === "submit") {
          this.activeComposer = async () => ({ locator: () => ({ locator: () => ({ waitFor: async () => {} }) }) });
          return this.sendAttachedPrompt(page, {});
        }
        if (${JSON.stringify(boundary)} === "multipart") return this.waitForMultipartAcknowledgement(page, {}, {}, "ACK");
        return this.waitForNewAssistantTurn(page, {}, Date.now() + 1000);
      };
    `, `http://127.0.0.1:${server.port}`);
    f.turn.modelId = "gpt-5.6-sol"; f.turn.reasoning = "low"; f.turn.modelFamily = "6";
    let submitted = 0;
    f.turn.onSendActivated = () => { f.store.markAttempt(f.thread, { scope: f.scope }, {
      logicalWorkId: "helper-work", attempt: 0, stage: "send-possible" }); };
    f.turn.onSubmitted = () => { submitted++; f.store.markAttempt(f.thread, { scope: f.scope }, {
      logicalWorkId: "helper-work", attempt: 0, stage: "accepted" }); };
    if (boundary === "dom") { f.turn.nativeConnector = true; f.turn.compaction = true; }
    try {
      await expect(f.client.run(f.turn)).rejects.toMatchObject({ code: userClosed ? "client_cancelled" : "continuity_session_lost" });
      expect(submitted).toBe(1);
      expect(ended?.status).toBe("failed");
      expect(f.store.get(f.thread)!.works["helper-work"]!.attempts).toHaveLength(1);
      expect(f.store.get(f.thread)!.works["helper-work"]!.attempts[0]!.stage).toBe("accepted");
    } finally { await f.client.close(); await server.stop(true); }
  }, 15_000);
}

test("repair6: non-task Launcher page loss keeps its existing cancellation contract", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    return Response.json(body.phase === "start" ? { ok: true, surfaceId: "launcher_surface_id_0123456789AB",
      reused: false, connectorBound: false } : { ok: true, cancelledByUser: false });
  } });
  const f = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
      await turn.prepare();
      return this.waitForNewAssistantTurn({ isClosed: () => true }, {}, Date.now() + 1000);
    };
  `, `http://127.0.0.1:${server.port}`);
  delete f.turn.continuity; delete f.turn.recoveryStoreDirectory;
  try { await expect(f.client.run(f.turn)).rejects.toMatchObject({ code: "client_cancelled" }); }
  finally { await f.client.close(); await server.stop(true); }
});

test("repair6: trusted Launcher start cancellation remains cancellation before preparation or Send", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    expect(body.phase).toBe("start");
    return Response.json({ ok: false, code: "turn_cancelled", error: "Fixture user cancelled this exact turn" }, { status: 409 });
  } });
  const f = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function() { throw new Error("Cancelled start cannot acquire the DOM"); };
  `, `http://127.0.0.1:${server.port}`);
  const before = f.store.get(f.thread);
  let prepared = 0, activated = 0;
  f.turn.prepare = async () => { prepared++; return { text: "unused", images: [], release() {} }; };
  f.turn.onSendActivated = () => { activated++; };
  try {
    await expect(f.client.run(f.turn)).rejects.toMatchObject({ code: "client_cancelled" });
    expect(prepared).toBe(0); expect(activated).toBe(0); expect(f.store.get(f.thread)).toEqual(before);
  } finally { await f.client.close(); await server.stop(true); }
});

function recoveryFixture(directory: string, pageReceiptId = "helper-page") {
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory);
  const thread = "b".repeat(64), scope = "a".repeat(64), owner = continuityProcessInstance("f".repeat(64));
  const instance = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "0".repeat(64) };
  store.admitWork({ thread, scope, owner, logicalWorkId: "helper-work", nativeTurnId: "helper-turn",
    instructionIdentity: "helper-instruction", workPayloadDigest: "d".repeat(64), snapshotDigest: "e".repeat(64),
    dispatchProtocolComplete: true, createPage: true });
  store.markAttempt(thread, { scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "page-possible", launcherInstance: instance });
  store.markAttempt(thread, { scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "page-acquired", pageReceiptId });
  return { store, thread, scope, recovery: recoveryIdentity(store.get(thread)!, store.installationId()) };
}

function fencedHelperFixture(source: string, endpoint = "http://127.0.0.1:39002", preparationTermination = false) {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-fencing-")); roots.push(root);
  const directory = join(root, "continuity");
  const durable = recoveryFixture(directory, preparationTermination ? "1".repeat(32) : undefined);
  const script = join(root, "helper.ts");
  writeFileSync(script, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ${source}
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production",
    pid: process.pid, endpoint, control: { endpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "owned-helper-target" }, createdAt: new Date().toISOString(),
    features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE,
      ...(preparationTermination ? ["preparation-termination-v1", "context-delivery-plan-v1"] : [])],
    launcherInstance: durable.recovery.launcherInstance,
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native5", browserHost: "launcher",
    browserHostDescriptorPath: descriptor, browserHelperScriptPath: script,
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: true });
  const turn: BrowserTurn = { traceId: "helper-fencing-trace", modelId: "gpt-6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    continuity: { owner: "f".repeat(64), recovery: durable.recovery }, recoveryStoreDirectory: directory,
    prepare: async () => ({ text: "bounded fixture", images: [], release() {} }),
    onSendActivated() {}, onTextDelta() {},
  };
  return { ...durable, directory, client, turn };
}

for (const failureStage of ["prepare", "plan-select"] as const) test(`a real helper ${failureStage} failure fences Send before aborted end and preserves its original error`, async () => {
  let ended: Record<string, unknown> | undefined, fenceAtEnd = false;
  let f: ReturnType<typeof fencedHelperFixture>;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>;
    if (body.phase === "start") return Response.json({ ok: true, executionProtocol: 1,
      surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: true,
      continuity: { owner: body.continuity.owner, leaseId: "1".repeat(32), traceId: body.traceId, recovery: body.continuity.recovery } });
    if (body.phase === "end") {
      ended = body;
      fenceAtEnd = Boolean(f.store.get(f.thread)!.works["helper-work"]!.attempts[0]!.preparationTermination);
    }
    return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, cancelledByUser: false });
  } });
  f = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
      await turn.prepare();
      await turn.onSendActivated();
      return "must never submit";
    };
  `, `http://127.0.0.1:${server.port}`, true);
  f.turn.recoveryRequestId = "preparation-helper-request";
  const original = new ChatGptWebAdapterError("Controlled local prompt preparation failure", {
    code: "CONTEXT_SOURCE_UNAVAILABLE", status: 422, errorType: "invalid_request_error", retryable: false,
  });
  let activated = 0;
  f.turn.prepare = failureStage === "prepare" ? async () => { throw original; }
    : async () => ({ text: "Prepared but unselected", images: [], contextPlan: { planId: "helper_plan", contextId: "helper_context",
      manifestDigest: "a".repeat(64), requiredAttachments: [] }, release() {} });
  if (failureStage === "plan-select") f.turn.onContextPlanSelected = async () => { throw original; };
  f.turn.onSendActivated = () => { activated++; };
  try {
    await expect(f.client.run(f.turn)).rejects.toBe(original);
    expect(activated).toBe(0); expect(ended?.status).toBe("aborted"); expect(fenceAtEnd).toBe(true);
    const attempt = f.store.get(f.thread)!.works["helper-work"]!.attempts[0]!;
    expect(attempt.writerRetired).toBe(true);
    expect(attempt.preparationTermination).toMatchObject({ status: "pending", traceId: f.turn.traceId,
      requestId: f.turn.recoveryRequestId, recovery: f.recovery });
    expect(() => f.store.withExecutionAuthority(f.recovery, () => "late ACK Send")).toThrow("obsolete");
  } finally { await f.client.close(); await server.stop(true); }
}, 15_000);

test("a live old helper rejects a delayed Send acknowledgement and retains possibly-sent evidence", async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      await turn.onSubmitted();
      return "obsolete answer";
    };
  `);
  let submitted = 0;
  fixture.turn.onSubmitted = () => { submitted++; };
  fixture.turn.onSendActivated = () => {
    fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, {
      logicalWorkId: "helper-work", attempt: 0, stage: "send-possible" });
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
  };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(submitted).toBe(0);
    const attempt = fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!;
    expect(attempt.writerRetired).toBe(true);
    expect(attempt.stage).toBe("send-possible");
    // The refusal comes from the live helper's journal read, not process retirement.
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { await fixture.client.close(); }
});

test("a live helper rejects a prepared frame after its execution generation is withdrawn", async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      return "obsolete preparation";
    };
  `);
  let activations = 0;
  fixture.turn.prepare = async () => {
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
    return { text: "late preparation", images: [], release() {} };
  };
  fixture.turn.onSendActivated = () => { activations++; };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(activations).toBe(0);
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { await fixture.client.close(); }
});

test("a delayed acquisition cannot prepare in a live helper after durable withdrawal", async () => {
  let fixture: ReturnType<typeof fencedHelperFixture>;
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    const body = await request.json() as { phase: string; continuity?: { owner: string }; traceId: string; recoveryStoreDirectory: string };
    expect(body.recoveryStoreDirectory).toBe(fixture.directory);
    if (body.phase === "start") {
      fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
      return Response.json({ ok: true, surfaceId: "s".repeat(32), reused: false, connectorBound: false,
        executionProtocol: 1, continuity: { owner: body.continuity!.owner, leaseId: "f".repeat(32), traceId: body.traceId, recovery: fixture.recovery } });
    }
    return Response.json({ ok: true, cancelledByUser: false, recovery: fixture.recovery, executionProtocol: 1 });
  } });
  fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) { return this.runExclusive(turn); };
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function() { throw new Error("obsolete browser preparation reached"); };
  `, `http://127.0.0.1:${server.port}`);
  let prepared = 0;
  fixture.turn.prepare = async () => { prepared++; return { text: "not acquired", images: [], release() {} }; };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(prepared).toBe(0);
    expect(requests).toBe(2); // acquisition and original-page release only
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { await fixture.client.close(); server.stop(true); }
});

test("physical Send rechecks the journal after activation acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-physical-send-fence-")); roots.push(root);
  const directory = join(root, "continuity");
  const fixture = recoveryFixture(directory);
  const turn = { continuity: { owner: "f".repeat(64), recovery: fixture.recovery }, recoveryStoreDirectory: directory };
  let presses = 0;
  const hidden = { filter() { return this; }, last() { return this; }, getByText() { return this; }, isVisible: async () => false };
  const button = { waitFor: async () => {}, isEnabled: async () => true, press: async () => { presses++; } };
  const composer = { locator: () => ({ locator: () => button }) };
  const worker = { activeComposer: async () => composer, waitForSubmissionAcceptedWithRecovery: async () => "user_turn" };
  const method = (ChatGptBrowserWorker.prototype as any).sendAttachedPrompt;
  await expect(method.call(worker, { isClosed: () => false, locator: () => hidden }, {}, undefined, undefined, undefined, {
    onSendActivated: async () => {
      fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "send-possible" });
      await Bun.sleep(1);
      fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
    },
    assertExecutionAuthority: () => assertBrowserTurnExecutionAuthority(turn),
    dispatchWithExecutionAuthority: <T>(dispatch: () => T) => dispatchBrowserTurnWithExecutionAuthority(turn, dispatch),
  })).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(presses).toBe(0);
  expect(fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!.stage).toBe("send-possible");
});

test("a delayed connector approval cannot use withdrawn execution authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-approval-fence-")); roots.push(root);
  const directory = join(root, "continuity");
  const fixture = recoveryFixture(directory);
  const turn = { continuity: { owner: "f".repeat(64), recovery: fixture.recovery }, recoveryStoreDirectory: directory };
  let approvals = 0;
  const allow = { filter() { return this; }, count: async () => 1,
    waitFor: async () => { fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0); },
    click: async () => { approvals++; } };
  const deny = { filter() { return this; }, count: async () => 1, waitFor: async () => {} };
  const dialog = { getByRole: (_role: string, options: { name: string | RegExp }) => options.name === "Deny" ? deny : allow };
  const dialogs = { filter() { return this; }, count: async () => 1, first: () => dialog };
  const page = { locator: () => dialogs, getByText() {} } as any;
  await expect(resolveChatGptToolConfirmation(page, "Codex Native5", true, undefined, undefined, undefined, undefined,
    dispatch => dispatchBrowserTurnWithExecutionAuthority(turn, dispatch))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(approvals).toBe(0);
});

test("late old helper output is refused while its original Send receipt remains accepted", async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      await turn.onSubmitted();
      turn.onTextDelta("obsolete stream");
      return "obsolete final";
    };
  `);
  let submitted = 0, deltas = 0;
  fixture.turn.onSendActivated = () => {
    fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "send-possible" });
  };
  fixture.turn.onSubmitted = () => {
    submitted++;
    fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "accepted" });
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
  };
  fixture.turn.onTextDelta = () => { deltas++; };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(submitted).toBe(1);
    expect(deltas).toBe(0);
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { await fixture.client.close(); }
});

test("a live helper settles its delayed original Send receipt after withdrawal and abort without publishing old output", async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      turn.onHeartbeat();
      await Bun.sleep(40);
      const receipt = turn.onSubmitted();
      // Transport replay remains bound to this run and must share its one settlement write.
      process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "submitted", recovery: turn.continuity.recovery }) + "\\n");
      await receipt;
      turn.onTextDelta("obsolete answer");
      return "obsolete final";
    };
  `);
  const controller = new AbortController();
  const authorizationId = "9".repeat(32);
  let submitted = 0, activations = 0, deltas = 0;
  fixture.turn.abortSignal = controller.signal;
  fixture.turn.onSendActivated = () => {
    activations++;
    fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, {
      logicalWorkId: "helper-work", attempt: 0, stage: "send-possible", sendAuthorizationId: authorizationId });
  };
  fixture.turn.onHeartbeat = () => {
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
    controller.abort();
  };
  fixture.turn.onSubmitted = async () => {
    submitted++;
    expect(controller.signal.aborted).toBe(true);
    await Bun.sleep(5);
    fixture.store.settleSendReceipt(fixture.thread, { scope: fixture.scope }, fixture.recovery, authorizationId);
  };
  fixture.turn.onTextDelta = () => { deltas++; };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    const attempt = fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!;
    expect(attempt.writerRetired).toBe(true);
    expect(attempt.sendEvidence?.status).toBe("accepted");
    expect(attempt.stage).toBe("accepted");
    expect(submitted).toBe(1);
    expect(activations).toBe(1);
    expect(deltas).toBe(0);
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { await fixture.client.close(); }
});

for (const kind of ["unacknowledged", "mismatched"] as const) test(`helper Send settlement rejects a ${kind} receipt`, async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      ${kind === "mismatched" ? "await turn.onSendActivated();" : ""}
      process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "submitted",
        recovery: ${kind === "mismatched" ? "{ ...turn.continuity.recovery, attempt: turn.continuity.recovery.attempt + 1 }" : "turn.continuity.recovery"} }) + "\\n");
      await Bun.sleep(20);
      throw new Error("bounded receipt fixture ended");
    };
  `);
  let submitted = 0;
  fixture.turn.onSendActivated = () => {
    fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, { logicalWorkId: "helper-work", attempt: 0, stage: "send-possible" });
  };
  fixture.turn.onSubmitted = () => { submitted++; };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toThrow();
    expect(submitted).toBe(0);
    expect(fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!.sendEvidence?.status).not.toBe("accepted");
  } finally { await fixture.client.close(); }
});

test("the real helper IPC preserves an exact authenticated automatic acquire unsent receipt", async () => {
  let fixture: ReturnType<typeof fencedHelperFixture>;
  const requestId = "automatic-capacity-request";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { traceId: string; helperPid: number; requestId: string };
    expect(body.requestId).toBe(requestId);
    return Response.json({ code: "continuity_resource_capacity", sendUnsentReceipt: {
      schemaVersion: 1, receiptId: "e".repeat(32), state: "known-unsent", recovery: fixture.recovery,
      launcherInstance: fixture.recovery.launcherInstance, traceId: body.traceId, helperPid: body.helperPid,
      requestId, executionProtocol: 1, sendState: "not-started",
    } }, { status: 409 });
  } });
  fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) { return this.runExclusive(turn); };
  `, `http://127.0.0.1:${server.port}`);
  fixture.turn.recoveryRequestId = requestId;
  try {
    const error = await fixture.client.run(fixture.turn).catch(error => error);
    expect(getLauncherKnownUnsentReceipt(error)).toMatchObject({ requestId, recovery: fixture.recovery, state: "known-unsent" });
  } finally { await fixture.client.close(); server.stop(true); }
});

test("daemon streams browser lifecycle through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const { recovery } = recoveryFixture(join(root, "continuity"));
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Substitute only the browser. Both sides of the production IPC protocol run unchanged.
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (this.config.useSavedChats !== true) throw new Error("Saved chat preference lost in helper IPC");
      if (turn.modelFamily !== "5.6") throw new Error("Pinned model family lost in helper IPC");
      if (JSON.stringify(turn.continuity.recovery) !== ${JSON.stringify(JSON.stringify(recovery))}) throw new Error("Recovery identity lost in helper IPC");
      turn.onContinuityLease({ owner: turn.continuity.owner, leaseId: "f".repeat(32), traceId: turn.traceId, recovery: turn.continuity.recovery });
      await turn.onPreparedSelected(false);
      const prepared = await turn.prepare();
      if (prepared.skillFiles?.[0]?.text !== "<skill>\\n<name>ipc</name>\\n<path>/skills/ipc/SKILL.md</path>\\ncheck IPC\\n</skill>") throw new Error("Skill file lost in IPC");
      if (prepared.multipart.parts.length !== 6) throw new Error("Multipart context was lost");
      for (let index = 1; index < prepared.multipart.parts.length; index++) {
        await turn.onMultipartStageAcknowledged?.(index);
      }
      // An old run can share a trace. Its late Send observation must not invoke the new hook.
      process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "send_activated",
        recovery: { ...turn.continuity.recovery, snapshotVersion: 1 } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "generation_progress",
        recovery: { ...turn.continuity.recovery, snapshotVersion: 1 } }) + "\\n");
      await turn.onSendActivated();
      const initial = turn.externalProgress.snapshot();
      if (initial.nativeWaiting?.activeOperations !== 1) throw new Error("Initial Native lease lost in IPC");
      const changed = turn.externalProgress.waitForChange(initial.revision, turn.abortSignal);
      turn.onSubmitted();
      const renewed = await changed;
      if (renewed.nativeWaiting?.sourceRevision !== 2 || renewed.lastProgressAt !== undefined
        || renewed.lastToolBatchRevision !== 0 || renewed.activeToolCalls !== 0) throw new Error("Waiting IPC fabricated Native progress");
      turn.onHeartbeat();
      turn.onGenerationProgress();
      turn.onReasoningSummary("Reading project");
      turn.onReasoningSummary(" files", true);
      turn.onTextDelta("done");
      if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint({
        answerHash: "a".repeat(64),
        checkpoint: {
          version: 1,
          objective: "Finish the helper test.",
          state: ["The answer streamed."],
          evidence: ["The helper emitted a checkpoint event."],
          decisions: [],
          pending: [],
        },
      });
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native5",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: true,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  const acknowledgedStages: number[] = [];
  let sendActivated = false;
  let activations = 0;
  let submitted = false;
  let heartbeats = 0;
  let generationProgress = 0;
  let released = false;
  const externalProgress = new ChatGptExternalTurnProgress();
  externalProgress.recordNativeWaiting({ revision: 1, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 });
  const client = new LauncherBrowserHelperClient(config);
  try {
    await client.assertContinuityCompatible(true);
    const result = await client.run({
      traceId: "abcdef123456",
      externalProgress,
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      modelFamily: "5.6",
      continuity: { owner: "f".repeat(64), recovery },
      recoveryStoreDirectory: join(root, "continuity"),
      onContinuityLease: lease => { expect(lease.recovery).toEqual(recovery); },
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({
        text: "inspect", images: [],
        skillFiles: [selectedSkillFile({ role: "user", origin: "codex_skill", timestamp: 0,
          content: "<skill>\n<name>ipc</name>\n<path>/skills/ipc/SKILL.md</path>\ncheck IPC\n</skill>",
        })],
        multipart: { parts: ["part one", "part two", "part three", "part four", "part five", "part six"], commit: "inspect" },
        release: () => { released = true; },
      }),
      onMultipartStageAcknowledged: stage => { acknowledgedStages.push(stage); },
      onSendActivated: async () => { await Bun.sleep(5); sendActivated = true; activations++; },
      onSubmitted: () => {
        submitted = true;
        externalProgress.recordNativeWaiting({ revision: 2, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 });
      },
      onHeartbeat: () => {
        heartbeats++;
        expect(externalProgress.snapshot().lastProgressAt).toBeUndefined();
      },
      onGenerationProgress: () => { generationProgress++; },
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(sendActivated).toBe(true);
    expect(activations).toBe(1);
    expect(submitted).toBe(true);
    expect(heartbeats).toBe(1);
    expect(generationProgress).toBe(1);
    expect(acknowledgedStages).toEqual([1, 2, 3, 4, 5]);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("a v2 helper rejects instance recovery before prompt preparation or IPC run dispatch", async () => {
  let prepared = 0;
  let dispatched = 0;
  const client = Object.assign(Object.create(LauncherBrowserHelperClient.prototype), {
    ensureChild: async () => {}, helperFeatures: new Set([CONTINUITY_FEATURE, "session-continuity-recovery-v2", "native-tool-wait-v1"]),
    send: async () => { dispatched++; },
  }) as LauncherBrowserHelperClient;
  await expect(client.run({ traceId: "legacy-recovery-helper", modelId: "gpt-6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false }, continuity: { owner: "f".repeat(64), recovery },
    prepare: async () => { prepared++; return { text: "never prepare", images: [], release() {} }; },
    onTextDelta() {},
  })).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(prepared).toBe(0);
  expect(dispatched).toBe(0);
  expect(CONTINUITY_RECOVERY_FEATURE).toBe("session-continuity-recovery-v4");
});

test("recovery feature alone cannot claim the live helper execution fencing capability", async () => {
  let dispatched = 0;
  const client = Object.assign(Object.create(LauncherBrowserHelperClient.prototype), {
    ensureChild: async () => {}, helperFeatures: new Set([CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, "native-tool-wait-v1"]),
    send: async () => { dispatched++; },
  }) as LauncherBrowserHelperClient;
  await expect(client.assertContinuityCompatible(true)).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(dispatched).toBe(0);
});

test("accepted compaction retires through the helper as completed without hiding cancellations or errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-compaction-end-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    const run = ChatGptBrowserWorker.prototype.run;
    ChatGptBrowserWorker.prototype.run = function(turn) {
      // Substitute the browser wait only. Actual worker catch/finally, IPC and launcher end run.
      this.runStage = async () => {
        const stopped = new Promise((resolve, reject) => {
          turn.abortSignal.addEventListener("abort", () => reject(
            turn.traceId === "compaction_real_failure"
              ? new Error("independent browser failure")
              : new DOMException("ChatGPT web turn aborted", "AbortError")
          ), { once: true });
        });
        turn.onSubmitted();
        return stopped;
      };
      return run.call(this, turn);
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const ended = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      if (body.phase === "start") return Response.json({
        ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: true, connectorBound: true,
      });
      if (body.phase === "end") ended.set(body.traceId as string, body);
      return Response.json({ ok: true, cancelledByUser: false });
    },
  });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native5", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper, browserDiagnosticsPath: join(root, "diagnostics"),
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: false,
  });
  const logs: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => { logs.push(args.join(" ")); });
  try {
    for (const [traceId, reason, status] of [
      ["compaction_accepted", new ChatGptCompactionHandoffAccepted(), "completed"],
      ["compaction_cancelled", new DOMException("user cancelled", "AbortError"), "aborted"],
      ["compaction_same_text", new DOMException("Structured compaction handoff accepted", "AbortError"), "aborted"],
      ["compaction_deadline", new Error("compaction deadline exceeded"), "aborted"],
      ["compaction_real_failure", new ChatGptCompactionHandoffAccepted(), "failed"],
    ] as const) {
      const controller = new AbortController();
      let released = false;
      const prepare = async () => ({ text: "checkpoint instruction", images: [], release: () => { released = true; } });
      await expect(client.run({
        traceId, modelId: "gpt-5.6-sol", reasoning: "high",
        capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        nativeConnector: true, conversationKey: "a".repeat(64), requireRetainedConversation: true,
        prepare, prepareResume: prepare, abortSignal: controller.signal,
        onSubmitted: () => { controller.abort(reason); }, onTextDelta() {},
      })).rejects.toThrow(traceId === "compaction_real_failure"
        ? "independent browser failure"
        : traceId === "compaction_accepted" ? "Structured compaction handoff accepted" : "ChatGPT web turn aborted");
      // Logical outcome is observed only after the real helper's launcher retirement handshake.
      expect(ended.get(traceId)?.status).toBe(status);
      expect(ended.get(traceId)?.retain).toBeUndefined();
      expect(released).toBeTrue();
    }
    await client.close();
    expect(logs.some(line => line.includes("compaction_accepted ended after accepted structured compaction handoff"))).toBeTrue();
    expect(logs.some(line => line.includes("compaction_accepted failed:"))).toBeFalse();
    for (const traceId of ["compaction_cancelled", "compaction_same_text", "compaction_deadline", "compaction_real_failure"]) {
      expect(logs.some(line => line.includes(`${traceId} failed:`))).toBeTrue();
    }
  } finally {
    await client.close();
    logger.mockRestore();
    await server.stop(true);
  }
});

test("an older helper rejects Native waiting before turn preparation or IPC dispatch", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native5", browserHost: "launcher", browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused.json", chromeExecutablePath: "/durable/chrome",
    headed: true, autoApproveToolCalls: false, useSavedChats: false,
  });
  const internal = client as unknown as {
    child: unknown;
    pending: Map<string, unknown>;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.handleLine(child, JSON.stringify({
    type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence"],
  }));
  const sent: unknown[] = [];
  internal.send = async message => { sent.push(message); };
  let prepared = false;
  await expect(client.run({
    traceId: "native-wait-old-helper", modelId: "gpt-5.6-sol", reasoning: "high",
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    externalProgress: new ChatGptExternalTurnProgress(),
    prepare: async () => {
      prepared = true;
      return { text: "inspect", images: [], release() {} };
    },
    onTextDelta() {},
  })).rejects.toMatchObject({
    status: 503, code: "codex_tool_upgrade_required", retryable: false,
  });
  expect(prepared).toBe(false);
  expect(sent).toEqual([]);
  expect(internal.pending.size).toBe(0);
});

test("launcher helper protocol preserves multipart context, broker identity and the compaction flag", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native5 DEV",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const internal = client as unknown as {
    pending: Map<string, { resolve(value: string): void }>;
    child?: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    finish(id: string): void;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.send = async message => {
    sent.push(message);
    if (typeof message.id !== "string") return;
    if (message.type === "run") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "event",
        id: message.id,
        event: "prepared_selected",
        reused: false,
      })));
    } else if (message.type === "prepared_selected_ack") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "result",
        id: message.id,
        text: "done",
      })));
    }
  };

  await expect(client.run({
    traceId: "multipart-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    compaction: true,
    prepare: async () => ({
      text: "commit",
      images: [],
      turnToken: "turn_0123456789abcdef0123456789abcdef",
      multipart: { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "commit" },
      trimmedCompactionMessages: 4,
      release() {},
    }),
    onTextDelta() {},
  })).resolves.toBe("done");

  expect(sent[0]).toMatchObject({
    type: "run",
    turn: {
      compaction: true,
    },
  });
  expect(sent[1]).toMatchObject({
    type: "prepared_selected_ack",
    prepared: {
        text: "commit",
        turnToken: "turn_0123456789abcdef0123456789abcdef",
        multipart: { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "commit" },
        trimmedCompactionMessages: 4,
    },
  });
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});

test("an older helper cannot silently drop selected skill files and releases the prepared turn", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native5", browserHost: "launcher", browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused.json", chromeExecutablePath: "/durable/chrome", headed: true, autoApproveToolCalls: false, useSavedChats: false,
  });
  const internal = client as unknown as {
    child: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  const sent: string[] = [];
  internal.send = async message => {
    sent.push(String(message.type));
    if (message.type === "run") queueMicrotask(() => internal.handleLine(child, JSON.stringify({
      type: "event", id: message.id, event: "prepared_selected", reused: false,
    })));
    if (message.type === "abort") queueMicrotask(() => internal.handleLine(child, JSON.stringify({
      type: "error", id: message.id, message: "aborted",
    })));
  };
  let released = false;
  await expect(client.run({
    traceId: "skill-old-helper", modelId: "gpt-5.6-sol", reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [],
      skillFiles: [selectedSkillFile({ role: "user", origin: "codex_skill", timestamp: 0,
        content: "<skill>\n<name>test</name>\n<path>/test</path>\ncheck\n</skill>",
      })],
      release() { released = true; },
    }),
    onTextDelta() {},
  })).rejects.toThrow("does not support skill attachments");
  expect(sent).toEqual(["run", "abort"]);
  expect(released).toBe(true);
});

function receiptDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test("a rejected old control frame waits for the real producer's first acknowledged Send receipt before its terminal", async () => {
  const fixture = fencedHelperFixture(`
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      turn.onHeartbeat();
      await Bun.sleep(40);
      await turn.onSubmitted();
      return "obsolete final";
    };
  `);
  const authorizationId = "9".repeat(32);
  let submitted = 0;
  fixture.turn.onSendActivated = () => { fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, {
    logicalWorkId: "helper-work", attempt: 0, stage: "send-possible", sendAuthorizationId: authorizationId }); };
  fixture.turn.onHeartbeat = () => {
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
    // Unlike abort, this delayed authenticated control must fail the helper's durable guard.
    void (fixture.client as unknown as { send(frame: unknown): Promise<void> }).send({ type: "send_activation_ack", id: fixture.turn.traceId });
  };
  fixture.turn.onSubmitted = () => {
    submitted++;
    fixture.store.settleSendReceipt(fixture.thread, { scope: fixture.scope }, fixture.recovery, authorizationId);
  };
  try {
    await expect(fixture.client.run(fixture.turn)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(submitted).toBe(1);
    expect(fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!.sendEvidence?.status).toBe("accepted");
  } finally { await fixture.client.close(); }
});

for (const rejectReceipt of [false, true]) test(`an observed original Send receipt may ${rejectReceipt ? "reject" : "settle"} after real helper failure without an old ACK or output`, async () => {
  const fixture = fencedHelperFixture(`
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 15000) return originalTimer(callback, delay, ...args);
      // Only accelerate the first submission receipt deadline.
      globalThis.setTimeout = originalTimer;
      return originalTimer(callback, 20, ...args);
    };
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      await turn.onSubmitted();
      turn.onTextDelta("obsolete text");
      return "obsolete final";
    };
  `);
  const submitted = receiptDeferred();
  const receipt = receiptDeferred();
  const callbackEnded = receiptDeferred();
  const stop = new AbortController();
  const authorizationId = "9".repeat(32);
  let callbacks = 0, releases = 0, deltas = 0;
  const sent: string[] = [];
  const internal = fixture.client as unknown as { send(frame: { type: string }): Promise<void> };
  const send = internal.send.bind(fixture.client);
  internal.send = async frame => { sent.push(frame.type); await send(frame); };
  fixture.turn.abortSignal = stop.signal;
  fixture.turn.prepare = async () => ({ text: "original", images: [], release() { releases++; } });
  fixture.turn.onSendActivated = () => { fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, {
    logicalWorkId: "helper-work", attempt: 0, stage: "send-possible", sendAuthorizationId: authorizationId }); };
  fixture.turn.onSubmitted = async () => {
    callbacks++;
    submitted.resolve();
    try {
      await receipt.promise;
      fixture.store.settleSendReceipt(fixture.thread, { scope: fixture.scope }, fixture.recovery, authorizationId);
    } finally { callbackEnded.resolve(); }
  };
  fixture.turn.onTextDelta = () => { deltas++; };
  try {
    const outcome = fixture.client.run(fixture.turn).catch(error => error);
    await submitted.promise;
    fixture.store.retireAttempt(fixture.thread, { scope: fixture.scope }, "helper-work", 0);
    stop.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(releases).toBe(1);
    expect(fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!.sendEvidence?.status).toBe("possible");
    if (rejectReceipt) receipt.reject(new Error("late original receipt failure")); else receipt.resolve();
    await callbackEnded.promise;
    await Bun.sleep(0);
    const attempt = fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!;
    expect(attempt.writerRetired).toBeTrue();
    expect(attempt.sendEvidence?.status).toBe(rejectReceipt ? "possible" : "accepted");
    expect(sent).not.toContain("submitted_ack");
    expect(callbacks).toBe(1);
    expect(releases).toBe(1);
    expect(deltas).toBe(0);
  } finally { receipt.resolve(); await fixture.client.close(); }
});

test("a helper rejects its first claimed submitted fact after confirmed watchdog retirement and keeps Send unknown", async () => {
  const workerReleased = receiptDeferred(), workerSettled = receiptDeferred(), started = receiptDeferred();
  let lateReceiptRejected = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/late-send") { await workerReleased.promise; return Response.json({ ok: true }); }
    if (path === "/test/settled") {
      lateReceiptRejected = (await request.json() as { lateReceiptRejected: boolean }).lateReceiptRejected;
      workerSettled.resolve();
      return Response.json({ ok: true });
    }
    const body = await request.json() as Record<string, unknown>;
    expect(body.phase).toBe("end");
    // Releasing a turn can take longer than the accelerated watchdog interval.
    await Bun.sleep(50);
    return Response.json({ ok: true, cancelledByUser: false, executionProtocol: 1, recovery: body.recovery });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const fixture = fencedHelperFixture(`
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 15000) return originalTimer(callback, delay, ...args);
      // Only accelerate the abort watchdog; keep the release request's timeout.
      globalThis.setTimeout = originalTimer;
      return originalTimer(callback, 20, ...args);
    };
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      turn.onHeartbeat();
      await fetch(${JSON.stringify(endpoint + "/test/late-send")});
      let lateReceiptRejected = false;
      try { await turn.onSubmitted(); } catch { lateReceiptRejected = true; }
      await fetch(${JSON.stringify(endpoint + "/test/settled")}, {
        method: "POST", body: JSON.stringify({ lateReceiptRejected }),
      });
      return "unobserved old answer";
    };
  `, endpoint);
  const stop = new AbortController();
  let callbacks = 0, deltas = 0;
  fixture.turn.abortSignal = stop.signal;
  fixture.turn.onHeartbeat = () => { started.resolve(); };
  fixture.turn.onSendActivated = () => { fixture.store.markAttempt(fixture.thread, { scope: fixture.scope }, {
    logicalWorkId: "helper-work", attempt: 0, stage: "send-possible", sendAuthorizationId: "9".repeat(32) }); };
  fixture.turn.onSubmitted = () => { callbacks++; };
  fixture.turn.onTextDelta = () => { deltas++; };
  try {
    const outcome = fixture.client.run(fixture.turn).catch(error => error);
    await started.promise;
    stop.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    workerReleased.resolve();
    await workerSettled.promise;
    expect(lateReceiptRejected).toBeTrue();
    expect(callbacks).toBe(0);
    expect(deltas).toBe(0);
    expect(fixture.store.get(fixture.thread)!.works["helper-work"]!.attempts[0]!.sendEvidence?.status).toBe("possible");
    await expect(fixture.client.assertContinuityCompatible(true)).resolves.toBeUndefined();
  } finally { workerReleased.resolve(); await fixture.client.close(); server.stop(true); }
});
