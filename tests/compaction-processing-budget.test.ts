import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { assertCompactionReadable, registerCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

function virtualTime(processingStep = 0) {
  let wall = Date.now(), elapsed = 0;
  const clock = new ChatGptSuspensionClock(1_000, 5_000, () => elapsed, () => wall);
  const spies = [spyOn(Date, "now").mockImplementation(() => wall),
    spyOn(performance, "now").mockImplementation(() => { elapsed += processingStep; wall += processingStep; return elapsed; }),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(() => clock.suspendedMs())];
  return { sleep(ms: number) { elapsed += ms; wall += ms; },
    awake(ms: number) { while (ms > 0) { const step = Math.min(ms, 1_000); elapsed += step; wall += step; clock.tick(elapsed); ms -= step; } },
    restore() { for (const spy of spies.reverse()) spy.mockRestore(); } };
}
function snapshot(count = 1) {
  return createContextSnapshot({ modelId: "gpt-5.6-sol", stream: false, options: {}, context: {
    messages: Array.from({ length: count }, (_, index) => ({ role: "user" as const, content: `Source ${index}: original evidence`, timestamp: index })),
  } });
}

for (const outcome of ["resume", "expired", "revoked"] as const) test(`source registration rechecks the same budget after its actual preflight await (${outcome})`, async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-preflight-sleep-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  await broker.listen();
  const time = virtualTime();
  try {
    const budget = new CompactionDeadline(Date.now() + 60_000);
    const transaction = await broker.beginCompactionTransaction("await-source-registration", budget.remainingMs());
    queueMicrotask(() => {
      if (outcome === "expired") time.awake(60_000);
      else time.sleep(601_000);
      if (outcome === "revoked") broker.abortCompactionTransaction(transaction.token);
    });
    const pending = registerCompactionSource(broker, {
      snapshot: snapshot(), contract: "native", transactionToken: transaction.token, handoffId: transaction.handoffId,
      historyRevision: 0, ownerGeneration: "page", expiresAt: () => budget.deadlineAt,
    }, "Summarize the original source");
    if (outcome !== "resume") {
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    } else {
      const source = await pending;
      expect(budget.remainingMs()).toBe(59_000);
      broker.markCompactionContextDelivered(source.token);
      expect(() => broker.guardCompactionContextCommit(source.token)).not.toThrow();
      time.awake(59_000);
      expect(() => broker.guardCompactionContextCommit(source.token)).toThrow();
    }
  } finally { time.restore(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const purpose of ["compaction", "normal"] as const) test(`source processing excludes detected suspension only for compaction (${purpose})`, () => {
  const source = snapshot();
  const time = virtualTime();
  let first = true, awakeCost = 0;
  try {
    const navigator = new ContextNavigator({ scopeId: "processing-sleep", snapshot: source, purpose,
      limits: { totalProcessingMs: 2_500 },
      remainingBudget(_targets, result) {
        if (result) {
          if (first) { first = false; time.sleep(601_000); }
          else time.awake(awakeCost);
        }
        return { tokens: 96_000, wire_bytes: 64_000_000, reserved_tokens: 8_192, reserved_wire_bytes: 0 };
      } });
    const args = { context_id: source.context_id, reads: [{ read_ref: source.targets[0]!.read_ref! }] };
    const result = navigator.read(args);
    if (purpose === "normal") {
      expect(result.isError).toBeTrue();
      expect(navigator.usage().processing_ms).toBe(601_000);
    } else {
      expect(result.isError).not.toBeTrue();
      expect(navigator.usage().processing_ms).toBe(1_000);
      expect(navigator.read(args).isError).not.toBeTrue();
      awakeCost = 1_500;
      expect(navigator.read(args).isError).not.toBeTrue();
      expect(navigator.usage().processing_ms).toBe(2_500);
      expect(navigator.read(args).structuredContent).toMatchObject({ error: { code: "PROCESSING_BUDGET_EXCEEDED" } });
      expect(navigator.usage().processing_ms).toBe(2_500);
    }
  } finally { time.restore(); }
});

test("a source read still rejects a single awake processing overrun", () => {
  const source = snapshot();
  const time = virtualTime();
  try {
    const navigator = new ContextNavigator({ scopeId: "awake-overrun", snapshot: source, purpose: "compaction",
      remainingBudget(_targets, result) {
        if (result) time.awake(3_000);
        return { tokens: 96_000, wire_bytes: 64_000_000, reserved_tokens: 8_192, reserved_wire_bytes: 0 };
      } });
    const result = navigator.read({ context_id: source.context_id, reads: [{ read_ref: source.targets[0]!.read_ref! }] });
    expect(result.structuredContent).toMatchObject({ error: { code: "PROCESSING_BUDGET_EXCEEDED" } });
    expect(navigator.usage().processing_ms).toBe(3_000);
  } finally { time.restore(); }
});

for (const awake of [false, true]) test(`source preflight excludes suspension across a real event-loop yield but retains awake limits (${awake})`, async () => {
  const source = snapshot(30);
  const time = virtualTime(1);
  let yielded = false;
  const tick = setImmediate(() => { yielded = true; if (awake) time.awake(25_000); else time.sleep(601_000); });
  try {
    const preflight = assertCompactionReadable(source);
    if (awake) await expect(preflight).rejects.toMatchObject({ code: "continuity_resource_capacity" });
    else await expect(preflight).resolves.toBeUndefined();
    expect(yielded).toBeTrue();
  } finally { clearImmediate(tick); time.restore(); }
});
