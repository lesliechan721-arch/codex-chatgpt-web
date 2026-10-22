/** Tracks process suspension without mixing elapsed time with cross-process timestamps. */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private latestSuspension?: { startedAt: number; endedAt: number };
  private lastTickAt: number;
  private lastWallTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => number = () => Date.now(),
  ) {
    this.lastTickAt = this.now();
    this.lastWallTickAt = this.wallNow();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = this.now();
    this.lastWallTickAt = this.wallNow();
    this.timer = setInterval(() => this.tick(this.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production samples also come from budget and lease reads. */
  tick(now: number): void {
    const wallNow = this.wallNow();
    const gap = now - this.lastTickAt;
    if (gap >= this.gapThresholdMs) {
      this.suspendedTotalMs += gap - this.tickIntervalMs;
      // Lease timestamps come from other processes and use wall-clock epochs.
      this.latestSuspension = { startedAt: this.lastWallTickAt + this.tickIntervalMs, endedAt: wallNow };
    }
    this.lastTickAt = now;
    this.lastWallTickAt = wallNow;
  }

  suspendedMs(): number {
    // A deadline can fire before the interval gets its first tick after resume.
    this.tick(this.now());
    return this.suspendedTotalMs;
  }

  recentSuspension(): { startedAt: number; endedAt: number } | undefined {
    this.tick(this.now());
    return this.latestSuspension;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();
