import { spyOn } from "bun:test";

let active = false;

/** A clock for serial tests. Retired native handles cannot edit a later clock's queue. */
export function controlledClock() {
  if (active) throw new Error("A controlled clock is already active");
  active = true;
  const NativeDate = globalThis.Date;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const wallStart = NativeDate.now();
  const monotonicStart = performance.now();
  let elapsed = 0;
  let restored = false;
  type Timer = ReturnType<typeof setTimeout>;
  const pending = new Map<Timer, { at: number; callback: () => void }>();
  const now = () => wallStart + elapsed;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [now()], newTarget); },
    apply() { return new NativeDate(now()).toString(); },
    get(target, key, receiver) { return key === "now" ? now : Reflect.get(target, key, receiver); },
  });
  const monotonic = spyOn(performance, "now").mockImplementation(() => monotonicStart + elapsed);
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    // Use a genuine but already cancelled native handle. A late clear after restore, or
    // in a different controlled clock, is harmless to both real and controlled timers.
    const handle = nativeSetTimeout(() => {}, 2_147_483_647);
    nativeClearTimeout(handle);
    pending.set(handle, { at: elapsed + Math.max(1, Number(delay) || 1), callback: () => callback(...args) });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Timer) => {
    pending.delete(handle);
    nativeClearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    tick(milliseconds: number) {
      if (restored) throw new Error("The controlled clock has been restored");
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock advance must be finite and nonnegative");
      const target = elapsed + milliseconds;
      for (;;) {
        let next: [Timer, { at: number; callback: () => void }] | undefined;
        for (const entry of pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        elapsed = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      elapsed = target;
    },
    restore() {
      if (restored) return;
      restored = true;
      pending.clear();
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
      globalThis.Date = NativeDate;
      monotonic.mockRestore();
      active = false;
    },
  };
}
