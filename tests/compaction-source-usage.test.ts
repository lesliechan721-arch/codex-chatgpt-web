import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { CONTEXT_REUSE_PROTOCOL } from "../src/adapters/chatgpt-web/context-reuse-types";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { CompactionDeadline } from "../src/adapters/chatgpt-web/compaction-deadline";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { RemoteTurnBroker, TurnBroker, TurnBrokerTimeoutError, callTurnBroker, type BrokerWaitOptions } from "../src/adapters/chatgpt-web/turn-broker";

import { ChatGptTurnSession, ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { settleActiveZeroRiskCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CONTEXT_PROTOCOL_VERSION, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };
const environment = { authorityMode: "delegated" as const, threadId: "usage-thread", turnId: "usage-turn", tools: [] };
const canonical = () => parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
  instructions: "Preserve the original source. ".repeat(1100),
  input: [{ role: "user", id: "source-item", content: "Original user source" }],
});
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_100);
type Request = { method: string; token?: string; compaction?: true };

/** Only socket bytes are delayed. ContextSend, RemoteTurnBroker and the owner are real. */
async function fixture() {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-source-usage-"));
  const endpoint = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(endpoint);
  await broker.listen();
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  const hooks: { request?: (request: Request) => void | boolean | Promise<void | boolean>; response?: (request: Request) => void | Promise<void> } = {};
  const proxy = createServer(client => {
    const upstream = createConnection(endpoint);
    for (const socket of [client, upstream]) {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    }
    let input = "", output = "", request: Request;
    client.on("data", async chunk => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      request = JSON.parse(input.split("\n")[0]!); requests.push(request);
      if (await hooks.request?.(request) === false) return;
      upstream.write(input);
    });
    upstream.on("data", async chunk => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      await hooks.response?.(request);
      client.end(output);
    });
    client.on("close", () => upstream.destroy());
  });
  const path = endpoint + ".proxy";
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(path, resolve); });
  const remote = new RemoteTurnBroker(path);
  const token = await remote.registerSafe(environment, "usage-source-surface-1234567890", 3_600_000, "usage-source", { requireSentConfirmation: false });
  const input = canonical();
  const send = new ContextSend(input, remote, capabilities, "usage-page");
  const plan = await send.prepare(input, token, { manualControl: true });
  expect(plan.registration).toBeDefined();
  await send.select(token, plan); await send.sent(); broker.startSafeTurn(token);
  return { root, broker, remote, token, send, input, hooks, requests,
    async readOverview() {
      const credential = { token, contract: "safe" as const, credentialKind: "ordinary" as const, contextProtocol: CONTEXT_PROTOCOL_VERSION,
        contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: CONTEXT_REUSE_PROTOCOL };
      const reply = await callTurnBroker<ContextPreparedReply>(path, { ...credential, method: "context_query",
        contextMethod: "list", contextArgs: { context_id: plan.snapshot.context_id, view: "overview" } });
      await callTurnBroker(path, { ...credential, method: "context_return", receiptId: reply.receiptId, sent: true });
    },
    async close() {
      send.retire(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await broker.close(); rmSync(root, { recursive: true, force: true });
    } };
}

for (const method of ["owner_context_usage", "owner_context_usage_release"] as const) {
  test(`known compaction source synchronization survives a real pause at ${method}`, async () => {
    const f = await fixture();
    try {
      if (method === "owner_context_usage_release") await f.remote.revokeTrusted(f.token);
      const before = chatGptSuspensionClock.suspendedMs();
      const budget = new CompactionDeadline(Date.now() + 60_000);
      let paused = false;
      f.hooks.request = request => { if (!paused && request.method === method) { paused = true; pause(); } };
      await f.send.syncUsage({ compaction: true });
      expect(paused).toBe(true);
      expect(chatGptSuspensionClock.suspendedMs() - before).toBeGreaterThan(5_000);
      expect(budget.remainingMs()).toBeGreaterThan(55_000);
      expect(f.send.coverage.pageTokenReserve()).toBeGreaterThan(0);
    } finally { await f.close(); }
  }, 20_000);
}

function virtualTime() {
  let wall = Date.now(), elapsed = 0;
  const clock = new ChatGptSuspensionClock(1_000, 5_000, () => elapsed, () => wall);
  const spies = [spyOn(Date, "now").mockImplementation(() => wall),
    spyOn(performance, "now").mockImplementation(() => elapsed),
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(() => clock.suspendedMs())];
  return { sleep(ms: number) { wall += ms; elapsed += ms; },
    awake(ms: number) { while (ms > 0) { const step = Math.min(ms, 1_000); wall += step; elapsed += step; clock.tick(elapsed); ms -= step; } },
    rollback(ms: number) { wall -= ms; },
    restore() { for (const spy of spies.reverse()) spy.mockRestore(); } };
}

