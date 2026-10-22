import { expect, test } from "bun:test";
import { mock } from "node:test";
import { controlledClock } from "./helpers/controlled-clock";
import { suspensionTestClock } from "./helpers/suspension-test-clock";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";

test("controlled clock advances wall time, monotonic time and timer delivery together", () => {
  const clock = controlledClock();
  try {
    const wall = Date.now();
    const monotonic = performance.now();
    const fired: number[] = [];
    setTimeout(() => {
      fired.push(Date.now() - wall);
      setTimeout(() => fired.push(Date.now() - wall), 300);
    }, 300).unref();
    const cancelled = setTimeout(() => fired.push(-1), 400);
    clearTimeout(cancelled);
    clock.tick(299);
    expect(fired).toEqual([]);
    clock.tick(301);
    expect(fired).toEqual([300, 600]);
    expect(Date.now() - wall).toBe(600);
    expect(new Date().getTime() - wall).toBe(600);
    expect(performance.now() - monotonic).toBe(600);
    expect(() => controlledClock()).toThrow("already active");
  } finally { clock.restore(); }
});

test("controlled clock late cleanup cannot cancel a successor controlled or real timer", async () => {
  const first = controlledClock();
  const stale = setTimeout(() => { throw new Error("Retired timer fired"); }, 1_000);
  const late = new Promise<void>(resolve => setImmediate(() => { clearTimeout(stale); resolve(); }));
  first.restore();
  const next = controlledClock();
  try {
    let fired = false;
    let cancelledFired = false;
    setTimeout(() => { fired = true; }, 10);
    const cancelled = setTimeout(() => { cancelledFired = true; }, 10);
    clearTimeout(cancelled);
    await late;
    next.tick(10);
    expect(fired).toBeTrue();
    expect(cancelledFired).toBeFalse();
  } finally { next.restore(); }
  await new Promise<void>(resolve => {
    setTimeout(resolve, 5);
    clearTimeout(stale);
  });
});

test("controlled clock retired native handles cannot edit a later Bun mock timer queue", async () => {
  const clock = controlledClock();
  const stale = setTimeout(() => {}, 1_000);
  const late = new Promise<void>(resolve => setImmediate(() => { clearTimeout(stale); resolve(); }));
  clock.restore();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    let fired = false;
    setTimeout(() => { fired = true; }, 10);
    await late;
    mock.timers.tick(10);
    expect(fired).toBeTrue();
  } finally { mock.timers.reset(); }
});

test("controlled clock forwards cancellation of real timers created before the scope", async () => {
  let fired = false;
  const previous = setTimeout(() => { fired = true; }, 5);
  const clock = controlledClock();
  try { clearTimeout(previous); } finally { clock.restore(); }
  await Bun.sleep(10);
  expect(fired).toBeFalse();
  // A timer created after restore uses the native clock, even after repeated restoration.
  clock.restore();
  await new Promise<void>(resolve => setTimeout(resolve, 1));
  expect(() => clock.tick(1)).toThrow("restored");
});

test("suspended timers observe resume time without replaying missed interval ticks", () => {
  const originalInterval = setInterval, originalAbortTimeout = AbortSignal.timeout;
  const clock = controlledClock({ intervals: true, abortSignals: true });
  try {
    const start = performance.now();
    const ticks: number[] = [], expired: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Math.round(performance.now() - start)), 1_000);
    setTimeout(() => expired.push(Math.round(performance.now() - start)), 1_500);
    const signal = AbortSignal.timeout(2_500);
    clock.tick(1_000);
    clock.suspend(6_000);
    expect(ticks).toEqual([1_000]);
    expect(expired).toEqual([]);
    expect(signal.aborted).toBeFalse();
    clock.tick(0);
    expect(ticks).toEqual([1_000, 7_000]);
    expect(expired).toEqual([7_000]);
    expect(signal.aborted).toBeTrue();
    expect(signal.reason.name).toBe("TimeoutError");
    clock.tick(1_000);
    expect(ticks).toEqual([1_000, 7_000, 8_000]);
    clearInterval(heartbeat);
    clock.tick(1_000);
    expect(ticks).toHaveLength(3);
    const wall = Date.now();
    clock.shiftWall(-60_000);
    expect(Date.now()).toBe(wall - 60_000);
    expect(performance.now() - start).toBeCloseTo(9_000, 6);
  } finally { clock.restore(); }
  expect(setInterval).toBe(originalInterval);
  expect(AbortSignal.timeout).toBe(originalAbortTimeout);
});

test("virtual suspension preserves a production deadline while awake time and ordinary timers still expire", () => {
  const clock = suspensionTestClock();
  let ordinaryExpired = false, compactionExpired = false;
  const deadline = new CompactionDeadline(Date.now() + 5_000);
  const stop = deadline.watch(() => { compactionExpired = true; });
  setTimeout(() => { ordinaryExpired = true; }, 5_000);
  try {
    clock.tick(1_000);
    expect(deadline.remainingMs()).toBe(4_000);
    clock.sleep(6_100);
    expect(ordinaryExpired).toBeTrue();
    expect(compactionExpired).toBeFalse();
    expect(deadline.remainingMs()).toBe(3_000);
    clock.tick(2_999);
    expect(compactionExpired).toBeFalse();
    clock.tick(1);
    expect(compactionExpired).toBeTrue();
    clock.sleep(60_000);
    expect(deadline.remainingMs()).toBe(0);
  } finally { stop(); clock.restore(); }
});
