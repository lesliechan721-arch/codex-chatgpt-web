import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { suspensionTestClock } from "./helpers/suspension-test-clock";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityRecoveryIdentity } from "../src/adapters/chatgpt-web/continuity-contract";
import {
  assertLauncherContinuityCapacity, cancelLauncherManualTurn, CONTINUITY_EXECUTION_FENCING_FEATURE, CONTINUITY_PREPARATION_TERMINATION_FEATURE,
  endLauncherManualTurn, inspectLauncherContinuityConversation, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL,
  markLauncherContinuitySendPossible, markLauncherManualTurnStarted, notifyLauncherTurn, queryLauncherContinuityTransaction,
  releaseLauncherRetainedConversation, retireLauncherContinuityWriter, startLauncherManualTurn,
  terminateLauncherContinuityPreparation, updateLauncherContinuityPreparation, waitForLauncherManualSent, waitForLauncherManualTerminal,
} from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
const lease = { owner: "a".repeat(64), leaseId: "b".repeat(32), traceId: "retained-compaction-trace" };
const owner = { traceId: lease.traceId, helperPid: process.pid };
const key = "c".repeat(64);
const launcherInstance = { pid: process.pid, startIdentity: "verified-launcher-start", instanceId: "0".repeat(64) };
const recovery: ContinuityRecoveryIdentity = { schemaVersion: 2, installationId: "a".repeat(64), threadKey: key, epoch: 0,
  transactionId: "d".repeat(64), transactionVersion: 1, logicalWorkId: "e".repeat(64), attempt: 0,
  snapshotVersion: 1, snapshotDigest: "f".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "verified-owner-start" }, launcherInstance };
const previous = { ...recovery, transactionVersion: 0, snapshotVersion: 0 };
const recoveryLease = { ...lease, recovery };
const termination = { ...owner, requestId: "preparation-request", receiptId: "preparation-receipt", lease: recoveryLease };

function descriptorFile(endpoint: string) {
  const root = mkdtempSync(join(tmpdir(), "cgw-launcher-compaction-wait-")); roots.push(root);
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production",
    pid: process.pid, endpoint,
    control: { endpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: {},
    launcherInstance, features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE, CONTINUITY_PREPARATION_TERMINATION_FEATURE], createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return descriptor;
}

