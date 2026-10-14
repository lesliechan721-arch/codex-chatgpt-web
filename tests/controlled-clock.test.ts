import { expect, test } from "bun:test";
import { mock } from "node:test";
import { controlledClock } from "./helpers/controlled-clock";

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
