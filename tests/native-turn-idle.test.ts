import { expect, test } from "bun:test";
import { NativeTurnIdleRegistry } from "../src/native-turn-idle";

test("native turn idle lease refreshes only when explicitly touched", async () => {
  const identity = { threadId: "thread_idle", turnId: "turn_idle" };
  let expiredReason: Error | undefined;
  let expire!: () => void;
  const expired = new Promise<void>(resolve => { expire = resolve; });
  const registry = new NativeTurnIdleRegistry(1, (_identity, reason) => {
    expiredReason = reason;
    expire();
  });

  const first = registry.signal(identity);
  await Bun.sleep(600);
  expect(registry.signal(identity)).toBe(first);
  expect(registry.touch(identity)).toBe(true);
  await Bun.sleep(600);
  expect(first.aborted).toBe(false);
  expect(registry.count()).toBe(1);

  await Promise.race([
    expired,
    Bun.sleep(800).then(() => { throw new Error("idle lease did not expire after refreshed budget"); }),
  ]);
  expect(first.aborted).toBe(true);
  expect((first.reason as { code?: string }).code).toBe("client_turn_idle_timeout");
  expect(expiredReason?.message).toContain("no progress for 1s");
  expect(registry.count()).toBe(0);
  const retriedAfterExpiry = registry.signal(identity);
  expect(retriedAfterExpiry).toBe(first);
  expect(retriedAfterExpiry.aborted).toBe(true);
});

test("normal completion releases an active idle lease without creating a terminal tombstone", () => {
  const registry = new NativeTurnIdleRegistry(30, () => {});
  const identity = { threadId: "thread_done", turnId: "turn_done" };
  const signal = registry.signal(identity);
  expect(registry.release(identity)).toBe(true);
  expect(registry.release(identity)).toBe(false);
  expect(registry.count()).toBe(0);
  expect(registry.retainedCount()).toBe(0);
  expect(signal.aborted).toBe(false);
});

test("terminal idle state stays terminal within one bounded authority epoch", () => {
  const registry = new NativeTurnIdleRegistry(30, () => {}, 2);
  const reason = new Error("idle timeout");
  const first = { threadId: "thread_1", turnId: "turn_1" };
  const second = { threadId: "thread_2", turnId: "turn_2" };
  const third = { threadId: "thread_3", turnId: "turn_3" };

  registry.signal(first);
  registry.terminate(first, reason);
  registry.signal(second);
  registry.terminate(second, reason);
  expect(registry.signal(second).aborted).toBe(true);
  expect(registry.retainedCount()).toBe(2);
  expect(registry.epoch()).toBe(1);

  const nextEpoch = registry.signal(third);
  expect(nextEpoch.aborted).toBe(false);
  expect(registry.count()).toBe(1);
  expect(registry.retainedCount()).toBe(1);
  expect(registry.epoch()).toBe(2);
});

test("capacity pressure is explicit only while an active lease prevents an epoch rollover", () => {
  const registry = new NativeTurnIdleRegistry(30, () => {}, 1);
  const first = { threadId: "thread_first", turnId: "turn_first" };
  const second = { threadId: "thread_second", turnId: "turn_second" };

  registry.signal(first);
  expect(registry.retainedCount()).toBe(1);
  expect(() => registry.signal(second)).toThrow("terminal tombstone capacity");
  expect(registry.epoch()).toBe(1);
  expect(registry.release(first)).toBe(true);
  expect(registry.retainedCount()).toBe(0);
  expect(registry.signal(second).aborted).toBe(false);
  expect(registry.count()).toBe(1);
  expect(registry.epoch()).toBe(1);
});
