import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRecoveryStore, continuityProcessInstance, type AdmitRecoveryWorkInput } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { acceptRecoveryResults, evictOptionalRecoveryResults, recoveryContext, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { parseRequest } from "../src/responses/parser";

const roots: string[] = [];
const runtimeRoots: string[] = [];
const thread = "1".repeat(64), scope = "2".repeat(64), owner = continuityProcessInstance("3".repeat(64));
const guard = { scope }, result = "6".repeat(64);
const storeModule = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-recovery-store.ts");
function input(): AdmitRecoveryWorkInput {
  return { thread, scope, owner, logicalWorkId: "work-A", instructionIdentity: "instruction-A", nativeTurnId: "turn-A",
    workPayloadDigest: "4".repeat(64), snapshotDigest: "5".repeat(64), dispatchProtocolComplete: true, createPage: true };
}
function fixture(options: ConstructorParameters<typeof ContinuityRecoveryStore>[1] = {}) {
  const path = fs.mkdtempSync(join(tmpdir(), "cgw-recovery-performance-")); roots.push(path);
  new ContinuityRegistrationStore(path).initialize();
  const store = new ContinuityRecoveryStore(path, options);
  const record = store.admitWork(input());
  return { path, file: join(path, "recovery.json"), store, record };
}
function replaceWithSameBytes(file: string): void {
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 });
  fs.renameSync(replacement, file);
}
function expectReuse(syncs: number, file: string): void {
  // Missing Windows identity must cause a safe synchronization fallback.
  if (process.platform === "win32" && (fs.lstatSync(file, { bigint: true }).ino === 0n
    || fs.lstatSync(join(file, ".."), { bigint: true }).ino === 0n)) return;
  expect(syncs).toBe(0);
}
function child(path: string, code: string): string {
  const script = `import {ContinuityRecoveryStore} from ${JSON.stringify(storeModule)};
    import {spyOn} from "bun:test"; import * as fs from "node:fs";
    const store=new ContinuityRecoveryStore(${JSON.stringify(path)});
    const thread=${JSON.stringify(thread)}, guard=${JSON.stringify(guard)};
    ${code}`;
  const completed = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15_000 });
  expect(completed.error).toBeUndefined(); expect(completed.status).toBe(0); expect(completed.stderr).toBe("");
  return completed.stdout;
}
afterEach(() => {
  for (const path of runtimeRoots.splice(0)) evictOptionalRecoveryResults(path);
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

test("empty transactions, repeated admission and confirmation reuse a completed commit across store instances", () => {
  let writes = 0;
  const { path, file, store, record } = fixture({ beforeWrite: () => { writes++; } });
  const original = fs.readFileSync(file, "utf8"); writes = 0;
  const sync = spyOn(fs, "fsyncSync");
  try {
    expect(store.transact(thread, guard, () => {})).toEqual(record);
    expect(store.admitWork(input())).toEqual(record);
    expect(store.confirmDurable(thread, guard)).toEqual(record);
    const reopened = new ContinuityRecoveryStore(path, { beforeWrite: () => { writes++; } });
    expect(reopened.transact(thread, guard, () => {})).toEqual(record);
    expect(reopened.admitWork(input())).toEqual(record);
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expect(writes).toBe(0); expect(fs.readFileSync(file, "utf8")).toBe(original);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("same-byte file replacement requires synchronization; get cannot establish the proof", () => {
  let writes = 0;
  const { path, file, record } = fixture({ beforeWrite: () => { writes++; } });
  const original = fs.readFileSync(file, "utf8"); replaceWithSameBytes(file); writes = 0;
  const reopened = new ContinuityRecoveryStore(path, { beforeWrite: () => { writes++; } });
  const sync = spyOn(fs, "fsyncSync");
  try {
    expect(reopened.get(thread)).toEqual(record); expect(sync.mock.calls.length).toBe(0);
    expect(reopened.transact(thread, guard, () => {})).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(reopened.transact(thread, guard, () => {})).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
    expect(writes).toBe(0); expect(fs.readFileSync(file, "utf8")).toBe(original);
  } finally { sync.mockRestore(); }
});

test("changed raw bytes require synchronization even when the parsed state is identical", () => {
  const { file, store, record } = fixture();
  fs.appendFileSync(file, "\n");
  const sync = spyOn(fs, "fsyncSync");
  try {
    expect(store.transact(thread, guard, () => {})).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(store.confirmDurable(thread, guard)).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  } finally { sync.mockRestore(); }
});

test("failed read-back synchronization cannot create a reusable proof", () => {
  const { path, file, store, record } = fixture(); replaceWithSameBytes(file);
  const sync = spyOn(fs, "fsyncSync");
  try {
    sync.mockImplementationOnce(() => { throw new Error("sync failed"); });
    expect(() => store.transact(thread, guard, () => {})).toThrow("durability"); sync.mockClear();
    const reopened = new ContinuityRecoveryStore(path);
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("moving the same recovery inode into a replaced parent directory invalidates the proof", () => {
  const { path, file, record } = fixture();
  const old = `${path}.old`; roots.push(old); fs.renameSync(path, old); fs.mkdirSync(path, { mode: 0o700 });
  for (const name of fs.readdirSync(old)) fs.renameSync(join(old, name), join(path, name));
  const reopened = new ContinuityRecoveryStore(path), sync = spyOn(fs, "fsyncSync");
  try {
    expect(reopened.transact(thread, guard, () => {})).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("a lost post-rename receipt cannot establish a proof for a new store", () => {
  let fail = false;
  const { path, file, store, record } = fixture({ afterAtomicReplace: () => { if (fail) throw new Error("receipt lost"); } });
  fail = true;
  expect(() => store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0,
    calls: [{ callId: "call-A", operationId: "operation-A", expectedResultType: "function_call_output" }] })).toThrow("saved");
  const reopened = new ContinuityRecoveryStore(path), saved = reopened.get(thread)!;
  expect(saved.version).toBe(record.version + 1); expect(saved.calls["call-A"]!.state).toBe("queued");
  const sync = spyOn(fs, "fsyncSync");
  try {
    expect(reopened.confirmDurable(thread, { ...guard, expectedVersion: saved.version })).toEqual(saved);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(reopened.transact(thread, guard, () => {})).toEqual(saved);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("a rejected write attempt invalidates the previous proof before a new store confirms unchanged bytes", () => {
  let fail = false;
  const { path, file, store, record } = fixture({ beforeWrite: () => { if (fail) throw new Error("write rejected"); } });
  const original = fs.readFileSync(file, "utf8"); fail = true;
  expect(() => store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0,
    calls: [{ callId: "call-A", operationId: "operation-A", expectedResultType: "function_call_output" }] })).toThrow("saved");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  const reopened = new ContinuityRecoveryStore(path), sync = spyOn(fs, "fsyncSync");
  try {
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(reopened.confirmDurable(thread, guard)).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("fresh processes synchronize their first read-back and cross-process replacement invalidates local proof", () => {
  const { path, file, store, record } = fixture();
  const counts = JSON.parse(child(path, `store.get(thread);
    const sync=spyOn(fs,"fsyncSync");
    const first=store.transact(thread,guard,()=>{}); const firstSyncs=sync.mock.calls.length; sync.mockClear();
    const second=store.confirmDurable(thread,guard);
    process.stdout.write(JSON.stringify({firstSyncs,secondSyncs:sync.mock.calls.length,firstVersion:first.version,secondVersion:second.version}));`));
  expect(counts.firstSyncs).toBeGreaterThan(0); expectReuse(counts.secondSyncs, file);
  expect(counts.firstVersion).toBe(record.version); expect(counts.secondVersion).toBe(record.version);
  child(path, `const file=${JSON.stringify(file)}; fs.writeFileSync(file+".replacement",fs.readFileSync(file),{mode:0o600}); fs.renameSync(file+".replacement",file);`);
  const sync = spyOn(fs, "fsyncSync");
  try {
    expect(store.transact(thread, guard, () => {})).toEqual(record);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(store.confirmDurable(thread, guard)).toEqual(record);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("proof reuse still validates current guards, schema and protected transitions", () => {
  const { file, store, record } = fixture(); const original = fs.readFileSync(file, "utf8");
  expect(() => store.transact(thread, { ...guard, expectedVersion: record.version + 1 }, () => {})).toThrow("stale");
  expect(() => store.confirmDurable(thread, { ...guard, expectedOwner: "7".repeat(64) })).toThrow("stale");
  expect(() => store.transact(thread, guard, current => { current.historyRevision++; })).toThrow("checkpoint");
  expect(() => store.transact(thread, guard, current => { (current as unknown as Record<string, unknown>).prompt = "secret"; })).toThrow("schema");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o644);
    try {
      expect(() => store.transact(thread, guard, () => {})).toThrow("invalid");
      expect(() => store.confirmDurable(thread, guard)).toThrow("invalid");
    } finally { fs.chmodSync(file, 0o600); }
  }
});

test("a v2 empty transaction retains the upgrade write and promotes the document to v4", () => {
  let writes = 0;
  const { file, store, record } = fixture({ beforeWrite: () => { writes++; } });
  const old = JSON.parse(fs.readFileSync(file, "utf8")); old.version = 2; fs.writeFileSync(file, JSON.stringify(old)); writes = 0;
  const sync = spyOn(fs, "fsyncSync");
  try {
    const upgraded = store.transact(thread, guard, () => {});
    expect(upgraded).toEqual({ ...record, version: record.version + 1 });
    expect(writes).toBe(1); expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(4);
    expect(sync.mock.calls.length).toBeGreaterThan(0); sync.mockClear();
    expect(store.transact(thread, guard, () => {})).toEqual(upgraded); expect(writes).toBe(1);
    expectReuse(sync.mock.calls.length, file);
  } finally { sync.mockRestore(); }
});

test("batch result byte accounting commits once and capacity rejection retains all terminal facts", () => {
  let writes = 0;
  const { path, file, store } = fixture({ beforeWrite: () => { writes++; } });
  const calls = ["call-A", "call-B"];
  store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0,
    calls: calls.map(callId => ({ callId, operationId: `operation-${callId}`, expectedResultType: "function_call_output" })) });
  store.markDeliveryPossible(thread, guard, calls);
  for (const callId of calls) store.acceptResult(thread, guard, { callId, resultType: "function_call_output", resultDigest: result });
  const before = store.get(thread)!; writes = 0;
  expect(store.setResultBodiesBytes(thread, guard, calls.map(callId => ({ callId, bytes: 1024 })), owner)).toBe(true);
  expect(writes).toBe(1);
  const accounted = store.get(thread)!; expect(accounted.version).toBe(before.version + 1);
  for (const callId of calls) expect(accounted.calls[callId]).toMatchObject({ state: "settled", firstResultDigest: result, resultBodyBytes: 1024, resultBodyOwner: owner });
  const saved = fs.readFileSync(file, "utf8");
  const bounded = new ContinuityRecoveryStore(path, { limits: { totalBytes: Buffer.byteLength(saved) + 2048 + 2048 + 512 },
    beforeWrite: () => { writes++; } });
  writes = 0;
  expect(bounded.setResultBodiesBytes(thread, guard, [{ callId: "call-A", bytes: 2048 }, { callId: "call-B", bytes: 4096 }], owner)).toBe(false);
  expect(writes).toBe(0); expect(fs.readFileSync(file, "utf8")).toBe(saved); expect(store.get(thread)).toEqual(accounted);
  expect(() => store.setResultBodiesBytes(thread, guard, [{ callId: "call-A", bytes: 2048 }, { callId: "missing", bytes: 1024 }], owner)).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(saved);
  expect(store.setResultBodyBytes(thread, guard, "call-A", 1536, owner)).toBe(true);
  expect(store.get(thread)!.calls["call-A"]!.resultBodyBytes).toBe(1536);
});

for (const capacityLimited of [false, true]) test(`runtime accepts all terminal results before optional body accounting (capacityLimited=${capacityLimited})`, () => {
  const { path, file, store } = fixture(); runtimeRoots.push(path);
  const ref = { directory: path, thread, logicalWorkId: "work-A", attempt: 0, ownerId: owner.id };
  const results = [
    { type: "function_call_output", call_id: "call-A", output: capacityLimited ? "x".repeat(2 * 1024 * 1024) : "First real result." },
    { type: "function_call_output", call_id: "call-B", output: "Second real result." },
  ];
  store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0, calls: results.map(item => ({
    callId: item.call_id, operationId: `operation-${item.call_id}`, expectedResultType: item.type,
  })) });
  store.markDeliveryPossible(thread, guard, results.map(item => item.call_id));
  const before = store.get(thread)!;
  const snapshots: Array<ReturnType<typeof store.get>> = [];
  const io: string[] = [];
  const originalRename = fs.renameSync, originalSync = fs.fsyncSync;
  const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const directory = fs.fstatSync(fd).isDirectory(); originalSync(fd);
    io.push(directory ? "directory-sync" : "file-sync");
  });
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    originalRename(from, to);
    if (String(to) === file) { io.push("replace"); snapshots.push(store.get(thread)); }
  });
  try {
    acceptRecoveryResults(ref, results);
    // One replacement settles every result; one accounts the body batch or the
    // small body that still fits after the failed batch and large-body fallback.
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.version).toBe(before.version + 1);
    for (const item of results) expect(snapshots[0]!.calls[item.call_id]).toMatchObject({
      state: "settled", firstResultDigest: recoveryResultDigest(item),
    });
    for (const item of results) expect(snapshots[0]!.calls[item.call_id]!.resultBodyBytes).toBeUndefined();
    const firstReplace = io.indexOf("replace"), secondReplace = io.lastIndexOf("replace");
    expect(io.slice(0, firstReplace)).toContain("file-sync");
    if (process.platform !== "win32") expect(io.slice(firstReplace + 1, secondReplace)).toContain("directory-sync");
    const retained = store.get(thread)!; expect(retained.version).toBe(before.version + 2);
    expect(retained.calls["call-B"]!.resultBodyBytes).toBe(Buffer.byteLength(JSON.stringify(results[1])));
    if (capacityLimited) {
      expect(retained.calls["call-A"]!.resultBodyBytes).toBeUndefined();
      expect(() => recoveryContext(parseRequest({ model: "gpt-5.6-sol", input: "Continue." }), ref)).toThrow("real result body");
    } else expect(retained.calls["call-A"]!.resultBodyBytes).toBe(Buffer.byteLength(JSON.stringify(results[0])));
    // The recovery consumer can replay the retained body. Under capacity pressure
    // the caller supplies only the large body; the smaller body comes from cache.
    const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
      { type: "message", role: "user", content: "Continue." }, ...(capacityLimited ? [results[0]] : []),
    ] });
    const recovered = recoveryContext(parsed, ref);
    const recoveredResults = (recovered._rawBody as { input: unknown[] }).input.filter(item =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "function_call_output"));
    expect(recoveredResults).toEqual(results);
    expect(store.get(thread)).toEqual(retained); expect(snapshots).toHaveLength(2);
  } finally { rename.mockRestore(); sync.mockRestore(); }
});
