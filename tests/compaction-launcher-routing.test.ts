import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createSessionContinuityFixtures } from "./helpers/session-continuity-fixture";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ChatGptTurnSessions, chatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import type { BrokerWaitOptions } from "../src/adapters/chatgpt-web/turn-broker";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const manual of [false, true]) test(`${manual ? "Safe" : "Native"} compaction preserves its source across a suspended Launcher inspection`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const first = f.request();
  await f.run(first);
  const originalEndpoint = f.descriptor.control.endpoint;
  let pauses = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // Delay only the external HTTP boundary. The actual Launcher fixture,
    // adapter admission, compaction source and checkpoint code all execute.
    if (path === "/v1/turn/continuity" && pauses === 0) {
      pauses++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6100);
    }
    return fetch(new Request(`${originalEndpoint}${path}`, request));
  } });
  writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor,
    control: { ...f.descriptor.control, endpoint: `http://127.0.0.1:${proxy.port}` } }));
  try {
    const compact = structuredClone(first); compact._compactionRequest = true;
    expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(pauses).toBe(1);
    expect(f.pages.size).toBe(1);
    expect(f.submissions).toHaveLength(2);
  } finally {
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
    await proxy.stop(true);
  }
}, 25_000);

test("manual compaction passes local wait purpose while ordinary handoff keeps its defaults", async () => {
  const f = fixture(true, { mcpTransport: "in-process" });
  const methods = ["start", "waitSent", "waitTerminal", "markStarted", "end"] as const;
  const observations = methods.map(method => ({ method, spy: spyOn(f.manualControl, method) }));
  try {
    const first = f.request();
    await f.run(first);
    for (const { method, spy } of observations) {
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      const args = spy.mock.calls.at(-1)! as unknown[];
      expect(method === "waitSent" || method === "waitTerminal"
        ? (args[2] as { compaction?: boolean } | undefined)?.compaction : args[3]).toBeUndefined();
      spy.mockClear();
    }
    const compact = structuredClone(first); compact._compactionRequest = true;
    await f.run(compact);
    for (const { method, spy } of observations) {
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const args of spy.mock.calls as unknown[][]) {
        if (method === "waitSent" || method === "waitTerminal") expect(args[2]).toMatchObject({ compaction: true });
        else { expect(args[2]).toBeUndefined(); expect(args[3]).toEqual({ compaction: true }); }
      }
    }
  } finally { for (const { spy } of observations) spy.mockRestore(); }
}, 20_000);

test("compaction retirement passes its purpose to an original ordinary runtime and releases its actual page", async () => {
  const f = fixture(false);
  await f.run(f.request());
  const thread = continuityDigest(f.threadId);
  const registration = f.registrations.get(thread)!;
  const binding = continuityBindingsFor(f.statePath).lookup(thread, registration.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const key = source.conversationKey()!;
  const release = spyOn(source.runtime, "releaseRetainedConversation");
  try {
    expect(await chatGptTurnSessions.retireConversationAndWait(key, { compaction: true })).toBe(1);
    expect(release.mock.calls).toEqual([[{ compaction: true }]]);
    expect(f.pages.size).toBe(0);
  } finally { release.mockRestore(); }
}, 15_000);

test("a compaction waiter cannot upgrade an ordinary retirement already waiting for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  const key = "a".repeat(64);
  let settle!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settle = resolve; });
  const releases: Array<BrokerWaitOptions | undefined> = [];
  sessions.getOrCreate("ordinary", () => ({ mode: "read-only", browser: Promise.resolve("done"), physicalSettlement,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey: key,
    async releaseRetainedConversation(wait) { releases.push(wait); }, cancel() {} }));
  const ordinary = sessions.retireConversationAndWait(key);
  const compaction = sessions.retireConversationAndWait(key, { compaction: true });
  expect(releases).toHaveLength(0);
  settle();
  expect(await ordinary).toBe(1);
  expect(await compaction).toBe(0);
  expect(releases).toEqual([undefined]);
  sessions.clear();
});


test("an active Safe handoff uses compaction waits when its original ordinary runtime settles", async () => {
  const f = fixture(true, { mcpTransport: "in-process", taskUpdates: true });
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const thread = continuityDigest(f.threadId);
  const registration = f.registrations.get(thread)!;
  const binding = continuityBindingsFor(f.statePath).lookup(thread, registration.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Accepted source result." },
  ]);
  compact._compactionRequest = true;
  const end = spyOn(f.manualControl, "end");
  const usage = spyOn(ContextSend.prototype, "syncUsage");
  const receipt = spyOn(f.broker, "taskOutputReceipt");
  let settledUsageWait: BrokerWaitOptions | undefined;
  let pauses = 0;
  const originalEndpoint = f.descriptor.control.endpoint;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/turn/continuity" && binding.state === "compacting" && end.mock.calls.length && !pauses) {
      settledUsageWait = usage.mock.calls.at(-1)?.[0];
      pauses++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6100);
    }
    return fetch(new Request(`${originalEndpoint}${path}`, request));
  } });
  writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor,
    control: { ...f.descriptor.control, endpoint: `http://127.0.0.1:${proxy.port}` } }));
  try {
    expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(pauses).toBe(1);
    expect(receipt.mock.calls.length).toBeGreaterThan(0);
    expect(usage.mock.calls.length).toBeGreaterThan(0);
    expect(settledUsageWait).toEqual({ compaction: true });
    expect(receipt.mock.calls.some(args => args[1]?.compaction === true)).toBe(true);
    expect(end.mock.calls).toHaveLength(1);
    expect(end.mock.calls[0]![3]).toEqual({ compaction: true });
    expect(f.pages.size).toBe(1);
    expect(f.submissions).toHaveLength(1);
    expect(source.outstanding()).toHaveLength(0);
  } finally {
    end.mockRestore(); usage.mockRestore(); receipt.mockRestore();
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
    await proxy.stop(true);
  }
}, 25_000);
