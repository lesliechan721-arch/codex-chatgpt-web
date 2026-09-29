const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONTINUITY_IDLE_TTL_MS, assertContinuityStart, bindContinuityTab,
  continuityLease, continuityExpired, inspectContinuityConversation,
} = require("../electron/continuity-lease.cjs");
const { releaseRetainedConversation } = require("../electron/retained-turn-release.cjs");

const owner = "a".repeat(64);
const key = "b".repeat(64);
function tabFixture() {
  const tab = { id: "tab", traceId: "first-trace", helperPid: 1, conversationKey: key,
    status: "running", interactionMode: "manual",
    view: { webContents: { isDestroyed: () => false,
      executeJavaScript: () => { throw new Error("Manual continuity must not inspect DOM"); } } } };
  bindContinuityTab(tab, { owner });
  return tab;
}

test("first claim cannot adopt any existing page and retries require the same exact owner", () => {
  assert.doesNotThrow(() => assertContinuityStart(undefined, { owner }, "first-trace", 1));
  const tab = tabFixture();
  assert.doesNotThrow(() => assertContinuityStart(tab, { owner }, "first-trace", 1));
  for (const [claim, trace, pid] of [[undefined, "first-trace", 1], [{ owner }, "new-trace", 1],
    [{ owner }, "first-trace", 2], [{ owner: "c".repeat(64) }, "first-trace", 1]]) {
    assert.throws(() => assertContinuityStart(tab, claim, trace, pid), /continuity|conversation/);
  }
  assert.throws(() => assertContinuityStart({ ...tab, continuityOwner: undefined }, { owner }, "first-trace", 1));
});

test("resume proves the exact head and lease before mutation; lost acknowledgements are idempotent", () => {
  const tab = tabFixture();
  tab.status = "ready";
  tab.continuityLastSuccessAt = Date.now();
  const expected = continuityLease(tab);
  const claim = { owner, expected };
  assert.doesNotThrow(() => assertContinuityStart(tab, claim, "second-trace", 1));
  for (const wrong of [{ ...expected, owner: "c".repeat(64) }, { ...expected, leaseId: "c".repeat(32) },
    { ...expected, traceId: "stale-trace" }]) {
    assert.throws(() => assertContinuityStart(tab, { owner: wrong.owner, expected: wrong }, "second-trace", 1));
  }
  assert.throws(() => assertContinuityStart(undefined, claim, "second-trace", 1));
  tab.traceId = "second-trace";
  tab.status = "running";
  bindContinuityTab(tab, claim);
  assert.doesNotThrow(() => assertContinuityStart(tab, claim, "second-trace", 1));
  assert.throws(() => assertContinuityStart(tab, claim, "third-trace", 1));
});

test("inspection does not read DOM, refresh idle time, or accept a replaced physical document", () => {
  const tab = tabFixture();
  tab.status = "ready";
  tab.continuityLastSuccessAt = Date.now() - 1_000;
  const expected = continuityLease(tab);
  const host = { turnTabs: new Map([[tab.id, tab]]) };
  const before = tab.continuityLastSuccessAt;
  assert.deepEqual(inspectContinuityConversation(host, key, expected), { continuity: expected, state: "ready" });
  assert.equal(tab.continuityLastSuccessAt, before);
  tab.view.webContents.isDestroyed = () => true;
  assert.throws(() => inspectContinuityConversation(host, key, expected));
});

test("the 24-hour boundary is idle-based and heartbeats cannot extend a retained page", () => {
  const tab = tabFixture();
  tab.status = "ready";
  tab.continuityLastSuccessAt = 1_000;
  tab.lastHeartbeatAt = Number.MAX_SAFE_INTEGER;
  assert.equal(continuityExpired(tab, 1_000 + CONTINUITY_IDLE_TTL_MS - 1), false);
  assert.equal(continuityExpired(tab, 1_000 + CONTINUITY_IDLE_TTL_MS), true);
  tab.status = "running";
  assert.equal(continuityExpired(tab, 1_000 + CONTINUITY_IDLE_TTL_MS), false);
});

test("an old cleanup cannot release the next head of the same physical conversation", () => {
  const tab = tabFixture();
  const old = continuityLease(tab);
  tab.traceId = "new-head";
  tab.status = "ready";
  tab.continuityLastSuccessAt = Date.now();
  let removed = 0;
  const host = { turnTabs: new Map([[tab.id, tab]]), removeTurnTab: () => { removed += 1; }, logger: { info() {} } };
  assert.throws(() => releaseRetainedConversation(host, key));
  assert.throws(() => releaseRetainedConversation(host, key, old));
  assert.equal(removed, 0);
  assert.equal(releaseRetainedConversation(host, key, continuityLease(tab)), 1);
  assert.equal(removed, 1);
});