test("a known compaction retains final source cost evidence across a long detected pause", async () => {
  const f = await fixture();
  const time = virtualTime();
  try {
    await f.remote.revokeTrusted(f.token);
    f.hooks.request = request => { if (request.method === "owner_context_usage") { f.hooks.request = undefined; time.sleep(601_000); } };
    await f.send.syncUsage({ compaction: true });
    expect(f.send.coverage.pageTokenReserve()).toBeGreaterThan(0);
    expect(await f.remote.contextUsage(f.token)).toBeUndefined();
  } finally { time.restore(); await f.close(); }
});


test("the real active Safe compaction entry propagates usage purpose before its source handoff", async () => {
  const f = await fixture();
  let finishBrowser!: (text: string) => void;
  try {
    const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
    const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve(f.token),
      externalProgress: { recordToolResult() {} } as never, manualControl: { surfaceNonce: "usage-source-surface-1234567890" },
      browser, physicalSettlement: browser.then(() => undefined), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: f.input, compactionSourceCoverage: f.send.coverage, syncContextUsage: wait => f.send.syncUsage(wait), cancel() {},
    });
    let paused = false;
    f.hooks.request = request => { if (!paused && request.method === "owner_context_usage") { paused = true; pause(); } };
    let handoffQueued!: () => void;
    const queued = new Promise<void>(resolve => { handoffQueued = resolve; });
    f.hooks.response = request => { if (request.method === "owner_request_compaction") handoffQueued(); };
    const result = settleActiveZeroRiskCompactionSource({ ...f.input, _compactionRequest: true }, source, f.remote,
      undefined, undefined, undefined, false, capabilities);
    // Fail promptly if entry preparation fails, instead of waiting for an absent handoff.
    await Promise.race([queued, result.then(() => { throw new Error("The source handoff was not queued"); })]);
    const control = await callTurnBroker<{ contextControlReceipt: string }>(f.remote.socketPath, {
      method: "native_operation_start", token: f.token, contract: "safe", nativeWaitProtocol: 1,
      operationId: 1, entry: "codex_tool_inventory", nativeInput: {}, taskUpdateProtocol: 1,
    });
    await callTurnBroker(f.remote.socketPath, { method: "context_control_return", token: f.token, contract: "safe",
      contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: control.contextControlReceipt, sent: true });
    finishBrowser("Summary of the accepted original source");
    expect(await result).toBe("Summary of the accepted original source");
    expect(paused).toBe(true);
  } finally { finishBrowser?.("closed"); await f.close(); }
}, 20_000);

for (const executed of [false, true]) test(`queued compaction retries only release after an ordinary lost reply (executed=${executed})`, async () => {
  const f = await fixture();
  try {
    await f.readOverview();
    await f.remote.revokeTrusted(f.token);
    const evidence = await f.remote.contextUsage(f.token);
    expect(evidence?.final).toBe(true);
    const expected = f.send.coverage.pageTokenReserve() + evidence!.usage.text_tokens
      + evidence!.usage.visual_token_reserve - evidence!.reserved_tokens_used;
    const before = f.requests.length;
    let delayed = false;
    const delay = (request: Request) => {
      if (!delayed && request.method === "owner_context_usage_release") { delayed = true; pause(); return false; }
    };
    if (executed) f.hooks.response = request => { delay(request); };
    else f.hooks.request = delay;
    const ordinary = f.send.syncUsage().catch(error => error);
    const compaction = f.send.syncUsage({ compaction: true });
    expect(await ordinary).toBeInstanceOf(TurnBrokerTimeoutError);
    await compaction;
    expect(f.requests.slice(before).map(request => request.method)).toEqual([
      "owner_context_usage", "owner_context_usage_release", "owner_context_usage_release",
    ]);
    expect(f.send.coverage.pageTokenReserve()).toBe(expected);
    await f.send.syncUsage({ compaction: true });
    expect(f.send.coverage.pageTokenReserve()).toBe(expected);
    expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);

test("an already queued ordinary usage read cannot inherit a later compaction clock", async () => {
  const f = await fixture();
  try {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    f.hooks.request = async request => {
      if (request.method !== "owner_context_usage") return;
      if (++reads === 1) { enter(); await gate; }
      else if (reads === 2) pause();
    };
    const first = f.send.syncUsage(); await entered;
    const options: BrokerWaitOptions = {};
    const second = f.send.syncUsage(options).catch(error => error);
    const compaction = f.send.syncUsage({ compaction: true });
    options.compaction = true; // Mutation after enqueue must not change the captured purpose.
    release(); await first;
    expect(await second).toBeInstanceOf(TurnBrokerTimeoutError);
    await compaction;
    expect(reads).toBe(3);
  } finally { await f.close(); }
}, 20_000);

test("known compaction task-state and Session retirement keep their finite wait across a pause", async () => {
  const f = await fixture();
  const sessions = new ChatGptTurnSessions();
  try {
    const token = await f.remote.registerSafe(environment, "usage-task-state-surface-1234567890", 3_600_000, "task-state", { taskUpdateProtocol: 1, requireSentConfirmation: false });
    const source = sessions.getOrCreate("source", () => ({ mode: "read-only", browser: Promise.resolve("source answer"),
      physicalSettlement: Promise.resolve(), conversationKey: "usage-page", trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      retireCapability: async wait => {
        await f.remote.revokeTrusted(f.token, undefined, undefined, wait);
        await f.send.syncUsage(wait);
      }, cancel() {},
    }));
    await source.browserOutcome; await source.physicalSettlement;
    // Both real RPC timers exist before the event loop stops. Session retirement
    // supplies its own explicit purpose; ordinary automatic retirement remains separate.
    const state = f.remote.taskUpdateState(token, { compaction: true });
    const retired = sessions.retireContinuityExecution("source", source, "usage-page", true);
    pause();
    expect(await state).toHaveProperty("acceptedRevision", 0);
    await retired;
    expect(source.conversationKey()).toBeUndefined();
    expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
  } finally { sessions.clear(); await f.close(); }
}, 20_000);

test("an awake compaction usage wait fails finitely without an automatic retry", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    f.hooks.request = request => { if (request.method === "owner_context_usage") { reads++; return false; } };
    await expect(f.send.syncUsage({ compaction: true })).rejects.toBeInstanceOf(TurnBrokerTimeoutError);
    expect(reads).toBe(1);
  } finally { await f.close(); }
}, 10_000);