test("known compaction Launcher lease, acquisition and manual Sent HTTP waits exclude a real pause while ordinary waits expire", async () => {
  const arrived = deferred(), release = deferred(), releaseUnacknowledged = deferred();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    expect(Object.hasOwn(body, "compaction")).toBe(path === "/v1/manual/start");
    if (++requests === 18) arrived.resolve();
    if (body.traceId === "fixed-remaining") await releaseUnacknowledged.promise;
    else await release.promise;
    if (path === "/v1/turn/end") return Response.json({ cancelledByUser: false });
    if (path === "/v1/turn/release") return Response.json({ released: 1 });
    if (path === "/v1/turn/continuity-capacity") return Response.json({ ok: true, executionProtocol: 1, available: true });
    if (path === "/v1/turn/continuity-terminate-preparation") return Response.json({ ok: true,
      state: "preparation-terminated", recovery, ...owner, requestId: termination.requestId, receiptId: termination.receiptId, continuity: recoveryLease });
    if (path.startsWith("/v1/turn/continuity-")) {
      expect(body.recovery).toEqual(recovery);
      expect(body.recoveryStoreDirectory).toBe("/original/recovery-store");
      const action = path.split("-").at(-1);
      return Response.json({ ok: true, recovery, state: action === "retire" ? "retired" : "prepared",
        writerRetired: action === "retire", toolsSettled: false, executionProtocol: 1, launcherInstance, hostNoWriter: false,
        ...(action === "prepare" ? { preparationExpected: previous } : {}),
        ...(action === "possible" ? { sendAuthorized: true } : {}),
        ...(action === "retire" ? { executionIsolated: true, physicalCleanup: "pending" } : {}) });
    }
    if (path === "/v1/turn/start") return Response.json({ ok: true,
      surfaceId: "launcher_surface_id_0123456789AB", reused: true, connectorBound: true, continuity: lease });
    if (path === "/v1/manual/wait-sent") return Response.json({ ok: true, status: "sent", sentAt: new Date().toISOString() });
    if (path === "/v1/manual/start") return Response.json({ ok: true, tabId: "manual-tab", reused: true,
      deadlineAt: null, state: "sent", sentConfirmationRequired: true, continuity: lease });
    if (path === "/v1/manual/started" || path === "/v1/manual/cancel") return Response.json({ ok: true });
    if (path === "/v1/manual/end") return Response.json({ ok: true, cancelledByUser: false });
    if (path === "/v1/manual/wait-terminal") return Response.json({ ok: true, status: "cancelled" });
    return Response.json({ ok: true, continuity: lease, state: "ready" });
  } });
  const path = descriptorFile(`http://127.0.0.1:${server.port}`);
  const budget = new CompactionDeadline(Date.now() + 60_000);
  const before = chatGptSuspensionClock.suspendedMs();
  try {
    const pending = [
      inspectLauncherContinuityConversation(path, key, lease, { compaction: true }),
      notifyLauncherTurn(path, { ...owner, phase: "start", conversationKey: key,
        requireRetainedConversation: true, continuity: { owner: lease.owner, expected: lease } }, 5_000, undefined, { compaction: true }),
      waitForLauncherManualSent(path, owner, { timeoutMs: 5_000, compaction: true }),
      startLauncherManualTurn(path, { ...owner, prompt: "read-only handoff", sentConfirmationRequired: true,
        compaction: true, continuity: { owner: lease.owner, expected: lease } }, 5_000),
      markLauncherManualTurnStarted(path, owner, 5_000, { compaction: true }),
      inspectLauncherContinuityConversation(path, key, lease),
      waitForLauncherManualSent(path, owner, { timeoutMs: 5_000 }),
      queryLauncherContinuityTransaction(path, recovery, "/original/recovery-store", { compaction: true }),
      updateLauncherContinuityPreparation(path, { expected: previous, recovery }, "/original/recovery-store", { compaction: true }),
      markLauncherContinuitySendPossible(path, recovery, "/original/recovery-store", { compaction: true }),
      retireLauncherContinuityWriter(path, recovery, "/original/recovery-store", { compaction: true }),
      assertLauncherContinuityCapacity(path, { compaction: true }),
      terminateLauncherContinuityPreparation(path, recovery, "/original/recovery-store", termination, { compaction: true }),
      releaseLauncherRetainedConversation(path, key, 5_000, lease, { compaction: true }),
      cancelLauncherManualTurn(path, owner, 5_000, { compaction: true }),
      endLauncherManualTurn(path, { ...owner, status: "completed" }, 5_000, { compaction: true }),
      waitForLauncherManualTerminal(path, owner, { timeoutMs: 5_000, compaction: true }),
      notifyLauncherTurn(path, { ...owner, traceId: "fixed-remaining", phase: "end", status: "completed" }, 3_000, undefined, { compaction: true }),
    ].map(promise => promise.catch(error => error));
    await arrived.promise;
    await Bun.sleep(1_200); // Awake processing before the pause must remain charged.
    chatGptSuspensionClock.suspendedMs();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_100);
    const resumedAt = performance.now();
    await Bun.sleep(25); // Let overdue timeouts run before the real server replies.
    release.resolve();
    const results = await Promise.all(pending);
    expect(chatGptSuspensionClock.suspendedMs() - before).toBeGreaterThan(5_000);
    expect(budget.remainingMs()).toBeGreaterThan(50_000);
    expect(performance.now() - resumedAt).toBeLessThan(1_600);
    expect(results[17]).toBeInstanceOf(Error);
    expect(results[17].message).toContain("end timed out after 3000ms");
    expect(results[5]).toMatchObject({ code: "continuity_unverified" });
    expect(results[6]).toBeInstanceOf(Error);
    expect(results.slice(0, 5).filter(result => result instanceof Error)).toEqual([]);
    expect(results[0]).toEqual({ continuity: lease, state: "ready" });
    expect(results[1]).toMatchObject({ reused: true, continuity: lease });
    expect(results[2]).toMatchObject({ sentAt: expect.any(String) });
    expect(results[3]).toMatchObject({ tabId: "manual-tab", continuity: lease });
    expect(results[4]).toBeUndefined();
    expect(results.slice(7, 17).filter(result => result instanceof Error)).toEqual([]);
    expect(results[7]).toMatchObject({ recovery });
    expect(results[8]).toMatchObject({ preparationExpected: previous });
    expect(results[9]).toMatchObject({ sendAuthorized: true });
    expect(results[10]).toMatchObject({ writerRetired: true, executionIsolated: true });
    expect(results[11]).toBeUndefined();
    expect(results[12]).toEqual(recoveryLease);
    expect(results[13]).toBe(1);
    expect(results[14]).toBeUndefined();
    expect(results[15]).toEqual({ cancelledByUser: false });
    expect(results[16]).toEqual({ status: "cancelled" });
    expect(requests).toBe(18);
  } finally { release.resolve(); releaseUnacknowledged.resolve(); server.stop(true); }
}, 15_000);

