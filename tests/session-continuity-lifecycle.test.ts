import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityBindings, continuityDigest, type ContinuityBinding } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_IDLE_TTL_MS } from "../src/adapters/chatgpt-web/continuity-contract";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, type ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(maxEntries = 256) {
  const root = mkdtempSync(join(tmpdir(), "cgw-cont-lifecycle-"));
  roots.push(root);
  const store = new ContinuityRegistrationStore(root);
  store.initialize();
  const bindings = new ContinuityBindings(store);
  const sessions = new ChatGptTurnSessions(30 * 60_000, maxEntries);
  const cancelled: string[] = [];
  const bind = (name: string) => {
    const binding = bindings.create(continuityDigest(name), continuityDigest("scope"), name, continuityDigest(null));
    bindings.acceptLease(binding, { owner: binding.owner, leaseId: "6".repeat(32), traceId: `trace-${name}` });
    bindings.responseReady(binding, name);
    return binding;
  };
  const start = async (key: string, conversationKey: string, binding?: ContinuityBinding) => {
    const runtime: ChatGptTurnRuntime = {
      mode: "read-only", browser: Promise.resolve(`answer-${key}`), physicalSettlement: Promise.resolve(),
      text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(), conversationKey,
      ...(binding ? {
        continuityBinding: binding,
        usageInput: { _continuityHistoryRevision: binding.revision } as ChatGptTurnRuntime["usageInput"],
      } : {}),
      cancel: () => { cancelled.push(key); },
    };
    const session = sessions.getOrCreate(key, () => runtime, `trace-${key}`, "owner", key, "native-thread");
    await session.browserOutcome;
    await session.physicalSettlement;
    return session;
  };
  return { bindings, sessions, cancelled, bind, start };
}

test("continuity heads use the binding's 24-hour work clock; lookups and replay do not renew it", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture();
    const binding = f.bind("first");
    const head = await f.start("first", "page", binding);
    await f.start("legacy", "legacy-page");
    now += 31 * 60_000;
    expect(f.sessions.find("first")).toBe(head);
    expect(f.sessions.findConversationHead("page")).toBe(head);
    await head.runExclusive(async () => {});
    f.sessions.activeCount();
    expect(f.sessions.find("legacy")).toBeUndefined();
    expect(f.sessions.find("first")).toBe(head);
    expect(f.cancelled).toEqual(["legacy"]);
    expect(binding.lastUsedAt).toBe(1_000);
    now = 1_000 + CONTINUITY_IDLE_TTL_MS - 1;
    f.sessions.activeCount();
    expect(f.sessions.find("first")).toBe(head);
    now += 1;
    f.sessions.activeCount();
    expect(f.sessions.find("first")).toBeUndefined();
    expect(f.cancelled).toEqual(["legacy", "first"]);
  } finally { clock.mockRestore(); }
});

test("capacity reclaims historical continuity replay without cancelling the current page", async () => {
  const f = fixture(2);
  const binding = f.bind("old");
  await f.start("old", "page", binding);
  f.bindings.beginResponse(binding, "current");
  f.bindings.responseReady(binding, "current");
  const head = await f.start("current", "page", binding);
  expect(() => f.sessions.assertContinuityThreadAvailable("native-thread", "next")).not.toThrow();
  expect(f.sessions.find("old")).toBeUndefined();
  expect(binding.ordinaryReplayTombstones.get("old")).toMatchObject({ revision: 0 });
  expect(f.sessions.findConversationHead("page")).toBe(head);
  expect(f.cancelled).toEqual([]);
});

test("TTL reclaims historical continuity replay only after retaining its ordinary identity", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture();
    const binding = f.bind("old");
    await f.start("old", "page", binding);
    f.bindings.beginResponse(binding, "current");
    f.bindings.responseReady(binding, "current");
    const head = await f.start("current", "page", binding);

    now += 31 * 60_000;
    f.sessions.activeCount();

    expect(f.sessions.find("old")).toBeUndefined();
    expect(binding.ordinaryReplayTombstones.get("old")).toMatchObject({ revision: 0 });
    expect(f.sessions.findConversationHead("page")).toBe(head);
    expect(f.cancelled).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("TTL observation keeps historical continuity replay and continues pruning when the ordinary identity registry is full", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture();
    const binding = f.bind("old");
    const old = await f.start("old", "page", binding);
    f.bindings.beginResponse(binding, "current");
    f.bindings.responseReady(binding, "current");
    const head = await f.start("current", "page", binding);
    await f.start("legacy", "legacy-page");
    for (let index = 0; index < 256; index += 1) {
      binding.ordinaryReplayTombstones.set(`retained-${index}`, { revision: 0 });
    }

    now += 31 * 60_000;
    expect(f.sessions.activeCount()).toBe(0);

    expect(f.sessions.find("old")).toBe(old);
    expect(f.sessions.find("legacy")).toBeUndefined();
    expect(f.sessions.findConversationHead("page")).toBe(head);
    expect(f.cancelled).toEqual(["legacy"]);
  } finally { clock.mockRestore(); }
});

