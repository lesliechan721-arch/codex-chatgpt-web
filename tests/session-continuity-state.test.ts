import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContinuityRegistrationStore,
  MAX_CONTINUITY_REGISTRATIONS,
  MAX_CONTINUITY_REGISTRATION_BYTES,
} from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityBindings, CONTINUITY_IDLE_TTL_MS, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";

const roots: string[] = [];
const thread = "1".repeat(64);
const scope = "2".repeat(64);
const owner = "3".repeat(64);
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "cgw-continuity-state-"));
  roots.push(path);
  return { path, store: new ContinuityRegistrationStore(path) };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("registration requires controlled initialization and contains no task content", () => {
  const { path, store } = fixture();
  expect(() => store.get(thread)).toThrow("not initialized");
  store.initialize();
  expect(store.get(thread)).toBeUndefined();
  expect(store.claim(thread, scope, owner)).toEqual({ scope, owner, state: "entered" });
  expect(store.get(thread)).toEqual({ scope, owner, state: "entered" });
  const document = JSON.parse(readFileSync(join(path, "threads.json"), "utf8"));
  expect(Object.keys(document).sort()).toEqual(["entries", "installation", "version"]);
  expect(document.entries).toEqual({ [thread]: { scope, owner, state: "entered" } });
  expect(Object.keys(document.entries[thread]).sort()).toEqual(["owner", "scope", "state"]);
});

test("reopening the store never grants a second thread creation right", () => {
  const { path, store } = fixture();
  store.initialize();
  store.claim(thread, scope, owner);
  const replacement = new ContinuityRegistrationStore(path);
  replacement.initialize();
  expect(replacement.claim(thread, "4".repeat(64), "5".repeat(64))).toEqual({ scope, owner, state: "entered" });
  expect(replacement.get(thread)?.owner).toBe(owner);
  store.finish(thread, owner, "lost");
  expect(replacement.claim(thread, scope, owner)?.state).toBe("lost");
  expect(() => replacement.finish(thread, "5".repeat(64), "ended")).toThrow("owner");
});