function observeWatches() {
  const original = CompactionDeadline.prototype.watch;
  let active = 0;
  const budgets: number[] = [];
  const spy = spyOn(CompactionDeadline.prototype, "watch").mockImplementation(function(this: CompactionDeadline, expired) {
    budgets.push(this.remainingMs()); active++;
    const stop = original.call(this, expired);
    let stopped = false;
    return () => { if (!stopped) { stopped = true; active--; } stop(); };
  });
  return { budgets, active: () => active, restore: () => spy.mockRestore() };
}

test("compaction HTTP requests still expire while awake, keep mutation retries bounded, and stop every watch", async () => {
  const release = deferred(), arrived = deferred(), retried = deferred();
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    paths.push(new URL(request.url).pathname);
    if (paths.length === 6) arrived.resolve();
    if (paths.length === 7) retried.resolve();
    await release.promise;
    return Response.json({ ok: true });
  } });
  const path = descriptorFile(`http://127.0.0.1:${server.port}`);
  const time = suspensionTestClock();
  const watches = observeWatches(), startedAt = performance.now();
  try {
    let inspectionSettled = false;
    const pending = Promise.all([
      inspectLauncherContinuityConversation(path, key, lease, { compaction: true }) // Default five-second native-signal wrapper.
        .finally(() => { inspectionSettled = true; }),
      notifyLauncherTurn(path, { ...owner, phase: "end", status: "completed" }, 80, undefined, { compaction: true }),
      markLauncherManualTurnStarted(path, owner, 80, { compaction: true }), // Original maximum two mutation attempts.
      cancelLauncherManualTurn(path, owner, 80, { compaction: true }),
      releaseLauncherRetainedConversation(path, key, 80, lease, { compaction: true }),
      notifyLauncherTurn(path, { ...owner, phase: "end", status: "completed" }, 80, undefined, { compaction: false }),
    ].map(promise => promise.catch(error => error)));
    // Advance only after the real requests (and then the mutation retry) arrive.
    await arrived.promise;
    time.tick(80);
    await retried.promise;
    time.tick(4_919);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(inspectionSettled).toBe(false);
    time.tick(1);
    const results = await pending;
    expect(results.every(result => result instanceof Error)).toBeTrue();
    expect(results[0]).toMatchObject({ code: "continuity_unverified" });
    expect(results[1].message).toContain("end timed out after 80ms");
    expect(results[5].message).toContain("end timed out after 80ms");
    expect(performance.now() - startedAt).toBeCloseTo(5_000, 6);
    expect(paths.filter(path => path === "/v1/manual/started")).toHaveLength(2);
    expect(paths).toHaveLength(7);
    expect(watches.budgets).toHaveLength(6);
    expect(watches.active()).toBe(0);
  } finally { time.restore(); release.resolve(); server.stop(true); watches.restore(); }
}, 10_000);

