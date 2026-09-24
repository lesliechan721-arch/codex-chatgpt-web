import { describe, expect, test } from "bun:test";
import {
  NativeToolOperations, NATIVE_OPERATION_LIMIT, NATIVE_WAITER_LIMIT, NATIVE_RESULT_LIMIT_BYTES,
  NATIVE_CONTEXT_LIMIT_BYTES, NATIVE_CONTEXT_TOTAL_BYTES, NATIVE_RESULT_TOTAL_BYTES,
  type NativeOperationAdmission,
} from "../src/adapters/chatgpt-web/native-tool-operations";
import { NativeToolAdmissionError, nativePublicResult } from "../src/adapters/chatgpt-web/native-tool-contract";

function fixture() {
  let clock = 0;
  let calls = 0;
  let retired: Error | undefined;
  const store = new NativeToolOperations(() => {}, error => { retired = error; store.retire(error); }, () => clock);
  const admit = (): NativeOperationAdmission => ({
    request: { callId: `call-${++calls}`, wireName: "request_user_input", freeform: false, arguments: {} },
    resultContract: { kind: "pass-through" },
  });
  return {
    store, admit, calls: () => calls, retired: () => retired,
    advance: (ms: number) => { for (let elapsed = 0; elapsed < ms; elapsed += 1_000) { clock += Math.min(1_000, ms - elapsed); store.tick(); } },
    suspend: (ms: number) => { clock += ms; store.tick(); },
  };
}

