import { expect, test } from "bun:test";
import { ChatGptSuspensionClock, chatGptExternalProgressSuppressesDomHealth } from "../src/adapters/chatgpt-web/browser-worker";
import {
  ChatGptExternalTurnProgress, ChatGptMirroredTurnProgress,
  chatGptExternalToolCallsAreInFlight, chatGptNativeWaitingLeaseIsLive,
} from "../src/adapters/chatgpt-web/turn-progress";
import { NativeTurnIdleRegistry } from "../src/native-turn-idle";

test("a current waiting lease suppresses the eleven-minute DOM stall without fabricating tool or business progress", () => {
  const progress = new ChatGptExternalTurnProgress();
  const batch = progress.recordToolBatch(1, 1_000);
  progress.recordNativeWaiting({ revision: 1, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 }, 661_000);
  const snapshot = progress.snapshot();
  expect(snapshot).toMatchObject({ lastProgressAt: 1_000, lastToolBatchRevision: batch, activeToolCalls: 1 });
  expect(chatGptExternalProgressSuppressesDomHealth(snapshot, 661_000)).toBe(true);
  expect(chatGptExternalProgressSuppressesDomHealth(snapshot, 780_999)).toBe(true);
  expect(chatGptExternalProgressSuppressesDomHealth(snapshot, 781_000)).toBe(false);
  progress.recordNativeWaiting({ revision: 2, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 }, 721_000);
  expect(progress.snapshot().lastProgressAt).toBe(1_000);
  expect(progress.snapshot().lastToolBatchRevision).toBe(batch);
});

test("waiting-only IPC revisions are valid without tool batches and a stale proof cannot extend its lease", () => {
  const progress = new ChatGptExternalTurnProgress();
  const mirror = new ChatGptMirroredTurnProgress();
  progress.recordNativeWaiting({ revision: 1, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 }, 1_000);
  const snapshot = progress.snapshot();
  expect(snapshot.lastProgressAt).toBeUndefined();
  expect(snapshot.lastToolBatchRevision).toBe(0);
  expect(snapshot.activeToolCalls).toBe(0);
  expect(mirror.apply(snapshot)).toBe(true);
  expect(chatGptExternalToolCallsAreInFlight(mirror.snapshot())).toBe(true);
  expect(mirror.apply(snapshot)).toBe(false);
  expect(() => mirror.apply({
    ...snapshot, revision: snapshot.revision + 1,
    nativeWaiting: { ...snapshot.nativeWaiting!, observedAt: 2_000, expiresAt: 122_000 },
  })).toThrow();
  expect(() => mirror.apply({ ...snapshot, revision: snapshot.revision + 1, nativeWaiting: undefined })).toThrow();
  progress.recordNativeWaiting({ revision: 2, activeOperations: 0, unreadResults: 1, remainingMs: 119_000 }, 2_000);
  expect(mirror.apply(progress.snapshot())).toBe(true);
  expect(chatGptExternalToolCallsAreInFlight(mirror.snapshot())).toBe(true);
  progress.recordNativeWaiting({ revision: 3, activeOperations: 0, unreadResults: 0, remainingMs: 0 }, 3_000);
  expect(mirror.apply(progress.snapshot())).toBe(true);
  expect(chatGptExternalToolCallsAreInFlight(mirror.snapshot())).toBe(false);
});

test("system resume allows one short proof-recovery grace, not indefinite renewal of a stale helper snapshot", () => {
  const clock = new ChatGptSuspensionClock(1_000, 5_000);
  clock.tick(1_000);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordNativeWaiting({ revision: 1, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 }, 1_000);
  clock.tick(1_201_000);
  const resumed = clock.recentSuspension();
  expect(chatGptExternalProgressSuppressesDomHealth(progress.snapshot(), 1_202_000, resumed)).toBe(true);
  expect(chatGptExternalProgressSuppressesDomHealth(progress.snapshot(), 1_206_000, resumed)).toBe(false);
  progress.recordNativeWaiting({ revision: 2, activeOperations: 1, unreadResults: 0, remainingMs: 119_000 }, 1_202_000);
  expect(chatGptExternalProgressSuppressesDomHealth(progress.snapshot(), 1_207_000, resumed)).toBe(true);
  expect(chatGptNativeWaitingLeaseIsLive(progress.snapshot(), -100_000)).toBe(false);
});

test("retirement removes waiting and completion evidence even when no tool batch was emitted", () => {
  const progress = new ChatGptExternalTurnProgress();
  const mirror = new ChatGptMirroredTurnProgress();
  progress.recordNativeWaiting({ revision: 1, activeOperations: 1, unreadResults: 0, remainingMs: 120_000 }, 1_000);
  mirror.apply(progress.snapshot());
  progress.retire(new Error("the owner exited"));
  mirror.apply(progress.snapshot());
  expect(chatGptExternalToolCallsAreInFlight(mirror.snapshot())).toBe(false);
  expect(chatGptNativeWaitingLeaseIsLive(mirror.snapshot(), 2_000)).toBe(false);
  expect(progress.snapshot().lastProgressAt).toBeUndefined();
});

test("remote 600-second idle pauses termination only, then immediately uses the unchanged old business timestamp", async () => {
  const identity = { threadId: "thread-waiting-idle", turnId: "turn-waiting-idle" };
  let clock = 0;
  let remaining = 0;
  let expired = 0;
  const registry = new NativeTurnIdleRegistry(600, () => { expired += 1; }, undefined, () => remaining, () => clock);
  try {
    const signal = registry.signal(identity);
    remaining = 120_000;
    clock = 661_000;
    registry.refreshWaiting();
    await Bun.sleep(10);
    expect(signal.aborted).toBe(false);
    expect(registry.lastProgressAt(identity)).toBe(0);
    for (let query = 0; query < 5; query += 1) {
      clock += 30_000;
      registry.refreshWaiting();
      expect(registry.lastProgressAt(identity)).toBe(0);
    }
    remaining = 0;
    registry.refreshWaiting();
    await Bun.sleep(10);
    expect(expired).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ code: "client_turn_idle_timeout" });
  } finally { registry.clear(); }
});

test("a genuine Native result refreshes remote business progress, unlike a waiting heartbeat", async () => {
  const identity = { threadId: "thread-result-idle", turnId: "turn-result-idle" };
  let clock = 0;
  let remaining = 120_000;
  const registry = new NativeTurnIdleRegistry(600, () => {}, undefined, () => remaining, () => clock);
  try {
    const signal = registry.signal(identity);
    clock = 661_000;
    registry.refreshWaiting();
    expect(registry.lastProgressAt(identity)).toBe(0);
    expect(registry.touchProgressOnce(identity, "native-result-call-1")).toBe(true);
    expect(registry.lastProgressAt(identity)).toBe(clock);
    remaining = 0;
    clock += 1_000;
    registry.refreshWaiting();
    expect(registry.touchProgressOnce(identity, "native-result-call-1")).toBe(false);
    await Bun.sleep(10);
    expect(signal.aborted).toBe(false);
    expect(registry.lastProgressAt(identity)).toBe(661_000);
  } finally { registry.clear(); }
});
