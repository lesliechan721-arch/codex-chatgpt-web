import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContinuityRegistrationStore,
  MAX_CONTINUITY_REGISTRATIONS,
  MAX_CONTINUITY_REGISTRATION_BYTES,
} from "../src/adapters/chatgpt-web/continuity-registration";
import {
  ContinuityBindings, CONTINUITY_IDLE_TTL_MS, continuityBindingsFor, continuityDigest,
  continuitySourceRepresentationDigest, selectContinuityCheckpoint,
} from "../src/adapters/chatgpt-web/continuity-binding";
import { parseRequest } from "../src/responses/parser";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { acceptRecoveryResults, evictOptionalRecoveryResults, recoveryContext, recoveryDigest, type RuntimeRecoveryReference } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { continuityCurrentInstructionInput, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptContinuityInstructionPayloadDigest, continuityInstructionIdentity } from "../src/adapters/chatgpt-web/turn-execution";
import { stopDurableContinuity } from "../src/adapters/chatgpt-web/continuity-lifecycle";

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

for (const recovery of ["no-checkpoint", "no-match", "distinct-instruction"] as const) test(`request identification stays linear with ${recovery}`, () => {
  const capture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol.json"), "utf8"));
  const ordinary = capture.captured.find((entry: { label: string; replay?: boolean }) => entry.label === "ordinary" && !entry.replay);
  const measurements = [100, 200, 400].map(pairs => {
    const { path, store } = fixture();
    store.initialize();
    const bindings = continuityBindingsFor(path);
    const body = structuredClone(ordinary.body);
    const current = body.input.pop();
    const parsedIdentity = extractChatGptTurnIdentity(parseRequest(body));
    const identity = { ...parsedIdentity, threadId: `linear-identification-${path}` };
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId });
    for (let index = 0; index < pairs; index += 1) body.input.push(
      { type: "message", role: "user", id: `old-${index}`, content: `Completed instruction ${index}`,
        internal_chat_message_metadata_passthrough: { turn_id: `completed-${index}` } },
      { type: "message", role: "assistant", content: `Completed answer ${index}` },
    );
    const source = { itemId: "checkpoint-source", turnId: "checkpoint-source-turn", content: "Committed source.",
      instructionEnvelope: { role: "user" } };
    const summary = "Committed source checkpoint.";
    if (recovery !== "no-checkpoint") body.input.push({ type: "compaction",
      encrypted_content: encodeCompactionSummary(recovery === "no-match" ? "Unrelated checkpoint." : summary) });
    body.input.push(current);
    const parsed = parseRequest({ ...body, model: "gpt-5.6-sol" });
    parsed._conversationPolicy = "continuity-first";
    parsed._continuityScope = scope;
    parsed._continuityHistoryRevision = 0;
    const binding = bindings.create(continuityDigest(identity.threadId), scope, "source-execution", continuityDigest(null));
    if (recovery !== "no-checkpoint") {
      bindings.acceptLease(binding, { owner: bindings.owner, leaseId: "1".repeat(32), traceId: "2".repeat(12) });
      bindings.responseReady(binding, "source-execution");
      bindings.beginCompaction(binding, "compact-execution", "source-execution", 1024);
      bindings.commitCompaction(binding, "compact-execution", "source-execution", summary, false, undefined, undefined,
        source, [continuitySourceRepresentationDigest(parsed, source)], identity.turnId);
    }
    let reads = 0;
    const input = (parsed._rawBody as { input: unknown[] }).input;
    input.forEach((item, index) => Object.defineProperty(input, index, {
      configurable: true, enumerable: true, get: () => { reads += 1; return item; },
    }));
    const registrations = spyOn(bindings.registrations, "get");
    try {
      const session = new ChatGptTurnSession({ mode: "read-only", browser: new Promise<string>(() => {}),
        physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} });
      const selected = continuityCurrentInstructionInput(parsed);
      session.acceptCanonicalInput(parsed);
      session.assertCanonicalReplayInput(parsed);
      expect(continuityInstructionIdentity(parsed)).toBe(current.id);
      expect(chatGptContinuityInstructionPayloadDigest(parsed)).toBeDefined();
      expect(JSON.stringify(selected)).toContain("DEVELOPER_MARKER");
      expect(JSON.stringify(selected)).toContain("ORDINARY_MARKER");
      expect(JSON.stringify(selected)).not.toContain("Completed instruction");
      expect(selectContinuityCheckpoint(parsed, identity)).toBeUndefined();
      expect(registrations.mock.calls.length).toBeLessThanOrEqual(4);
      expect(reads).toBeLessThan(input.length * 30);
      return { size: input.length, reads };
    } finally { registrations.mockRestore(); }
  });
  for (let index = 1; index < measurements.length; index += 1) {
    expect(measurements[index]!.reads / measurements[index - 1]!.reads).toBeLessThan(2.3);
  }
});

