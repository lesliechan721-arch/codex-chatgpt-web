import { expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";

function clockFixture() {
  let elapsed = 0, wall = 1_000_000;
  const clock = new ChatGptSuspensionClock(1_000, 5_000, () => elapsed, () => wall);
  const clockInterface = { start() {}, suspendedMs: () => clock.suspendedMs(), recentSuspension: () => clock.recentSuspension() };
  return { clock: clockInterface, now: () => wall, elapsedNow: () => elapsed,
    shiftWall(ms: number) { wall += ms; },
    sleep(ms: number) { elapsed += ms; wall += ms; },
    awake(ms: number) { while (ms > 0) { const step = Math.min(ms, 1_000); elapsed += step; wall += step; clock.tick(elapsed); ms -= step; } },
  };
}

test("active compaction budgets and child credentials ignore wall clock corrections", () => {
  const time = clockFixture();
  const elapsed = spyOn(performance, "now").mockImplementation(time.elapsedNow);
  try {
    const deadline = new CompactionDeadline(time.now() + 60_000, time.clock, time.now, undefined, time.elapsedNow);
    time.awake(10_000);
    expect(deadline.remainingMs()).toBe(50_000);
    time.shiftWall(-3_600_000);
    expect(deadline.remainingMs()).toBe(50_000);
    const child = new CompactionDeadline(deadline.deadlineAt, time.clock, time.now, undefined, time.elapsedNow);
    time.shiftWall(7_200_000);
    expect(deadline.remainingMs()).toBe(50_000);
    expect(child.remainingMs()).toBe(50_000);
    time.awake(50_000);
    expect(deadline.remainingMs()).toBe(0);
    time.shiftWall(-7_200_000);
    expect(deadline.remainingMs()).toBe(0);
  } finally { elapsed.mockRestore(); }
});

test("a fixed compaction budget excludes long suspension and expires after only its remaining awake time", () => {
  const time = clockFixture();
  const deadline = new CompactionDeadline(time.now() + 60_000, time.clock, time.now, undefined, time.elapsedNow);
  time.awake(10_000);
  expect(deadline.remainingMs()).toBe(50_000);
  time.sleep(601_000);
  expect(deadline.remainingMs()).toBe(49_000);
  expect(deadline.remainingMs()).toBe(49_000);
  time.awake(49_000);
  expect(deadline.remainingMs()).toBe(0);
  time.sleep(601_000);
  expect(deadline.remainingMs()).toBe(0);
});

test("source validity accounts for multiple suspensions before its next read", () => {
  const time = clockFixture();
  const deadline = new CompactionDeadline(time.now() + 60_000, time.clock, time.now, undefined, time.elapsedNow);
  time.sleep(601_000);
  time.clock.suspendedMs(); // The shared clock can be sampled by a different budget.
  time.awake(10_000);
  time.sleep(601_000);
  expect(deadline.remainingMs()).toBe(48_000);
});

test("suspension that starts after an unchecked deadline cannot revive it", () => {
  const time = clockFixture();
  const deadline = new CompactionDeadline(time.now() + 2_000, time.clock, time.now, undefined, time.elapsedNow);
  time.awake(3_000);
  time.sleep(601_000);
  expect(deadline.remainingMs()).toBe(0);
});

test("submission, cancellation and independent source validity retain their boundaries across suspension", async () => {
  const time = clockFixture();
  const spies = [spyOn(Date, "now").mockImplementation(time.now),
    spyOn(performance, "now").mockImplementation(time.elapsedNow),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(time.clock.suspendedMs),
    spyOn(chatGptSuspensionClock, "recentSuspension").mockImplementation(time.clock.recentSuspension)];
  const store = new CompactionTransactionStore();
  try {
    const transaction = store.begin("sleep-submission", 60_000);
    const revoked = store.begin("sleep-revoked", 60_000);
    store.abort(revoked.token);
    const cancelled = store.begin("sleep-cancelled", 60_000);
    const abort = new AbortController();
    const cancelledWait = store.wait(cancelled.token, abort.signal).catch(error => error);
    abort.abort();
    const parsed = { modelId: "gpt-5.6-sol", stream: false, options: {}, context: { messages: [{ role: "user" as const, content: "source", timestamp: 0 }] } };
    const snapshot = createContextSnapshot(parsed);
    const scope = new ContextScope("source", { snapshot, planId: "handoff", manifestDigest: "manifest", deliveryByTarget: {} },
      "compaction", () => {}, () => {}, time.now() + 30_000);
    const ordinary = new ContextScope("ordinary", { snapshot, planId: "normal", manifestDigest: "manifest", deliveryByTarget: {} },
      "normal", () => {}, () => {}, time.now() + 30_000);
    time.sleep(601_000);
    expect(store.isActive(transaction.token, transaction.handoffId)).toBeTrue();
    expect(scope.isLive).toBeTrue();
    expect(ordinary.isLive).toBeFalse();
    expect(store.isActive(revoked.token, revoked.handoffId)).toBeFalse();
    expect((await cancelledWait).name).toBe("AbortError");
    expect(store.isActive(cancelled.token, cancelled.handoffId)).toBeFalse();
    time.awake(29_000);
    expect(scope.isLive).toBeFalse();
    expect(store.isActive(transaction.token, transaction.handoffId)).toBeTrue();
    store.submit(transaction.token, transaction.handoffId, "one summary");
    expect(await store.wait(transaction.token)).toBe("one summary");
    expect(() => store.submit(transaction.token, transaction.handoffId, "again")).toThrow();
    const expired = store.begin("awake-expired", 2_000);
    time.awake(2_000);
    expect(() => store.submit(expired.token, expired.handoffId, "late")).toThrow("expired");
    await expect(store.wait(expired.token)).rejects.toThrow("expired");
    scope.retire(); ordinary.retire();
  } finally { store.close(); for (const spy of spies.reverse()) spy.mockRestore(); }
});

test("pending compaction source returns survive suspension while ordinary return settlement expires", () => {
  const time = clockFixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  const spies = [spyOn(Date, "now").mockImplementation(time.now),
    spyOn(performance, "now").mockImplementation(time.elapsedNow),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(time.clock.suspendedMs),
    spyOn(chatGptSuspensionClock, "recentSuspension").mockImplementation(time.clock.recentSuspension)];
  const snapshot = createContextSnapshot({ modelId: "gpt-5.6-sol", stream: false, options: {}, context: { messages: [] } });
  const scopes = ["compaction", "normal"].map(purpose => new ContextScope(purpose,
    { snapshot, planId: "plan", manifestDigest: "manifest", deliveryByTarget: {} }, purpose as "compaction" | "normal", () => {}, () => {}));
  try {
    for (const scope of scopes) scope.prepareBootstrapReturn({ source: true });
    time.sleep(601_000); mock.timers.tick(601_000);
    expect(scopes[0]!.inFlight).toBe(1);
    expect(scopes[1]!.inFlight).toBe(0);
    time.awake(89_000); mock.timers.tick(89_000);
    expect(scopes[0]!.inFlight).toBe(0);
  } finally { for (const scope of scopes) scope.retire(); for (const spy of spies.reverse()) spy.mockRestore(); mock.timers.reset(); }
});

test("broker timers pause explicit manual and native source credentials without extending an ordinary turn", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { defaultBrokerEndpoint } = await import("../src/config");
  const { TurnBroker } = await import("../src/adapters/chatgpt-web/turn-broker");
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-sleep-broker-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  await broker.listen();
  const time = clockFixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  const spies = [spyOn(Date, "now").mockImplementation(time.now),
    spyOn(performance, "now").mockImplementation(time.elapsedNow),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(time.clock.suspendedMs),
    spyOn(chatGptSuspensionClock, "recentSuspension").mockImplementation(time.clock.recentSuspension)];
  try {
    const authority = { authorityMode: "delegated" as const, threadId: "sleep-thread", turnId: "sleep-turn", tools: [] };
    const ordinary = await broker.registerSafe(authority, "ordinary-surface-1234567890", 60_000, "ordinary", { requireSentConfirmation: false });
    const manual = await broker.registerSafe(authority, "compaction-surface-1234567890", 60_000, "manual", { requireSentConfirmation: false });
    const snapshot = createContextSnapshot({ modelId: "gpt-5.6-sol", stream: false, options: {},
      context: { messages: [{ role: "user", content: "bounded source", timestamp: 0 }] } });
    const registration = { snapshot, historyRevision: 0, ownerGeneration: "page", expiresAt: time.now() + 60_000 };
    const safe = broker.registerCompactionContext({ ...registration, contract: "safe", explicitManual: true, turnToken: manual, handoffId: "manual:sleep" });
    const transaction = await broker.beginCompactionTransaction("native-sleep", 60_000);
    const native = broker.registerCompactionContext({ ...registration, contract: "native", transactionToken: transaction.token, handoffId: transaction.handoffId });
    broker.startSafeTurn(manual);
    broker.markCompactionContextDelivered(safe.compactionToken);
    broker.markCompactionContextDelivered(native.compactionToken);
    time.sleep(601_000); mock.timers.tick(601_000);
    expect(() => broker.startSafeTurn(ordinary)).toThrow("invalid");
    expect(() => broker.guardCompactionContextCommit(safe.compactionToken)).not.toThrow();
    expect(() => broker.guardCompactionContextCommit(native.compactionToken)).not.toThrow();
    time.awake(59_000); mock.timers.tick(59_000);
    expect(() => broker.startSafeTurn(manual)).toThrow("invalid");
    expect(() => broker.guardCompactionContextCommit(safe.compactionToken)).toThrow();
    expect(() => broker.guardCompactionContextCommit(native.compactionToken)).toThrow();
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore(); mock.timers.reset();
    await broker.close(); rmSync(directory, { recursive: true, force: true });
  }
});
