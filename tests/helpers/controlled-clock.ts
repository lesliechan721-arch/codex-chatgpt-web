let active = false;

/** A clock for serial tests. Retired native handles cannot edit a later clock's queue. */
export function controlledClock(options: { intervals?: boolean; abortSignals?: boolean } = {}) {
  if (active) throw new Error("A controlled clock is already active");
  active = true;
  const NativeDate = globalThis.Date;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  const nativeAbortTimeout = AbortSignal.timeout;
  const monotonicDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  const wallStart = NativeDate.now();
  // Integer milliseconds keep exact deadline boundaries free of float subtraction drift.
  const monotonicStart = Math.floor(performance.now());
  let elapsed = 0;
  let wallOffset = 0;
  let restored = false;
  type Timer = ReturnType<typeof setTimeout>;
  const pending = new Map<Timer, { at: number; callback: () => void; interval?: number }>();
  const now = () => wallStart + elapsed + wallOffset;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [now()], newTarget); },
    apply() { return new NativeDate(now()).toString(); },
    get(target, key, receiver) { return key === "now" ? now : Reflect.get(target, key, receiver); },
  });
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => monotonicStart + elapsed });
  const schedule = (callback: (...args: unknown[]) => void, delay: number | undefined, args: unknown[], interval = false) => {
    // Use a genuine but already cancelled native handle. A late clear after restore, or
    // in a different controlled clock, is harmless to both real and controlled timers.
    const handle = nativeSetTimeout(() => {}, 2_147_483_647);
    nativeClearTimeout(handle);
    const duration = Math.max(1, Number(delay) || 1);
    pending.set(handle, { at: elapsed + duration, callback: () => callback(...args), ...(interval ? { interval: duration } : {}) });
    return handle;
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(callback, delay, args)) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Timer) => {
    pending.delete(handle);
    nativeClearTimeout(handle);
  }) as typeof clearTimeout;
  if (options.intervals) {
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      schedule(callback, delay, args, true)) as typeof setInterval;
    globalThis.clearInterval = ((handle: Timer) => {
      pending.delete(handle);
      nativeClearInterval(handle);
    }) as typeof clearInterval;
  }
  if (options.abortSignals) AbortSignal.timeout = milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  };
  const validate = (milliseconds: number) => {
    if (restored) throw new Error("The controlled clock has been restored");
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock advance must be finite and nonnegative");
  };
  return {
    /** Move both clocks without delivering callbacks, as when the process cannot run. */
    suspend(milliseconds: number) {
      validate(milliseconds);
      elapsed += milliseconds;
    },
    tick(milliseconds: number) {
      validate(milliseconds);
      const target = elapsed + milliseconds;
      for (;;) {
        let next: [Timer, { at: number; callback: () => void; interval?: number }] | undefined;
        for (const entry of pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        // Overdue callbacks observe resume time, never their old scheduled time.
        elapsed = Math.max(elapsed, next[1].at);
        if (next[1].interval) next[1].at = elapsed + next[1].interval;
        else pending.delete(next[0]);
        next[1].callback();
      }
      elapsed = target;
    },
    shiftWall(milliseconds: number) {
      if (restored) throw new Error("The controlled clock has been restored");
      if (!Number.isFinite(milliseconds)) throw new Error("Clock shift must be finite");
      wallOffset += milliseconds;
    },
    restore() {
      if (restored) return;
      restored = true;
      pending.clear();
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
      if (options.intervals) {
        globalThis.setInterval = nativeSetInterval;
        globalThis.clearInterval = nativeClearInterval;
      }
      if (options.abortSignals) AbortSignal.timeout = nativeAbortTimeout;
      globalThis.Date = NativeDate;
      if (monotonicDescriptor) Object.defineProperty(performance, "now", monotonicDescriptor);
      else Reflect.deleteProperty(performance, "now");
      active = false;
    },
  };
}