test("request checkpoint selection cannot revive a reclaimed authoritative source record", () => {
  const { path, store } = fixture();
  store.initialize();
  const bindings = continuityBindingsFor(path);
  const identity = { threadId: `record-reclamation-${path}`, turnId: "source-turn" };
  const source = { itemId: "source-item", turnId: identity.turnId, content: "Full accepted source instruction.",
    instructionEnvelope: { role: "user" } };
  const summary = "Committed source checkpoint.";
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
    { type: "message", role: "user", id: source.itemId, content: source.content,
      internal_chat_message_metadata_passthrough: { turn_id: identity.turnId } },
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
  ] });
  parsed._conversationPolicy = "continuity-first";
  parsed._continuityScope = scope;
  const binding = bindings.create(continuityDigest(identity.threadId), scope, "source-execution", continuityDigest(null));
  bindings.acceptLease(binding, { owner: bindings.owner, leaseId: "1".repeat(32), traceId: "2".repeat(12) });
  bindings.responseReady(binding, "source-execution");
  bindings.beginCompaction(binding, "compact-execution", "source-execution", Buffer.byteLength(JSON.stringify(source)) + 512);
  bindings.commitCompaction(binding, "compact-execution", "source-execution", summary, false, undefined, undefined,
    source, [continuitySourceRepresentationDigest(parsed, source)], identity.turnId);
  const selected = selectContinuityCheckpoint(parsed, identity)!;
  expect(selected.checkpoint.sourceInstruction).toEqual(source);
  expect(selected.checkpoint).toBe(binding.checkpoints.get("compact-execution")!);
  binding.checkpoints.delete("compact-execution");
  expect(() => selectContinuityCheckpoint(parsed, identity)).toThrow("no longer retained");
  expect(selectContinuityCheckpoint(structuredClone(parsed), identity)).toBeUndefined();
});

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