test("continuity admission still fails when full replay identity storage prevents required capacity reclaim", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(2);
    const binding = f.bind("old");
    const old = await f.start("old", "page", binding);
    f.bindings.beginResponse(binding, "current");
    f.bindings.responseReady(binding, "current");
    const head = await f.start("current", "page", binding);
    for (let index = 0; index < 256; index += 1) {
      binding.ordinaryReplayTombstones.set(`retained-${index}`, { revision: 0 });
    }

    now += 31 * 60_000;
    expect(f.sessions.activeCount()).toBe(0);
    expect(() => f.sessions.assertContinuityThreadAvailable("another-thread", "next")).toThrow("capacity");

    expect(f.sessions.find("old")).toBe(old);
    expect(f.sessions.findConversationHead("page")).toBe(head);
    expect(f.cancelled).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("continuity admission skips a replay-capacity-blocked history entry when another entry is safely reclaimable", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(3);
    const binding = f.bind("blocked");
    const blocked = await f.start("blocked", "page", binding);
    now += 1;
    f.bindings.beginResponse(binding, "reclaimable");
    f.bindings.responseReady(binding, "reclaimable");
    const reclaimable = await f.start("reclaimable", "page", binding);
    now += 1;
    f.bindings.beginResponse(binding, "current");
    f.bindings.responseReady(binding, "current");
    const head = await f.start("current", "page", binding);
    binding.ordinaryReplayTombstones.set("reclaimable", { revision: 0 });
    for (let index = 0; index < 255; index += 1) {
      binding.ordinaryReplayTombstones.set(`retained-${index}`, { revision: 0 });
    }

    expect(() => f.sessions.assertContinuityThreadAvailable("another-thread", "next")).not.toThrow();

    expect(f.sessions.find("blocked")).toBe(blocked);
    expect(f.sessions.find("reclaimable")).toBeUndefined();
    expect(f.sessions.findConversationHead("page")).toBe(head);
    expect(binding.ordinaryReplayTombstones.size).toBe(256);
    expect(f.cancelled).toEqual([]);
    expect(reclaimable.isPhysicallySettled()).toBe(true);
  } finally { clock.mockRestore(); }
});

test("capacity never evicts healthy current heads", async () => {
  const f = fixture(2);
  const first = await f.start("first", "first-page", f.bind("first"));
  const second = await f.start("second", "second-page", f.bind("second"));
  expect(() => f.sessions.assertContinuityThreadAvailable("another-thread", "third"))
    .toThrow("capacity");
  expect(f.sessions.findConversationHead("first-page")).toBe(first);
  expect(f.sessions.findConversationHead("second-page")).toBe(second);
  expect(f.cancelled).toEqual([]);
});

test("the accepted ordinary answer remains protected while a checkpoint has no next head", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(2);
    const binding = f.bind("source");
    const source = await f.start("source", "page", binding);
    f.bindings.beginCompaction(binding, "compact", "source");
    await f.sessions.retireContinuityExecution("source", source, "page", true);
    f.bindings.commitCompaction(binding, "compact", "source", "accepted checkpoint", true);
    const other = await f.start("other", "other-page", f.bind("other"));
    now += 31 * 60_000;
    f.sessions.activeCount();
    expect(f.sessions.find("source")).toBe(source);
    expect(f.sessions.findConversationHead("page")).toBeUndefined();
    expect(() => f.sessions.assertContinuityThreadAvailable("another-thread", "third"))
      .toThrow("capacity");
    expect(f.sessions.find("other")).toBe(other);
    expect(f.cancelled).toEqual([]);
  } finally { clock.mockRestore(); }
});