describe("Native operation identity and independent result queries", () => {
  test("equivalent Unicode-key ordering has the same immutable request identity", () => {
    const f = fixture();
    try {
      f.store.start(1, "codex_tool_call", { wire_name: "test", arguments: { "é": 1, "é": 2 } }, f.admit);
      expect(f.store.start(1, "codex_tool_call", { arguments: { "é": 2, "é": 1 }, wire_name: "test" }, f.admit).created).toBe(false);
      expect(f.calls()).toBe(1);
    } finally { f.store.retire(new Error("test cleanup")); }
  });

  test("large and cumulative finalizer contexts become stable rejections without losing admitted calls", async () => {
    const f = fixture();
    try {
      const padded = (size: number): NativeOperationAdmission => ({
        request: { callId: "fixed-context", wireName: "exec", freeform: true, input: "x".repeat(size) },
        resultContract: { kind: "pass-through" },
      });
      f.store.start(1, "codex_exec", { cmd: "large" }, () => padded(NATIVE_CONTEXT_LIMIT_BYTES));
      const rejected = await f.store.wait(1);
      expect(rejected).toMatchObject({ kind: "result", result: { structuredContent: { code: "codex_tool_resource_limit" } } });
      expect(f.store.start(1, "codex_exec", { cmd: "large" }, f.admit).created).toBe(false);
      expect(await f.store.wait(1)).toEqual(rejected);
      let filled = 0;
      const chunk = NATIVE_CONTEXT_LIMIT_BYTES - 1_024;
      for (let id = 2; id < 20; id += 1) {
        const started = f.store.start(id, "codex_exec", { cmd: `context-${id}` }, () => padded(chunk));
        if (!started.request) {
          expect(await f.store.wait(id)).toMatchObject({ kind: "result", result: { structuredContent: { code: "codex_tool_resource_limit" } } });
          break;
        }
        filled += chunk;
      }
      expect(filled).toBeGreaterThan(NATIVE_CONTEXT_TOTAL_BYTES - NATIVE_CONTEXT_LIMIT_BYTES);
      f.store.complete(2, nativePublicResult({ retained: true }));
      expect(await f.store.wait(2)).toMatchObject({ kind: "result", result: { structuredContent: { retained: true } } });
    } finally { f.store.retire(new Error("test cleanup")); }
  });

  test("a full result cache keeps original results and reserves space for unavailable terminals", async () => {
    const f = fixture();
    try {
      const chunk = NATIVE_RESULT_LIMIT_BYTES - 1_024;
      const result = { content: [{ type: "text", text: "x".repeat(chunk) }] };
      for (let id = 1; id <= 5; id += 1) {
        f.store.start(id, "codex_exec", { cmd: `result-${id}` }, f.admit);
        f.store.complete(id, result);
        const reply = await f.store.wait(id);
        if (id <= Math.floor((NATIVE_RESULT_TOTAL_BYTES - NATIVE_OPERATION_LIMIT * 1_024) / chunk)) expect(reply).toEqual({ kind: "result", result });
        else expect(reply).toMatchObject({ kind: "result", result: { structuredContent: { code: "codex_tool_result_unavailable" } } });
      }
      expect(await f.store.wait(1)).toEqual({ kind: "result", result });
    } finally { f.store.retire(new Error("test cleanup")); }
  });
  test("pending, same-ID retry and result replay never repeat admission or execution", async () => {
    const { store, admit, calls } = fixture();
    try {
      expect(store.start(1, "codex_tool_call", { wire_name: "request_user_input", arguments: {} }, admit).request?.callId).toBe("call-1");
      expect(await store.wait(1, undefined, 1)).toEqual({ kind: "pending", operation_id: 1 });
      expect(store.start(1, "codex_tool_call", { arguments: {}, wire_name: "request_user_input" }, admit).created).toBe(false);
      const result = {
        content: [{ type: "text", text: "" }, { type: "image", data: "AA==", mimeType: "image/png" }],
        structuredContent: { kind: "codex_native_pending", operation_id: 99 },
        isError: false, _meta: { original: true },
      };
      store.handoff(1);
      store.complete(1, result);
      expect(store.hasOutstanding()).toBe(true);
      expect(await store.wait(1)).toEqual({ kind: "result", result });
      expect(await store.wait(1)).toEqual({ kind: "result", result });
      expect(store.hasOutstanding()).toBe(false);
      expect(calls()).toBe(1);
      expect(() => store.start(1, "codex_tool_call", { wire_name: "another_tool" }, admit)).toThrow("different start request");
      expect(store.start(2, "codex_tool_call", { wire_name: "request_user_input", arguments: {} }, admit).request?.callId).toBe("call-2");
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("deterministic rejection occupies the ID; changed requests conflict and unchanged retries do not re-admit", async () => {
    const { store, admit, calls } = fixture();
    try {
      store.start(1, "codex_exec", { cmd: "label" }, () => { throw new NativeToolAdmissionError("tool unavailable"); });
      const rejection = await store.wait(1);
      expect(rejection).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
      store.start(1, "codex_exec", { cmd: "label" }, admit);
      expect(await store.wait(1)).toEqual(rejection);
      expect(() => store.start(1, "codex_exec", { cmd: "changed" }, admit)).toThrow("different start request");
      expect(calls()).toBe(0);
      store.start(2, "codex_exec", { cmd: "label" }, admit);
      expect(calls()).toBe(1);
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("nesting-limit rejection occupies the ID and replays without admission", async () => {
    const { store, admit, calls } = fixture();
    const deep = (reverseLeaf: boolean): Record<string, unknown> => {
      let nested: Record<string, unknown> = reverseLeaf ? { "é": 2, "é": 1 } : { "é": 1, "é": 2 };
      for (let depth = 0; depth < 70; depth += 1) nested = { nested };
      return nested;
    };
    try {
      expect(store.start(1, "codex_tool_call", { wire_name: "deep", arguments: deep(false) }, admit).created).toBe(true);
      const rejection = await store.wait(1);
      expect(rejection).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_resource_limit" } } });
      expect(store.start(1, "codex_tool_call", { arguments: deep(true), wire_name: "deep" }, admit).created).toBe(false);
      expect(await store.wait(1)).toEqual(rejection);
      expect(() => store.start(1, "codex_exec", { cmd: "changed" }, admit)).toThrow("different start request");
      expect(calls()).toBe(0);
      expect(store.start(2, "codex_exec", { cmd: "changed" }, admit).created).toBe(true);
      expect(calls()).toBe(1);
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("infrastructure failure before admission publishes no half-bound identity", () => {
    const { store, admit } = fixture();
    try {
      expect(() => store.start(1, "codex_exec", { cmd: "label" }, () => { throw new TypeError("infrastructure"); })).toThrow("infrastructure");
      expect(() => store.wait(1)).toThrow("unknown or expired");
      expect(store.start(1, "codex_exec", { cmd: "label" }, admit).created).toBe(true);
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("a cancelled query releases only its waiter and a later query receives the original result", async () => {
    const { store, admit, calls } = fixture();
    try {
      store.start(1, "codex_exec", { cmd: "label" }, admit);
      const abort = new AbortController();
      const cancelled = store.wait(1, abort.signal).catch(error => error);
      abort.abort();
      expect((await cancelled).name).toBe("AbortError");
      expect(store.hasOutstanding()).toBe(true);
      store.complete(1, nativePublicResult({ answer: null }, true));
      expect(await store.wait(1)).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { answer: null } } });
      expect(calls()).toBe(1);
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("queued compaction bypasses the inventory finalizer and caches one control terminal", async () => {
    const { store } = fixture();
    try {
      store.start(1, "codex_tool_inventory", {}, () => ({
        request: { callId: "inventory", wireName: "exec", freeform: true, input: "inert catalog" },
        resultContract: { kind: "inventory", offset: 0, includeSchema: true, directPage: [], directTotal: 0, excludedNames: [], nestedLimit: 20, discoveryTools: [] },
      }));
      expect(await store.wait(1, undefined, 1)).toMatchObject({ kind: "pending" });
      store.complete(1, nativePublicResult({ checkpoint: "control-not-catalog" }), true);
      const result = await store.wait(1);
      expect(result).toMatchObject({ kind: "result", result: { structuredContent: { checkpoint: "control-not-catalog" }, _meta: { "codex/native-control": { kind: "compaction" } } } });
      expect(await store.wait(1)).toEqual(result);
      expect(store.hasOutstanding()).toBe(false);
    } finally { store.retire(new Error("test cleanup")); }
  });

  test("queries sustain an eleven-minute wait without a new call; observation alone never renews the lease", async () => {
    const f = fixture();
    try {
      f.store.start(1, "codex_exec", { cmd: "label" }, f.admit);
      for (let minute = 0; minute < 11; minute += 1) {
        f.advance(60_000);
        expect(await f.store.wait(1, undefined, 1)).toMatchObject({ kind: "pending" });
      }
      expect(f.retired()).toBeUndefined();
      expect(f.calls()).toBe(1);
      for (let second = 0; second < 120; second += 1) { f.store.snapshot(); f.advance(1_000); }
      expect(f.retired()).toMatchObject({ code: "codex_tool_wait_lease_expired" });
    } finally { f.store.retire(new Error("test cleanup")); }
  });

  test("system suspension refunds asleep time instead of immediately cancelling a healthy consumer", async () => {
    const f = fixture();
    try {
      f.store.start(1, "codex_exec", { cmd: "label" }, f.admit);
      await f.store.wait(1, undefined, 1);
      f.suspend(20 * 60_000);
      expect(f.retired()).toBeUndefined();
      expect(f.store.snapshot().remainingMs).toBeGreaterThan(118_000);
      f.advance(120_000);
      expect(f.retired()).toMatchObject({ code: "codex_tool_wait_lease_expired" });
    } finally { f.store.retire(new Error("test cleanup")); }
  });

  test("safe integer IDs are capability-local, may arrive out of order, and never create work through wait", () => {
    const a = fixture();
    const b = fixture();
    try {
      for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => a.store.start(invalid, "codex_exec", {}, a.admit)).toThrow("positive safe integer");
      expect(() => a.store.wait(1)).toThrow("unknown or expired");
      a.store.start(10, "codex_exec", {}, a.admit);
      a.store.start(1, "codex_exec", {}, a.admit);
      b.store.start(1, "codex_exec", {}, b.admit);
      expect(a.calls()).toBe(2);
      expect(b.calls()).toBe(1);
    } finally { a.store.retire(new Error("test cleanup")); b.store.retire(new Error("test cleanup")); }
  });

  test("operation and waiter limits reject additional work without evicting existing results", async () => {
    const f = fixture();
    const pending: Array<Promise<unknown>> = [];
    try {
      f.store.start(1, "codex_exec", {}, f.admit);
      for (let index = 0; index < NATIVE_WAITER_LIMIT; index += 1) pending.push(f.store.wait(1).catch(error => error));
      expect(() => f.store.wait(1)).toThrow("resource limit");
      f.store.complete(1, nativePublicResult({ original: true }));
      await Promise.all(pending);
      for (let id = 2; id <= NATIVE_OPERATION_LIMIT; id += 1) f.store.start(id, "codex_tool_inventory", {}, () => ({ result: nativePublicResult({ tools: [] }) }));
      expect(() => f.store.start(NATIVE_OPERATION_LIMIT + 1, "codex_exec", {}, f.admit)).toThrow("resource limit");
      expect(await f.store.wait(1)).toMatchObject({ kind: "result", result: { structuredContent: { original: true } } });
    } finally { f.store.retire(new Error("test cleanup")); await Promise.all(pending); }
  });

  test("oversized results are explicitly unavailable and are never recreated by retry", async () => {
    const f = fixture();
    try {
      f.store.start(1, "codex_exec", {}, f.admit);
      f.store.complete(1, { content: [{ type: "text", text: "x".repeat(NATIVE_RESULT_LIMIT_BYTES) }] });
      expect(await f.store.wait(1)).toMatchObject({ kind: "result", result: { structuredContent: { code: "codex_tool_result_unavailable" } } });
      f.store.start(1, "codex_exec", {}, f.admit);
      expect(f.calls()).toBe(1);
    } finally { f.store.retire(new Error("test cleanup")); }
  });
});