test("restart and expired idle bindings require durable recovery admission before replacement", () => {
  const { store } = fixture();
  store.initialize();
  let now = 1_000;
  const bindings = new ContinuityBindings(store, owner, () => now);
  const binding = bindings.create(thread, scope, "exec-0", continuityDigest(null));
  bindings.acceptLease(binding, { owner, leaseId: "6".repeat(32), traceId: "trace-first" });
  bindings.responseReady(binding, "exec-0");
  expect(new ContinuityBindings(store, "7".repeat(64)).lookup(thread, scope)).toBeUndefined();
  expect(new ContinuityBindings(store, owner).lookup(thread, scope)).toBeUndefined();
  expect(() => bindings.lookup(thread, "8".repeat(64))).toThrow();
  now += CONTINUITY_IDLE_TTL_MS - 1;
  expect(bindings.lookup(thread, scope)).toBe(binding);
  expect(binding.lastUsedAt).toBe(1_000);
  now += 1;
  expect(bindings.lookup(thread, scope)?.state).toBe("lost");
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
  expect(() => bindings.assertCompactionReplay(binding, "compact", 0)).not.toThrow();
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

test("recovery result bodies and checkpoint reservations use one capacity account", () => {
  const { path, store: registrations } = fixture();
  registrations.initialize();
  const store = new ContinuityRecoveryStore(path);
  const refs: RuntimeRecoveryReference[] = [];
  for (let index = 0; index < 12; index++) {
    const key = recoveryDigest(["capacity-thread", index]);
    const work = `work-${index}`;
    store.admitWork({ thread: key, scope, owner: continuityProcessInstance(), logicalWorkId: work,
      instructionIdentity: work, workPayloadDigest: recoveryDigest(work), snapshotDigest: recoveryDigest(index),
      createPage: true, dispatchProtocolComplete: true });
    store.issueBatch(key, { scope }, { logicalWorkId: work, attempt: 0,
      calls: [{ callId: `call-${index}`, operationId: `operation-${index}`, expectedResultType: "function_call_output" }] });
    store.markDeliveryPossible(key, { scope }, [`call-${index}`]);
    const ref = { directory: path, thread: key, logicalWorkId: work, attempt: 0 };
    acceptRecoveryResults(ref, [{ type: "function_call_output", call_id: `call-${index}`, output: "x".repeat(1024 * 1024) }]);
    refs.push(ref);
  }
  const bodyBytes = () => refs.reduce((sum, ref) => sum + Object.values(store.get(ref.thread)!.calls)
    .reduce((subtotal, call) => subtotal + (call.resultBodyBytes ?? 0), 0), 0);
  expect(bodyBytes()).toBeGreaterThan(12 * 1024 * 1024);
  let reservations = 0;
  for (const ref of refs.slice(0, 8)) {
    try {
      store.registerCompactionTarget(ref.thread, { scope }, { sourceLogicalWorkId: ref.logicalWorkId, sourceIdentity: ref.logicalWorkId });
      reservations++;
    } catch (error) {
      expect(error).toMatchObject({ code: "continuity_resource_capacity" });
      break;
    }
  }
  expect(reservations).toBeLessThan(8);
  expect(bodyBytes() + reservations * 2 * 1024 * 1024).toBeLessThan(24 * 1024 * 1024);
  evictOptionalRecoveryResults(path);
  expect(bodyBytes()).toBe(0);
  for (const ref of refs.slice(0, 8)) {
    store.registerCompactionTarget(ref.thread, { scope }, { sourceLogicalWorkId: ref.logicalWorkId, sourceIdentity: ref.logicalWorkId });
    expect(Object.values(store.get(ref.thread)!.calls)[0]!.firstResultDigest).toBeDefined();
  }
  expect(() => recoveryContext(parseRequest({ model: "model", input: "Current work" }), refs[0]!))
    .toThrow("real result body");
});

for (const shadow of [false, true]) for (const independentTurn of [false, true]) {
  test(`durable stop includes unfinished compaction of a completed source shadow=${shadow} independentTurn=${independentTurn}`, () => {
    const { path, store: registrations } = fixture();
    registrations.initialize();
    const store = new ContinuityRecoveryStore(path);
    const nativeThread = `stop-compact-${shadow}-${independentTurn}`;
    const key = continuityDigest(nativeThread);
    const processOwner = continuityProcessInstance();
    store.admitWork({ thread: key, scope, owner: processOwner, logicalWorkId: "source", instructionIdentity: "source-item",
      nativeTurnId: "source-turn", workPayloadDigest: continuityDigest("source"), snapshotDigest: continuityDigest("snapshot"),
      createPage: true, dispatchProtocolComplete: true });
    store.completeWork(key, { scope }, "source", { receiptId: "answer", digest: continuityDigest("accepted answer") });
    const source = store.get(key)!.works.source!;
    const registered = store.registerCompactionTarget(key, { scope }, { sourceLogicalWorkId: "source", sourceIdentity: "source-item" });
    store.admitWork({ thread: key, scope, owner: processOwner, logicalWorkId: "compact", instructionIdentity: "control",
      nativeTurnId: independentTurn ? "compact-turn" : "source-turn", purpose: "compaction",
      compactionTargetId: Object.keys(registered.compactionTargets)[0], activate: !shadow, createPage: false,
      workPayloadDigest: continuityDigest("compact"), snapshotDigest: continuityDigest("control"), dispatchProtocolComplete: true });
    expect(stopDurableContinuity(path, nativeThread, independentTurn ? "compact-turn" : undefined,
      independentTurn ? "native-interrupt" : "mode-exit")).toBe(true);
    const reloaded = new ContinuityRecoveryStore(path).get(key)!;
    expect(reloaded.works.source).toEqual(source);
    expect(reloaded.works.compact).toMatchObject({ state: "stopped", stopReason: independentTurn ? "native-interrupt" : "mode-exit" });
    expect(reloaded.checkpoints).toEqual({});
    expect(stopDurableContinuity(path, nativeThread, independentTurn ? "compact-turn" : undefined)).toBe(false);
  });
}