test("an initialized but missing, corrupt, mismatched or oversized store fails closed", () => {
  const { path, store } = fixture();
  store.initialize();
  const file = join(path, "threads.json");
  const original = readFileSync(file, "utf8");
  rmSync(file);
  expect(() => store.initialize()).toThrow();
  expect(() => store.claim(thread, scope, owner)).toThrow();
  for (const contents of ["{", "{}", JSON.stringify({ ...JSON.parse(original), installation: "0".repeat(64) }),
    " ".repeat(MAX_CONTINUITY_REGISTRATION_BYTES + 1)]) {
    writeFileSync(file, contents);
    expect(() => store.get(thread)).toThrow();
    expect(() => store.initialize()).toThrow();
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("full registration storage preserves every old entry and still permits known-thread reads", () => {
  const { path, store } = fixture();
  store.initialize();
  const file = join(path, "threads.json");
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.entries = Object.fromEntries(Array.from({ length: MAX_CONTINUITY_REGISTRATIONS }, (_, i) => [
    i.toString(16).padStart(64, "0"), { scope, owner, state: "entered" },
  ]));
  const before = JSON.stringify(document);
  writeFileSync(file, before);
  expect(store.claim("0".repeat(64), scope, owner)).toEqual({ scope, owner, state: "entered" });
  expect(() => store.claim(thread, scope, owner)).toThrow("capacity");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a concurrent mutation is rejected without replacing its owner's lock or registry", () => {
  const { path, store } = fixture();
  store.initialize();
  writeFileSync(join(path, "write.lock"), "other-owner");
  expect(() => store.claim(thread, scope, owner)).toThrow("busy");
  expect(readFileSync(join(path, "write.lock"), "utf8")).toBe("other-owner");
  expect(store.get(thread)).toBeUndefined();
});

test("live binding keeps the page across an authenticated checkpoint and rejects arbitrary revision changes", () => {
  const { store } = fixture();
  store.initialize();
  const bindings = new ContinuityBindings(store, owner);
  const initial = continuityDigest(null);
  const binding = bindings.create(thread, scope, "exec-0", initial);
  expect(bindings.beginResponse(binding, "exec-0")).toEqual({ owner });
  const lease = { owner, leaseId: "6".repeat(32), traceId: "trace-first" };
  bindings.acceptLease(binding, lease);
  bindings.responseReady(binding, "exec-0");
  expect(bindings.beginCompaction(binding, "compact-0", "exec-0")).toEqual({ owner, expected: lease });
  expect(() => bindings.beginResponse(binding, "racing-response")).toThrow();
  expect(() => bindings.commitCompaction(binding, "other-compact", "exec-0", "summary")).toThrow();
  const compactLease = { ...lease, traceId: "trace-compact" };
  bindings.acceptLease(binding, compactLease);
  bindings.commitCompaction(binding, "compact-0", "exec-0", "accepted summary");
  expect(binding.revision).toBe(1);
  expect(bindings.revisionFor(binding, initial)).toBe(0);
  expect(bindings.revisionFor(binding, continuityDigest("accepted summary"))).toBe(1);
  expect(() => bindings.revisionFor(binding, continuityDigest("invented summary"))).toThrow();
  expect(() => bindings.assertCompactionReplay(binding, "compact-0", 0)).not.toThrow();
  expect(() => bindings.assertCompactionReplay(binding, "compact-0", 1)).toThrow();
  expect(bindings.beginResponse(binding, "exec-1")).toEqual({ owner, expected: compactLease });
  bindings.lose(binding, "exec-0");
  expect(binding.state).toBe("running");
  expect(binding.lease?.leaseId).toBe(lease.leaseId);
});

test("a restart, changed scope, or expired idle binding cannot create a replacement page", () => {
  const { store } = fixture();
  store.initialize();
  let now = 1_000;
  const bindings = new ContinuityBindings(store, owner, () => now);
  const binding = bindings.create(thread, scope, "exec-0", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "trace-first" });
  bindings.responseReady(binding, "exec-0");
  expect(() => new ContinuityBindings(store, "7".repeat(64)).lookup(thread, scope)).toThrow();
  expect(() => new ContinuityBindings(store, owner).lookup(thread, scope)).toThrow();
  expect(() => bindings.lookup(thread, "8".repeat(64))).toThrow();
  now += CONTINUITY_IDLE_TTL_MS - 1;
  expect(bindings.lookup(thread, scope)).toBe(binding);
  expect(binding.lastUsedAt).toBe(1_000);
  now += 1;
  expect(() => bindings.lookup(thread, scope)).toThrow("24-hour");
  expect(store.get(thread)?.state).toBe("lost");
  expect(() => bindings.create(thread, scope, "exec-1", continuityDigest(null))).toThrow();
});

test("abandoning an undelivered compaction restores a running source without exposing it to ready TTL", () => {
  const { store } = fixture();
  store.initialize();
  let now = 1_000;
  const bindings = new ContinuityBindings(store, owner, () => now);
  const binding = bindings.create(thread, scope, "source", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "source-trace" });
  expect(binding.state).toBe("running");

  bindings.beginCompaction(binding, "compact", "source", 100);
  expect(binding.state).toBe("compacting");
  bindings.abandonUndeliveredCompaction(binding, "compact", "source");

  expect(binding.state).toBe("running");
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  now += CONTINUITY_IDLE_TTL_MS;
  expect(bindings.lookup(thread, scope)).toBe(binding);
  expect(binding.state).toBe("running");
  expect(store.get(thread)?.state).toBe("entered");
});

test("concurrent first requests receive one creation transaction and ending it never resets registration", () => {
  const { store } = fixture();
  store.initialize();
  const bindings = new ContinuityBindings(store, owner);
  const binding = bindings.create(thread, scope, "exec-0", continuityDigest(null));
  expect(bindings.create(thread, scope, "exec-0", continuityDigest(null))).toBe(binding);
  expect(() => bindings.create(thread, scope, "exec-1", continuityDigest(null))).toThrow();
  bindings.end(binding);
  expect(store.get(thread)?.state).toBe("ended");
  expect(() => bindings.create(thread, scope, "exec-0", continuityDigest(null))).toThrow();
});

test("an accepted but unsettled handoff remains evidence after loss, never a committed revision", () => {
  const { store } = fixture();
  store.initialize();
  const bindings = new ContinuityBindings(store, owner);
  const binding = bindings.create(thread, scope, "source", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "source-trace" });
  bindings.responseReady(binding, "source");
  bindings.beginCompaction(binding, "compact", "source", 100);
  bindings.acceptCompactionHandoff(binding, "compact", "source", "Accepted real summary");
  const accepted = binding.acceptedHandoff;
  expect(accepted).toMatchObject({ key: "compact", sourceExecutionKey: "source", sourceRevision: 0, summary: "Accepted real summary" });
  expect(() => bindings.acceptCompactionHandoff(binding, "compact", "source", "Different summary")).toThrow();
  bindings.lose(binding);
  bindings.lose(binding);
  expect(binding.acceptedHandoff).toBe(accepted);
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(store.get(thread)?.state).toBe("lost");
  expect(() => bindings.commitCompaction(binding, "compact", "source", "Accepted real summary")).toThrow();
  expect(() => bindings.create(thread, scope, "new-attempt", continuityDigest(null))).toThrow();
});

