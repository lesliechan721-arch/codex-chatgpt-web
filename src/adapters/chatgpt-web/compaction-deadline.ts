import { chatGptSuspensionClock, type ChatGptSuspensionClock } from "./suspension-clock";

/** A fixed compaction budget. Activity and retries cannot renew it. */
export class CompactionDeadline {
  private suspendedAt: number;
  private expired = false;
  private adjustment = 0;
  private readonly initialRemainingMs: number;
  private readonly startedAt: number;

  constructor(
    readonly originalDeadlineAt: number,
    private readonly clock: Pick<ChatGptSuspensionClock, "start" | "suspendedMs"> = chatGptSuspensionClock,
    private readonly now: () => number = () => Date.now(),
    private readonly onSuspension?: (totalMs: number) => void,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    clock.start();
    this.suspendedAt = clock.suspendedMs();
    this.startedAt = monotonicNow();
    this.initialRemainingMs = Math.max(0, originalDeadlineAt - now());
    this.expired = this.initialRemainingMs <= 0;
  }

  /** Current wall representation for a new child capability; not a new budget. */
  get deadlineAt(): number { return this.now() + this.remainingMs(); }

  remainingMs(): number {
    if (this.expired) return 0;
    const suspended = this.clock.suspendedMs();
    const extra = Math.max(0, Math.floor(suspended - this.suspendedAt));
    if (extra) {
      // Accumulated suspension also covers multiple gaps between reads. Awake time
      // before a gap remains charged, so a late timer cannot revive an expired budget.
      this.onSuspension?.(this.adjustment + extra);
      this.adjustment += extra;
      this.suspendedAt += extra;
    }
    const remaining = this.initialRemainingMs - (this.monotonicNow() - this.startedAt - this.adjustment);
    if (remaining <= 0) this.expired = true;
    return Math.max(0, Math.min(this.initialRemainingMs, Math.ceil(remaining)));
  }

  /** Timer callbacks sample suspension before deciding whether the budget expired. */
  watch(onExpired: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = (): void => {
      if (stopped) return;
      let remaining: number;
      try { remaining = this.remainingMs(); }
      catch { stopped = true; onExpired(); return; }
      if (remaining <= 0) { stopped = true; onExpired(); return; }
      timer = setTimeout(check, Math.min(2_147_483_647, remaining));
      timer.unref?.();
    };
    check();
    return () => { stopped = true; clearTimeout(timer); };
  }
}

/** Processing limits use the same detected pauses as compaction capabilities. */
export function compactionProcessingNow(): number {
  chatGptSuspensionClock.start();
  const suspended = chatGptSuspensionClock.suspendedMs();
  return performance.now() - suspended;
}
