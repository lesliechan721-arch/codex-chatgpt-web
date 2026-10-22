import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { CONTEXT_PROTOCOL_VERSION, type CompactionContextRegistration } from "../src/adapters/chatgpt-web/context-runtime";
import { registerCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { createContextSnapshot, serializeContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { RemoteTurnBroker, TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { estimateTokens } from "../src/lib/token-estimate";

function virtualTime() {
  let wall = Date.now(), elapsed = 0;
  const clock = new ChatGptSuspensionClock(1_000, 5_000, () => elapsed, () => wall);
  const spies = [spyOn(Date, "now").mockImplementation(() => wall),
    spyOn(performance, "now").mockImplementation(() => elapsed),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(() => clock.suspendedMs())];
  return { sleep(ms: number) { wall += ms; elapsed += ms; },
    awake(ms: number) { while (ms > 0) { const step = Math.min(ms, 1_000); wall += step; elapsed += step; clock.tick(elapsed); ms -= step; } },
    restore() { for (const spy of spies.reverse()) spy.mockRestore(); } };
}
const environment = { authorityMode: "delegated" as const, threadId: "thread", turnId: "turn", tools: [] };
const snapshot = () => createContextSnapshot({ modelId: "gpt-5.6-sol", stream: false, options: {}, context: {
  messages: [{ role: "user", content: "Original source evidence", timestamp: 0 }],
} });
async function fixture() {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-remote-budget-"));
  const socket = defaultBrokerEndpoint(directory);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const time = virtualTime();
  return { broker, remote: new RemoteTurnBroker(socket), socket, time,
    async close() { time.restore(); await broker.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const mode of ["native", "safe", "manual"] as const) {
  for (const pause of [false, true]) test(`real remote source registration preserves its budget after serialization (${mode}, pause=${pause})`, async () => {
    const f = await fixture();
    try {
      const budget = new CompactionDeadline(Date.now() + 60_000);
      const transaction = mode === "native" ? await f.remote.beginCompactionTransaction("remote-source", 60_000) : undefined;
      const turnToken = mode !== "native" ? await f.remote.registerSafe(environment, "remote-source-surface-1234567890", 3_600_000, "remote-source", { requireSentConfirmation: false }) : undefined;
      if (mode === "safe") f.broker.startSafeTurn(turnToken!);
      let reads = 0;
      const source = await registerCompactionSource(f.remote, { snapshot: snapshot(),
        ...(transaction ? { contract: "native" as const, transactionToken: transaction.token, handoffId: transaction.handoffId }
          : { contract: "safe" as const, turnToken, handoffId: "safe:remote-source", ...(mode === "manual" ? { explicitManual: true as const } : {}) }),
        historyRevision: 0, ownerGeneration: "page", availableTokens: 160_000,
        expiresAt: () => { const deadline = budget.deadlineAt; if (++reads === 1 && pause) queueMicrotask(() => f.time.sleep(601_000)); return deadline; },
      }, "Summarize the original source");
      const entry = JSON.parse(source.instruction.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
      expect(entry.overview.remaining_tokens).toBe(160_000 - estimateTokens("Summarize the original source") - 4_096);
      expect(budget.remainingMs()).toBe(pause ? 59_000 : 60_000);
      if (mode === "safe") await f.remote.requestCompaction(turnToken!, { content: [{ type: "text", text: source.instruction }] });
      if (mode === "manual") f.broker.startSafeTurn(turnToken!);
      await f.remote.markCompactionContextDelivered(source.token);
      await expect(f.remote.guardCompactionContextCommit(source.token)).resolves.toBeUndefined();
      f.time.awake(budget.remainingMs());
      await expect(f.remote.guardCompactionContextCommit(source.token)).rejects.toBeDefined();
    } finally { await f.close(); }
  });
}

async function registration(f: Awaited<ReturnType<typeof fixture>>, mode: "native" | "safe" | "manual", parentMs = 60_000): Promise<CompactionContextRegistration> {
  const transaction = mode === "native" ? await f.remote.beginCompactionTransaction("remote-budget", parentMs) : undefined;
  const turnToken = mode !== "native" ? await f.remote.registerSafe(environment, "remote-source-surface-1234567890", parentMs, "remote-budget", { requireSentConfirmation: false }) : undefined;
  if (mode === "safe") f.broker.startSafeTurn(turnToken!);
  return { snapshot: snapshot(),
    ...(transaction ? { contract: "native" as const, transactionToken: transaction.token, handoffId: transaction.handoffId }
      : { contract: "safe" as const, turnToken, handoffId: "safe:remote-budget", ...(mode === "manual" ? { explicitManual: true as const } : {}) }),
    historyRevision: 0, ownerGeneration: "page", expiresAt: Date.now() + 60_000,
    remainingBudget: { tokens: 96_000, wire_bytes: 64_000_000, reserved_tokens: 8_192, reserved_wire_bytes: 0 },
  } satisfies CompactionContextRegistration;
}
function prepare(f: Awaited<ReturnType<typeof fixture>>, input: CompactionContextRegistration, ttlMs = 60_000) {
  const { contract, transactionToken, turnToken, handoffId, historyRevision, ownerGeneration, explicitManual, recovery } = input;
  return callTurnBroker<{ budgetToken: string; remainingMs: number }>(f.socket, {
    method: "owner_compaction_context_prepare", contextProtocol: CONTEXT_PROTOCOL_VERSION, ttlMs,
    compactionBudgetIdentity: { contract, transactionToken, turnToken, handoffId, historyRevision, ownerGeneration, explicitManual, recovery },
  });
}
function commit(f: Awaited<ReturnType<typeof fixture>>, input: CompactionContextRegistration, budgetToken: string, deadlineDebitMs = 0) {
  return callTurnBroker<{ compactionToken: string; contextId: string }>(f.socket, {
    method: "owner_compaction_context_register", contextProtocol: CONTEXT_PROTOCOL_VERSION,
    compactionRegistration: { ...input, snapshot: serializeContextSnapshot(input.snapshot) },
    compactionBudgetClaim: { budgetToken, deadlineDebitMs },
  });
}

for (const mode of ["native", "safe", "manual"] as const) {
  for (const outcome of ["resume", "expired", "revoked"] as const) test(`the final source socket request retains the owner budget (${mode}, ${outcome})`, async () => {
    const f = await fixture();
    try {
      const input = await registration(f, mode, mode === "native" ? 60_000 : 3_600_000);
      const budget = new CompactionDeadline(input.expiresAt);
      let reads = 0;
      const pending = registerCompactionSource(f.remote, { ...input, availableTokens: 96_000, expiresAt: () => {
        const value = budget.deadlineAt;
        if (++reads === 2) queueMicrotask(() => {
          if (outcome === "expired") f.time.awake(60_000);
          else f.time.sleep(601_000);
          if (outcome === "revoked") {
            if (input.transactionToken) f.broker.abortCompactionTransaction(input.transactionToken);
            else f.broker.revoke(input.turnToken!);
          }
        });
        return value;
      } }, "Summarize the original source");
      if (outcome === "resume") {
        const source = await pending;
        expect(budget.remainingMs()).toBe(59_000);
        if (mode === "safe") await f.remote.requestCompaction(input.turnToken!, { content: [{ type: "text", text: source.instruction }] });
        if (mode === "manual") f.broker.startSafeTurn(input.turnToken!);
        await f.remote.markCompactionContextDelivered(source.token);
        await expect(f.remote.guardCompactionContextCommit(source.token)).resolves.toBeUndefined();
        f.time.awake(59_000);
        await expect(f.remote.guardCompactionContextCommit(source.token)).rejects.toBeDefined();
      } else await expect(pending).rejects.toBeDefined();
      expect(reads).toBe(2);
    } finally { await f.close(); }
  });
}

for (const mode of ["native", "safe"] as const) test(`a replayed prepare keeps one original owner budget and registration stays single-use (${mode})`, async () => {
  const f = await fixture();
  try {
    const input = await registration(f, mode, mode === "native" ? 300_000 : 3_600_000);
    const first = await prepare(f, input);
    f.time.awake(10_000);
    expect(await prepare(f, input, 300_000)).toEqual({ budgetToken: first.budgetToken, remainingMs: 50_000 });
    f.time.sleep(601_000);
    expect(await prepare(f, input, 300_000)).toEqual({ budgetToken: first.budgetToken, remainingMs: 49_000 });
    const source = await commit(f, input, first.budgetToken, 4_000);
    await expect(prepare(f, input)).rejects.toBeDefined();
    await expect(commit(f, input, first.budgetToken)).rejects.toBeDefined();
    if (mode === "safe") await f.remote.requestCompaction(input.turnToken!, { content: [{ type: "text", text: "Summarize" }] });
    await f.remote.markCompactionContextDelivered(source.compactionToken);
    await expect(f.remote.guardCompactionContextCommit(source.compactionToken)).resolves.toBeUndefined();
    f.time.awake(45_000);
    await expect(f.remote.guardCompactionContextCommit(source.compactionToken)).rejects.toBeDefined();
    await f.remote.revokeCompactionContext(source.compactionToken);
    await expect(prepare(f, input)).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("a shorter parent transaction remains the source upper bound", async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "native", 10_000);
    const source = await f.remote.registerCompactionContext(input);
    await f.remote.markCompactionContextDelivered(source.compactionToken);
    f.time.awake(10_000);
    await expect(f.remote.guardCompactionContextCommit(source.compactionToken)).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("a pending compaction budget does not pause the existing Safe startup window", async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "manual", 5_000);
    const prepared = await prepare(f, input);
    f.time.sleep(601_000);
    await expect(commit(f, input, prepared.budgetToken)).rejects.toBeDefined();
    await expect(f.remote.updateEnvironment(input.turnToken!, environment)).rejects.toBeDefined();
  } finally { await f.close(); }
});

for (const change of ["source", "registry", "retired"] as const) test(`pending owner budget rejects changed authority (${change})`, async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "safe", 3_600_000);
    const prepared = await prepare(f, input);
    if (change === "source") input.ownerGeneration = "other-page";
    if (change === "registry") await f.remote.updateEnvironment(input.turnToken!, environment);
    if (change === "retired") await f.remote.revokeCompactionContext(prepared.budgetToken);
    await expect(commit(f, input, prepared.budgetToken)).rejects.toBeDefined();
    await expect(prepare(f, input)).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("a caller expired before prepare arrives cannot renew its budget on retry", async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "safe", 3_600_000);
    const budget = new CompactionDeadline(input.expiresAt);
    let first = true;
    await expect(registerCompactionSource(f.remote, { ...input, availableTokens: 96_000, expiresAt: () => {
      const value = budget.deadlineAt;
      if (first) { first = false; queueMicrotask(() => f.time.awake(60_000)); }
      return value;
    } }, "Summarize")).rejects.toBeDefined();
    await expect(prepare(f, input, 300_000)).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("source validation failure retires its pending budget without consuming source capacity", async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "native");
    const prepared = await prepare(f, input);
    await expect(commit(f, { ...input, remainingBudget: { ...input.remainingBudget!, tokens: -1 } }, prepared.budgetToken)).rejects.toBeDefined();
    await expect(prepare(f, input)).rejects.toBeDefined();
    await expect(commit(f, input, prepared.budgetToken)).rejects.toBeDefined();
    const fresh = await registration(f, "native");
    await expect(f.remote.registerCompactionContext(fresh)).resolves.toBeDefined();
  } finally { await f.close(); }
});

test("pending budgets share the bounded binding capacity and parent revocation releases it", async () => {
  const f = await fixture();
  try {
    const entries: CompactionContextRegistration[] = [];
    for (let index = 0; index < 64; index++) {
      const input = await registration(f, "native");
      entries.push(input);
      await prepare(f, input);
    }
    const next = await registration(f, "native");
    await expect(prepare(f, next)).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    await f.remote.abortCompactionTransaction(entries[0]!.transactionToken!);
    await expect(prepare(f, next)).resolves.toBeDefined();
  } finally { await f.close(); }
});

test("an owner restart cannot accept an old pending budget or restore its parent token", async () => {
  const f = await fixture();
  let successor: TurnBroker | undefined;
  try {
    const input = await registration(f, "native");
    const prepared = await prepare(f, input);
    await f.broker.close();
    successor = TurnBroker.forSocket(f.socket);
    await successor.listen();
    await expect(commit(f, input, prepared.budgetToken)).rejects.toBeDefined();
    const fresh = await registration(f, "native");
    await expect(commit(f, fresh, prepared.budgetToken)).rejects.toBeDefined();
    await expect(f.remote.registerCompactionContext(fresh)).resolves.toBeDefined();
  } finally { await successor?.close(); await f.close(); }
});

for (const mode of ["native", "safe"] as const) test(`pending and retired registrations cannot bypass source coverage at summary submission (${mode})`, async () => {
  const f = await fixture();
  try {
    const input = await registration(f, mode, mode === "native" ? 60_000 : 3_600_000);
    const prepared = await prepare(f, input);
    const submit = () => mode === "native" ? callTurnBroker(f.socket, { method: "submit_compaction_handoff",
      token: input.transactionToken, handoffId: input.handoffId, summary: "Premature summary" })
      : callTurnBroker(f.socket, { method: "safe_complete", token: input.turnToken, finalAnswer: "Premature summary" });
    await expect(submit()).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await f.remote.revokeCompactionContext(prepared.budgetToken);
    await expect(submit()).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
  } finally { await f.close(); }
});

test("budget cleanup retires an already registered source when its reply was not retained", async () => {
  const f = await fixture();
  try {
    const input = await registration(f, "native");
    const prepared = await prepare(f, input);
    const source = await commit(f, input, prepared.budgetToken);
    await f.remote.markCompactionContextDelivered(source.compactionToken);
    await f.remote.revokeCompactionContext(prepared.budgetToken);
    await expect(f.remote.guardCompactionContextCommit(source.compactionToken)).rejects.toBeDefined();
    await expect(prepare(f, input)).rejects.toBeDefined();
  } finally { await f.close(); }
});