test("losing a committed page preserves its result while disabling all continuity replay authority", () => {
  const { store } = fixture();
  store.initialize();
  const bindings = new ContinuityBindings(store, owner);
  const binding = bindings.create(thread, scope, "source", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "source-trace" });
  bindings.responseReady(binding, "source");
  bindings.beginCompaction(binding, "compact", "source");
  bindings.commitCompaction(binding, "compact", "source", "Unique committed summary");
  const committed = binding.checkpoints.get("compact");
  bindings.lose(binding);
  expect(binding.checkpoints.get("compact")).toBe(committed);
  expect(committed?.summary).toBe("Unique committed summary");
  expect(binding.revisions.get(continuityDigest("Unique committed summary"))).toBe(1);
  expect(() => bindings.assertCompactionReplay(binding, "compact", 0)).toThrow();
});

test("source evidence is charged before control and together with its bounded summary", () => {
  const { store } = fixture();
  store.initialize();
  const bindings = new ContinuityBindings(store, owner);
  const binding = bindings.create(thread, scope, "source", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "source-trace" });
  bindings.responseReady(binding, "source");
  expect(() => bindings.beginCompaction(binding, "compact", "source", 2 * 1024 * 1024)).toThrow("capacity");
  expect(binding.state).toBe("ready");
  bindings.beginCompaction(binding, "compact", "source", 200);
  expect(() => bindings.acceptCompactionHandoff(binding, "compact", "source", "x".repeat(2 * 1024 * 1024 - 199))).toThrow();
  expect(binding.acceptedHandoff).toBeUndefined();
  bindings.commitCompaction(binding, "compact", "source", "valid");
  expect(binding.checkpoints.get("compact")?.bytes).toBe(205);
});

test("terminal evidence keeps the aggregate budget until its ordinary replay retention expires", () => {
  const { store } = fixture();
  store.initialize();
  let now = 1_000;
  const bindings = new ContinuityBindings(store, owner, () => now);
  const ready = (index: number) => {
    const binding = bindings.create(continuityDigest(index), scope, `source-${index}`, continuityDigest(null));
    bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: `source-trace-${index}` });
    bindings.responseReady(binding, `source-${index}`);
    return binding;
  };
  const first = ready(0);
  for (let index = 0; index < 12; index++) {
    const binding = index === 0 ? first : ready(index);
    bindings.beginCompaction(binding, `compact-${index}`, `source-${index}`, 16);
    bindings.commitCompaction(binding, `compact-${index}`, `source-${index}`, "x".repeat(2 * 1024 * 1024 - 16));
  }
  bindings.lose(first);
  const next = ready(12);
  expect(() => bindings.beginCompaction(next, "compact-next", "source-12")).toThrow("capacity");
  expect(first.checkpoints.get("compact-0")?.summary.length).toBe(2 * 1024 * 1024 - 16);
  now += 30 * 60_000 + 1;
  expect(() => bindings.beginCompaction(next, "compact-next", "source-12")).not.toThrow();
  expect(first.checkpoints.size).toBe(0);
  expect(store.get(first.thread)?.state).toBe("lost");
});