for (const awakeBeforePause of [0, 300_000]) test(`compaction usage retention is bounded and cannot revive expired evidence (awake=${awakeBeforePause})`, async () => {
  const f = await fixture();
  const time = virtualTime();
  try {
    await f.remote.revokeTrusted(f.token);
    time.awake(awakeBeforePause); time.sleep(601_000);
    expect(await f.remote.contextUsage(f.token)).toBeUndefined();
    const retained = await f.remote.contextUsage(f.token, { compaction: true });
    await expect(callTurnBroker(f.remote.socketPath, { method: "safe_start", token: f.token })).rejects.toThrow();
    if (awakeBeforePause) expect(retained).toBeUndefined();
    else {
      expect(retained?.final).toBe(true);
      time.awake(199_000);
      expect(await f.remote.contextUsage(f.token, { compaction: true })).toEqual(retained);
      time.sleep(601_000);
      expect(await f.remote.contextUsage(f.token, { compaction: true })).toEqual(retained);
      time.awake(99_000);
      expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
      time.rollback(1_500_000);
      expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
      expect(await f.remote.contextUsage(f.token)).toBeUndefined();
      // Repeated retirement of an already retired owner cannot create a new record.
      await f.remote.revokeTrusted(f.token);
      expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
    }
  } finally { time.restore(); await f.close(); }
});


test("a replacement Broker owner cannot recover retained usage from the previous owner", async () => {
  const f = await fixture();
  let replacement: TurnBroker | undefined;
  try {
    await f.remote.revokeTrusted(f.token);
    expect((await f.remote.contextUsage(f.token, { compaction: true }))?.final).toBe(true);
    await f.broker.close();
    replacement = TurnBroker.forSocket(f.broker.socketPath);
    await replacement.listen();
    expect(await f.remote.contextUsage(f.token, { compaction: true })).toBeUndefined();
  } finally { await replacement?.close(); await f.close(); }
});

test("an already cancelled compaction cannot start usage synchronization or a source handoff", async () => {
  const f = await fixture();
  try {
    const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve(f.token),
      externalProgress: { recordToolResult() {} } as never, manualControl: { surfaceNonce: "usage-source-surface-1234567890" },
      browser: new Promise<string>(() => {}), physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: f.input, compactionSourceCoverage: f.send.coverage, syncContextUsage: wait => f.send.syncUsage(wait), cancel() {},
    });
    const before = f.requests.length;
    await expect(settleActiveZeroRiskCompactionSource({ ...f.input, _compactionRequest: true }, source, f.remote,
      AbortSignal.abort(new DOMException("Stopped", "AbortError")), undefined, undefined, false, capabilities)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.requests.length).toBe(before);
  } finally { await f.close(); }
});

for (const compaction of [false, true]) test(`settled Safe output receipt retains only its explicit RPC wait purpose (${compaction})`, async () => {
  const f = await fixture();
  try {
    const token = await f.remote.registerSafe(environment, "receipt-source-surface-1234567890", 3_600_000, "receipt-source",
      { requireSentConfirmation: false, taskUpdateProtocol: 1 });
    f.broker.startSafeTurn(token);
    f.broker.completeSafeTurn(token, "Accepted final source answer", 0);
    const expected = f.broker.taskOutputReceipt(token);
    expect(expected).toBeDefined();
    let paused = false;
    f.hooks.request = request => { if (request.method === "owner_output_receipt") { paused = true; pause(); } };
    const outcome = await f.remote.taskOutputReceipt(token, compaction ? { compaction: true } : undefined)
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(paused).toBe(true);
    if (compaction) { expect(outcome.error).toBeUndefined(); expect(outcome.value).toEqual(expected); }
    else expect(outcome.error).toBeInstanceOf(TurnBrokerTimeoutError);
    expect(f.broker.taskOutputReceipt(token)).toEqual(expected);
  } finally { await f.close(); }
}, 15_000);
