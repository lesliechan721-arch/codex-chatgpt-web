import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";

export interface NativeTurnIdleIdentity {
  threadId: string;
  turnId: string;
}

interface NativeTurnIdleEntry {
  identity: NativeTurnIdleIdentity;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  progressKeys: Set<string>;
  lastProgressAt: number;
}

const DEFAULT_TERMINAL_LIMIT = 1_024;

function identityKey(identity: NativeTurnIdleIdentity): string {
  return `${identity.threadId}\u0000${identity.turnId}`;
}

/**
 * Server-deployment-only inactivity lease for one native Codex turn.
 *
 * Real turn progress refreshes the lease. Transport/helper heartbeats do not. Once the lease
 * expires, the identity is kept as a bounded terminal tombstone so a late retry cannot recreate
 * the same logical turn with a fresh idle budget. Capacity rollover is an explicit authority epoch
 * boundary and can happen only while there are no active leases, matching the same recovery
 * boundary as a clean service restart without permanently failing every future identity.
 */
export class NativeTurnIdleRegistry {
  private readonly active = new Map<string, NativeTurnIdleEntry>();
  private readonly terminal = new Map<string, AbortController>();
  private authorityEpoch = 1;

  constructor(
    private readonly timeoutSec: number,
    private readonly onExpire: (identity: NativeTurnIdleIdentity, reason: Error) => void | Promise<void>,
    private readonly terminalLimit = DEFAULT_TERMINAL_LIMIT,
    private readonly nativeWaitRemainingMs: (identity: NativeTurnIdleIdentity) => number = () => 0,
    private readonly clock: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec <= 0) {
      throw new Error("Native turn idle timeout must be a positive integer number of seconds");
    }
    if (!Number.isSafeInteger(terminalLimit) || terminalLimit <= 0) {
      throw new Error("Native turn terminal tombstone limit must be a positive integer");
    }
  }

  signal(identity: NativeTurnIdleIdentity): AbortSignal {
    const key = identityKey(identity);
    const terminal = this.terminal.get(key);
    if (terminal) return terminal.signal;
    const existing = this.active.get(key);
    if (existing) return existing.controller.signal;
    this.ensureUnknownIdentityCapacity();

    const controller = new AbortController();
    const lastProgressAt = this.clock();
    const entry: NativeTurnIdleEntry = {
      identity,
      controller,
      timer: this.arm(key, identity, controller, lastProgressAt),
      progressKeys: new Set(),
      lastProgressAt,
    };
    this.active.set(key, entry);
    return controller.signal;
  }

  assertCanSignal(identity: NativeTurnIdleIdentity): void {
    const key = identityKey(identity);
    const terminal = this.terminal.get(key);
    if (terminal) throw terminal.signal.reason;
    if (this.active.has(key)) return;
    if (this.active.size + this.terminal.size < this.terminalLimit || this.active.size === 0) return;
    throw new ChatGptWebAdapterError(
      "Remote Codex terminal tombstone capacity is temporarily exhausted while active turns still own the current authority epoch",
      {
        status: 503,
        errorType: "server_error",
        code: "client_turn_idle_tombstone_capacity",
        retryable: true,
      },
    );
  }

  touch(identity: NativeTurnIdleIdentity): boolean {
    const key = identityKey(identity);
    const entry = this.active.get(key);
    if (!entry || entry.controller.signal.aborted) return false;
    clearTimeout(entry.timer);
    entry.lastProgressAt = this.clock();
    entry.timer = this.arm(key, entry.identity, entry.controller, entry.lastProgressAt);
    return true;
  }

  touchProgressOnce(identity: NativeTurnIdleIdentity, progressKey: string): boolean {
    const key = identityKey(identity);
    const entry = this.active.get(key);
    if (!entry || entry.controller.signal.aborted || entry.progressKeys.has(progressKey)) return false;
    entry.progressKeys.add(progressKey);
    clearTimeout(entry.timer);
    entry.lastProgressAt = this.clock();
    entry.timer = this.arm(key, entry.identity, entry.controller, entry.lastProgressAt);
    return true;
  }

  /** Re-evaluate termination, without moving the last real business-progress timestamp. */
  refreshWaiting(): void {
    for (const [key, entry] of this.active) {
      clearTimeout(entry.timer);
      entry.timer = this.arm(key, entry.identity, entry.controller, entry.lastProgressAt);
    }
  }

  lastProgressAt(identity: NativeTurnIdleIdentity): number | undefined {
    return this.active.get(identityKey(identity))?.lastProgressAt;
  }

  release(identity: NativeTurnIdleIdentity): boolean {
    const key = identityKey(identity);
    const entry = this.active.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.active.delete(key);
    return true;
  }

  terminate(identity: NativeTurnIdleIdentity, reason: Error): boolean {
    const key = identityKey(identity);
    const entry = this.active.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.active.delete(key);
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
      this.rememberTerminal(key, entry.controller);
      return true;
    }
    if (this.terminal.has(key)) return false;
    this.ensureUnknownIdentityCapacity();
    const controller = new AbortController();
    controller.abort(reason);
    this.rememberTerminal(key, controller);
    return false;
  }

  clear(): void {
    for (const entry of this.active.values()) clearTimeout(entry.timer);
    this.active.clear();
    this.terminal.clear();
  }

  count(): number {
    return this.active.size;
  }

  retainedCount(): number {
    return this.active.size + this.terminal.size;
  }

  epoch(): number {
    return this.authorityEpoch;
  }

  private arm(
    key: string,
    identity: NativeTurnIdleIdentity,
    controller: AbortController,
    lastProgressAt: number,
  ): ReturnType<typeof setTimeout> {
    const idleRemaining = this.timeoutSec * 1_000 - Math.max(0, this.clock() - lastProgressAt);
    const waitingRemaining = idleRemaining <= 0 ? this.nativeWaitRemainingMs(identity) : 0;
    const timer = setTimeout(() => {
      const current = this.active.get(key);
      if (!current || current.controller !== controller) return;
      if (this.clock() - current.lastProgressAt < this.timeoutSec * 1_000
        || this.nativeWaitRemainingMs(identity) > 0) {
        current.timer = this.arm(key, identity, controller, current.lastProgressAt);
        return;
      }
      const reason = new ChatGptWebAdapterError(
        `Remote Codex turn made no progress for ${this.timeoutSec}s`,
        {
          status: 504,
          errorType: "server_error",
          code: "client_turn_idle_timeout",
          retryable: false,
        },
      );
      clearTimeout(current.timer);
      this.active.delete(key);
      controller.abort(reason);
      this.rememberTerminal(key, controller);
      void Promise.resolve(this.onExpire(identity, reason)).catch(error => {
        console.error(
          `[codex-chatgpt-web] remote turn idle-timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, Math.max(1, idleRemaining > 0 ? idleRemaining : Math.min(120_000, waitingRemaining)));
    timer.unref?.();
    return timer;
  }

  private rememberTerminal(key: string, controller: AbortController): void {
    if (this.terminal.has(key)) return;
    this.terminal.set(key, controller);
  }

  private ensureUnknownIdentityCapacity(): void {
    // Every active lease reserves one slot for the tombstone it may need on timeout. Keeping
    // active + terminal entries within one fixed budget means timeout can always record the exact
    // identity without an unbounded overflow or a shared global abort signal.
    if (this.active.size + this.terminal.size < this.terminalLimit) return;
    if (this.active.size === 0) {
      this.terminal.clear();
      this.authorityEpoch += 1;
      return;
    }
    throw new ChatGptWebAdapterError(
      "Remote Codex terminal tombstone capacity is temporarily exhausted while active turns still own the current authority epoch",
      {
        status: 503,
        errorType: "server_error",
        code: "client_turn_idle_tombstone_capacity",
        retryable: true,
      },
    );
  }
}
