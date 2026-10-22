import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { defaultBrokerEndpoint } from "../src/config";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { registerCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { RemoteTurnBroker, TurnBroker, TurnBrokerTimeoutError, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

import { CONTEXT_PROTOCOL_VERSION, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { createContinuityMcpClient } from "./helpers/continuity-mcp-client";

const environment = { authorityMode: "delegated" as const, threadId: "thread", turnId: "turn", tools: [] };
const snapshot = () => createContextSnapshot({ modelId: "gpt-5.6-sol", stream: false, options: {}, context: {
  messages: [{ role: "user", content: "Original source evidence", timestamp: 0 }],
} });
const suspend = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_100);
async function fixture() {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-rpc-wait-"));
  const socket = defaultBrokerEndpoint(directory);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  return { socket, broker, remote: new RemoteTurnBroker(socket), async close() {
    await broker.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["native", "safe", "manual"] as const) for (const phase of ["prepare", "register"] as const) {
  test(`actual event-loop suspension retains the finite source RPC (${mode}, ${phase})`, async () => {
    const f = await fixture();
    try {
      const budget = new CompactionDeadline(Date.now() + 60_000);
      const transaction = mode === "native" ? await f.remote.beginCompactionTransaction("rpc-wait-source", 60_000) : undefined;
      const turnToken = mode !== "native" ? await f.remote.registerSafe(environment, "rpc-wait-surface-1234567890", 3_600_000, "rpc-wait-source",
        { requireSentConfirmation: false, ...(mode === "manual" ? { compaction: true as const } : {}) }) : undefined;
      if (mode === "safe") f.broker.startSafeTurn(turnToken!);
      const before = chatGptSuspensionClock.suspendedMs();
      let reads = 0;
      const source = await registerCompactionSource(f.remote, { snapshot: snapshot(),
        ...(transaction ? { contract: "native" as const, transactionToken: transaction.token, handoffId: transaction.handoffId }
          : { contract: "safe" as const, turnToken, handoffId: "safe:rpc-wait", ...(mode === "manual" ? { explicitManual: true as const } : {}) }),
        historyRevision: 0, ownerGeneration: "page", availableTokens: 96_000,
        expiresAt: () => { const value = budget.deadlineAt; if (++reads === (phase === "prepare" ? 1 : 2)) queueMicrotask(suspend); return value; },
      }, "Summarize the original source");
      expect(chatGptSuspensionClock.suspendedMs() - before).toBeGreaterThan(5_000);
      expect(budget.remainingMs()).toBeGreaterThan(55_000);
      expect(budget.remainingMs()).toBeLessThan(60_000);
      await f.remote.revokeCompactionContext(source.token);
    } finally { await f.close(); }
  }, 20_000);
}

async function nativeSource(f: Awaited<ReturnType<typeof fixture>>) {
  const transaction = await f.remote.beginCompactionTransaction("rpc-wait", 60_000);
  const source = f.broker.registerCompactionContext({ snapshot: snapshot(), contract: "native",
    transactionToken: transaction.token, handoffId: transaction.handoffId, historyRevision: 0,
    ownerGeneration: "page", expiresAt: Date.now() + 60_000 });
  f.broker.markCompactionContextDelivered(source.compactionToken);
  const credential = { token: source.compactionToken, contract: "native" as const,
    credentialKind: "compaction" as const, contextProtocol: CONTEXT_PROTOCOL_VERSION };
  const query = () => callTurnBroker<ContextPreparedReply>(f.socket, { ...credential, method: "context_query",
    contextMethod: "list", contextArgs: { context_id: source.contextId, view: "overview" } });
  return { transaction, source, credential, query };
}

test("finite compaction RPCs retain their remaining wait across one actual pause", async () => {
  const f = await fixture();
  try {
    const [read, checked, returned, usage, released, guarded, committed, revoked, submitted] =
      await Promise.all(Array.from({ length: 9 }, () => nativeSource(f)));
    const checkReceipt = await checked!.query();
    const returnReceipt = await returned!.query();
    f.broker.revokeCompactionContext(released!.source.compactionToken);
    const surface = "rpc-wait-manual-surface-1234567890";
    const manual = await f.remote.registerSafe(environment, surface, 60_000, "manual", { compaction: true });
    const started = await f.remote.registerSafe(environment, surface, 60_000, "manual", { compaction: true, requireSentConfirmation: false });
    const retiring = await f.remote.registerSafe(environment, surface, 60_000, "manual", { compaction: true });
    const retiringOrdinary = await f.remote.registerSafe(environment, surface, 60_000, "retained-safe");
    const aborting = await f.remote.beginCompactionTransaction("abort", 60_000);
    const calls = [
      f.remote.beginCompactionTransaction("begin-after-pause", 60_000),
      f.remote.registerSafe(environment, surface, 60_000, "new-manual", { compaction: true }),
      read!.query(),
      callTurnBroker(f.socket, { ...checked!.credential, method: "context_return_check", receiptId: checkReceipt.receiptId }),
      callTurnBroker(f.socket, { ...returned!.credential, method: "context_return", receiptId: returnReceipt.receiptId, sent: true }),
      f.remote.contextUsage(usage!.source.compactionToken),
      f.remote.releaseContextUsage(released!.source.compactionToken),
      f.remote.markCompactionContextDelivered(guarded!.source.compactionToken),
      f.remote.guardCompactionContextCommit(guarded!.source.compactionToken),
      f.remote.commitCompactionContext(committed!.source.compactionToken),
      f.remote.revokeCompactionContext(revoked!.source.compactionToken),
      callTurnBroker(f.socket, { method: "submit_compaction_handoff", token: submitted!.transaction.token,
        handoffId: submitted!.transaction.handoffId, summary: "Preserved original source summary" }),
      f.remote.abortCompactionTransaction(aborting.token),
      f.remote.confirmSafeTurnSent(manual, surface),
      callTurnBroker(f.socket, { method: "safe_start", token: started }),
      f.remote.revokeTrusted(retiring),
      f.remote.assertRecoveryFencing({ compaction: true }),
      f.remote.revoke(retiringOrdinary, undefined, undefined, { compaction: true }),
    ];
    // All client timers exist before the owner can receive any request.
    const results = Promise.all(calls);
    const before = chatGptSuspensionClock.suspendedMs();
    suspend();
    const values = await results;
    expect(chatGptSuspensionClock.suspendedMs() - before).toBeGreaterThan(5_000);
    expect(values[1]).toMatch(/^request_compaction_[A-Za-z0-9_-]{32}$/);
    expect(values[2]).toHaveProperty("receiptId");
    expect(values[3]).toEqual({ active: true });
    expect(values[11]).toEqual({ submitted: true });
    expect(values[14]).toMatchObject({ started: true });
    await expect(callTurnBroker(f.socket, { method: "submit_compaction_handoff", token: submitted!.transaction.token,
      handoffId: submitted!.transaction.handoffId, summary: "replay must not consume again" })).rejects.toThrow();
    await expect(revoked!.query()).rejects.toThrow();
  } finally { await f.close(); }
}, 20_000);

// Delay only bytes on the real socket boundary. Owner and MCP methods remain intact.
async function pausingProxy(target: string, method: string) {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-rpc-proxy-"));
  const path = defaultBrokerEndpoint(directory);
  if (process.platform !== "win32") mkdirSync(dirname(path), { recursive: true });
  const sockets = new Set<Socket>();
  let paused = false;
  const server = createServer(downstream => {
    const upstream = createConnection(target);
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    }
    upstream.pipe(downstream);
    let buffered = "";
    downstream.on("data", chunk => {
      if (buffered === "forwarded") { upstream.write(chunk); return; }
      buffered += chunk.toString();
      if (!buffered.includes("\n")) return;
      if (!paused && JSON.parse(buffered.split("\n")[0]!).method === method) { paused = true; suspend(); }
      upstream.write(buffered); buffered = "forwarded";
    });
    downstream.on("end", () => upstream.end());
    downstream.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { path, paused: () => paused, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  } };
}

for (const phase of ["context_return_check", "context_control_return"] as const) {
  test(`actual MCP Safe control receipt survives suspension at ${phase}`, async () => {
    const f = await fixture();
    const proxy = await pausingProxy(f.socket, phase);
    const mcp = await createContinuityMcpClient({ brokerSocketPath: proxy.path, contract: "safe", transport: "in-process" });
    try {
      const token = await f.remote.registerSafe(environment, "rpc-control-surface-1234567890", 60_000, "retained-safe", { requireSentConfirmation: false });
      f.broker.startSafeTurn(token);
      const source = f.broker.registerCompactionContext({ snapshot: snapshot(), contract: "safe", turnToken: token,
        handoffId: "safe:receipt", historyRevision: 0, ownerGeneration: "page", expiresAt: Date.now() + 60_000 });
      f.broker.requestCompaction(token, { content: [{ type: "text", text: `Read the source ${source.compactionToken}` }] });
      const before = chatGptSuspensionClock.suspendedMs();
      const result = await mcp.client.callTool({ name: "codex_tool_inventory", arguments: { request_id: token, operation_id: 1 } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain(source.compactionToken);
      // The transport settles its receipt after sending the result. A following
      // call must see the source delivered, without repeating a business operation.
      const read = await mcp.client.callTool({ name: "codex_context_list", arguments: {
        compaction_token: source.compactionToken, context_id: source.contextId, view: "overview",
      } });
      expect(read.isError).not.toBe(true);
      expect(proxy.paused()).toBe(true);
      expect(chatGptSuspensionClock.suspendedMs() - before).toBeGreaterThan(5_000);
      expect(await f.remote.compactionDeliveryCount(token)).toBe(1);
    } finally { await mcp.close(); await proxy.close(); await f.close(); }
  }, 20_000);
}

async function unresponsivePeer() {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-rpc-peer-"));
  const path = defaultBrokerEndpoint(directory);
  if (process.platform !== "win32") mkdirSync(dirname(path), { recursive: true });
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.resume(); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { path, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  } };
}

test("compaction finite waits still time out while awake and respect cancellation", async () => {
  const peer = await unresponsivePeer();
  try {
    await expect(callTurnBroker(peer.path, { method: "owner_compaction_transaction_begin" }, 40)).rejects.toBeInstanceOf(TurnBrokerTimeoutError);
    await expect(callTurnBroker(peer.path, { method: "owner_compaction_transaction_begin" }, 0)).rejects.toBeInstanceOf(TurnBrokerTimeoutError);
    const abort = new AbortController();
    const pending = callTurnBroker(peer.path, { method: "owner_compaction_transaction_begin" }, 5_000, abort.signal);
    const rejected = pending.catch(error => error);
    abort.abort(); expect(await rejected).toMatchObject({ name: "AbortError" });
    await expect(callTurnBroker(peer.path, { method: "owner_compaction_transaction_begin" }, 5_000, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    const unlimitedAbort = new AbortController();
    const unlimited = callTurnBroker(peer.path, { method: "owner_compaction_transaction_begin" }, null, unlimitedAbort.signal);
    const cancelled = unlimited.catch(error => error);
    unlimitedAbort.abort(); expect(await cancelled).toMatchObject({ name: "AbortError" });
  } finally { await peer.close(); }
});

test("an ordinary RPC keeps its original finite timeout across the same pause", async () => {
  const f = await fixture();
  try {
    const ordinary = await f.remote.registerSafe(environment, "rpc-ordinary-surface-1234567890", 60_000, "ordinary", { requireSentConfirmation: false });
    expect(ordinary).toMatch(/^request_[A-Za-z0-9_-]{32}$/);
    const tagged = await f.remote.registerSafe(environment, "rpc-tagged-surface-1234567890", 1_000, "manual-expiry",
      { compaction: true, requireSentConfirmation: false });
    const authority = callTurnBroker(f.socket, { method: "safe_start", token: tagged }).catch(error => error);
    const rejected = callTurnBroker(f.socket, { method: "safe_start", token: ordinary }).catch(error => error);
    suspend(); expect(await rejected).toBeInstanceOf(TurnBrokerTimeoutError);
    // The purpose marker pauses transport waiting, never an ordinary Safe TTL.
    const expired = await authority;
    expect(expired).toBeInstanceOf(Error);
    expect(expired).not.toBeInstanceOf(TurnBrokerTimeoutError);
    // A spelling marker never supplies owner authority.
    await expect(callTurnBroker(f.socket, { method: "safe_start", token: `request_compaction_${"x".repeat(32)}` })).rejects.toThrow();
  } finally { await f.close(); }
}, 15_000);