test("caller cancellation stops compaction request watches without retrying acquisition or polling", async () => {
  const arrived = deferred(), release = deferred(), controller = new AbortController();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    if (++requests === 3) arrived.resolve();
    await release.promise;
    return Response.json({ ok: true });
  } });
  const path = descriptorFile(`http://127.0.0.1:${server.port}`), watches = observeWatches();
  try {
    const pending = [
      notifyLauncherTurn(path, { ...owner, phase: "start", continuity: { owner: lease.owner } }, undefined, controller.signal, { compaction: true }),
      waitForLauncherManualSent(path, owner, { abortSignal: controller.signal, compaction: true }),
      waitForLauncherManualTerminal(path, owner, { abortSignal: controller.signal, compaction: true }),
    ].map(promise => promise.catch(error => error));
    await arrived.promise;
    controller.abort();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ name: "AbortError" });
    expect(requests).toBe(3);
    expect(watches.budgets).toHaveLength(3);
    expect(watches.active()).toBe(0);
  } finally { controller.abort(); release.resolve(); server.stop(true); watches.restore(); }
});

test("compaction manual policy mismatch releases its original turn and stops both request watches", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, unknown>;
    requests.push(path);
    expect(body.traceId).toBe(owner.traceId);
    expect(body.helperPid).toBe(owner.helperPid);
    return Response.json(path === "/v1/manual/start" ? { ok: true, tabId: "manual-tab", reused: false,
      deadlineAt: null, state: "sent", sentConfirmationRequired: false }
      : { ok: true, cancelledByUser: false });
  } });
  const path = descriptorFile(`http://127.0.0.1:${server.port}`), watches = observeWatches();
  try {
    await expect(startLauncherManualTurn(path, { ...owner, prompt: "read-only handoff", compaction: true,
      sentConfirmationRequired: true })).rejects.toThrow("Sent confirmation policy does not match");
    expect(requests).toEqual(["/v1/manual/start", "/v1/manual/end"]);
    expect(watches.budgets).toHaveLength(2);
    expect(watches.active()).toBe(0);
  } finally { server.stop(true); watches.restore(); }
});

test("the real worker applies default 30s start and 15s end compaction waits without changing heartbeat or ordinary requests", async () => {
  const { ChatGptBrowserWorker } = await import("../src/adapters/chatgpt-web/browser-worker");
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    expect(Object.hasOwn(body, "compaction")).toBeFalse();
    return Response.json(body.phase === "start"
      ? { surfaceId: "s".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false });
  } });
  const path = descriptorFile(`http://127.0.0.1:${server.port}`), watches = observeWatches();
  try {
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: path },
      runBrowserTurn: async () => "one completed browser turn",
    });
    for (const compaction of [true, false]) await expect(worker.runExclusive({ ...owner,
      compaction, capabilities: { localToolsEnabled: false } })).resolves.toBe("one completed browser turn");
    expect(requests.map(body => body.phase)).toEqual(["start", "heartbeat", "end", "start", "heartbeat", "end"]);
    expect(watches.budgets).toHaveLength(2);
    expect(watches.budgets[0]).toBeGreaterThan(29_900);
    expect(watches.budgets[0]).toBeLessThanOrEqual(30_000);
    expect(watches.budgets[1]).toBeGreaterThan(14_900);
    expect(watches.budgets[1]).toBeLessThanOrEqual(15_000);
    expect(watches.active()).toBe(0);
  } finally { server.stop(true); watches.restore(); }
});
