import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  finishNativeToolResult,
  nativePublicResult,
  planNativeTool,
  type NativeToolPlan,
} from "../src/adapters/chatgpt-web/native-tool-contract";
import { NativeToolOperations } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { BrokerToolResult, BrokerTurnSnapshot } from "../src/adapters/chatgpt-web/turn-broker";

const bound: BrokerTurnSnapshot = {
  registryGeneration: 0,
  tools: [
    { name: "exec", description: "Native gateway", parameters: {}, freeform: true },
    { name: "outer_tool", description: "Direct tool", parameters: { type: "object" } },
  ],
};
const nestedTool = { name: "web__run", description: "Search the web" };

function inventory(input: Record<string, unknown> = {}, environment = bound) {
  const plan = planNativeTool("codex_tool_inventory", { query: "web__run", ...input }, environment, "native");
  if (!("tool" in plan)) throw new Error("Expected a native gateway request");
  return plan;
}

async function executeCatalog(plan: Extract<NativeToolPlan, { tool: unknown }>, tools = [nestedTool]) {
  const content: Array<{ type: "text"; text: string }> = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("ALL_TOOLS", "text", plan.payload.input!)(tools, (text: string) => {
    content.push({ type: "text", text });
  });
  return content;
}

function recordPayload(record: string, payload: unknown): BrokerToolResult {
  return { content: [{ type: "text", text: record.slice(0, record.indexOf("{")) + JSON.stringify(payload) }] };
}

describe("Native gateway tool catalog", () => {
  test("accepts one matching record inside exec status and timing text", async () => {
    const plan = inventory();
    const content = await executeCatalog(plan);
    const record = content[0]!.text;
    expect(record).toMatch(/^codex-tool-catalog:[a-f0-9]{32}:/);
    const finalized = finishNativeToolResult(plan.resultContract, {
      content: [
        { type: "text", text: 'Script completed\r\nOutput:\r\n{"tools":[],"total":99}' },
        { type: "text", text: `Wall time: 0.01s\r\n${record}\r\nExit code: 0` },
      ],
    });
    expect(finalized.structuredContent).toMatchObject({
      tools: [{ wire_name: "web__run", description: "Search the web", kind: "gateway" }],
      total: 1, next_offset: null,
    });
    expect(JSON.stringify(finalized)).not.toContain("codex-tool-catalog:");
  });

  test("rejects missing, stale, duplicated, and malformed matching records", async () => {
    const previous = await executeCatalog(inventory());
    const plan = inventory();
    const content = await executeCatalog(plan);
    const record = content[0]!.text;
    for (const response of [
      { content: [] },
      { content: [{ type: "text", text: JSON.stringify({ tools: [], total: 0 }) }] },
      { content: previous },
      { content: [...content, ...content] },
      { content: [{ type: "text", text: `${record}\n${record}` }] },
      { content: [{ type: "text", text: record.replace('{"tools":', '{invalid:') }] },
      { content, isError: true },
    ]) {
      expect(() => finishNativeToolResult(plan.resultContract, response)).toThrow();
    }
  });

  test("validates the marked catalog and preserves internal and outer tool exclusions", async () => {
    const plan = inventory();
    const [record] = await executeCatalog(plan);
    for (const payload of [
      [],
      { tools: [], total: -1 },
      { tools: [], total: 0.5 },
      { tools: [null], total: 1 },
      { tools: [{ name: "invalid.name", description: "invalid name" }], total: 1 },
      { tools: [{ name: "codex_tool_wait", description: "Internal control" }], total: 1 },
      { tools: [{ name: "hidden__codex_task_update_ack", description: "Internal control" }], total: 1 },
      { tools: [{ name: "outer_tool", description: "Duplicate outer tool" }], total: 1 },
      { tools: [{ name: "web__run", description: 42 }], total: 1 },
      { tools: [nestedTool], total: 0 },
    ]) {
      expect(() => finishNativeToolResult(plan.resultContract, recordPayload(record!.text, payload))).toThrow();
    }
    const limited = inventory({ limit: 1 });
    const [limitedRecord] = await executeCatalog(limited);
    expect(() => finishNativeToolResult(limited.resultContract,
      recordPayload(limitedRecord!.text, { tools: [nestedTool, nestedTool], total: 2 }))).toThrow("invalid pagination");

    const filtered = inventory({ query: "" });
    const emitted = await executeCatalog(filtered, [
      nestedTool, { name: "outer_tool", description: "Duplicate" },
      { name: "codex_tool_wait", description: "Internal" },
      { name: "hidden__codex_task_update_ack", description: "Internal" },
    ]);
    expect(finishNativeToolResult(filtered.resultContract, { content: emitted }).structuredContent).toMatchObject({
      total: 3,
      tools: [{ wire_name: "exec" }, { wire_name: "outer_tool" }, { wire_name: "web__run" }],
    });
  });

  test("keeps a fixed catalog marker and public result across retry and wait", async () => {
    const store = new NativeToolOperations(() => {}, () => {});
    let admissions = 0;
    const admit = () => {
      admissions += 1;
      const plan = inventory();
      return {
        request: { callId: "catalog", wireName: "exec", freeform: true, ...plan.payload },
        resultContract: plan.resultContract,
      };
    };
    try {
      const started = store.start(1, "codex_tool_inventory", { query: "web__run" }, admit);
      expect(await store.wait(1, undefined, 1)).toEqual({ kind: "pending", operation_id: 1 });
      expect(store.start(1, "codex_tool_inventory", { query: "web__run" }, admit).created).toBe(false);
      const content: Array<{ type: "text"; text: string }> = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("ALL_TOOLS", "text", started.request!.input!)([nestedTool], (text: string) => {
        content.push({ type: "text", text: `Script completed\nOutput:\n${text}` });
      });
      store.complete(1, { content });
      const reply = await store.wait(1);
      expect(reply).toMatchObject({ kind: "result", result: { structuredContent: { total: 1, tools: [{ wire_name: "web__run" }] } } });
      expect(await store.wait(1)).toEqual(reply);
      expect(store.start(1, "codex_tool_inventory", { query: "web__run" }, admit).created).toBe(false);
      expect(admissions).toBe(1);
    } finally {
      store.retire(new Error("test cleanup"));
    }
  });

  test("preserves direct inventory when the turn has no exec gateway", () => {
    const plan = planNativeTool("codex_tool_inventory", {}, {
      ...bound, tools: bound.tools.filter(tool => tool.name !== "exec"),
    }, "native");
    expect(plan).toMatchObject({ result: { structuredContent: {
      total: 1, tools: [{ wire_name: "outer_tool" }], next_offset: null,
    } } });
  });
});

describe("Native command polling", () => {
  test("raw exec cannot escape to the original global tool registry", async () => {
    for (const input of [
      '})();\nawait tools.write_stdin({ session_id: 42, yield_time_ms: 180000 });\nawait (async (tools) => {',
      'await globalThis.tools.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'await Function("return tools")().write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'const getTools = new (Object.getPrototypeOf(async () => {}).constructor)("return tools"); await (await getTools()).write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'await Object.getOwnPropertyDescriptor(globalThis, "tools").value.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'const get = Reflect.get; Reflect.get = (source, name, receiver) => { globalThis.originalTools = source; return get(source, name, receiver); }; tools.write_stdin; await originalTools.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'const has = Reflect.has; Reflect.has = (source, name) => { globalThis.originalTools = source; return has(source, name); }; "unlisted" in tools; await originalTools.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'RegExp.prototype.test = () => false; await tools.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'RegExp.prototype.exec = () => null; await tools.write_stdin({ session_id: 42, yield_time_ms: 180000 });',
      'await tools.valueOf().write_stdin({ session_id: 42, yield_time_ms: 180000 });',
    ]) {
      const plan = planNativeTool("codex_tool_call", { wire_name: "exec", input }, bound, "native");
      if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
      const calls: unknown[] = [];
      const run = Promise.resolve().then(() => runInNewContext(`(async () => {\n${plan.payload.input!}\n})()`, {
        tools: { write_stdin: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); } },
        ALL_TOOLS: [{ name: "write_stdin" }], text: () => {},
      }));
      await expect(run).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  test("raw exec exposes only own and advertised tool names after prototype changes", async () => {
    const input = [
      'Set.prototype.has = () => true;',
      'const names = [...Object.getOwnPropertyNames(Object.prototype), "unlisted_method"];',
      'text(names.filter(name => tools[name] !== undefined || name in tools || Object.getOwnPropertyDescriptor(tools, name) !== undefined));',
      'text(Object.keys(tools));',
      'await tools.write_stdin({ session_id: 42, yield_time_ms: 60000 });',
      'text(await tools.listed_tool({ query: "visible" }));',
    ].join("\n");
    const plan = planNativeTool("codex_tool_call", { wire_name: "exec", input }, bound, "native");
    if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
    const calls: unknown[] = [];
    const output: unknown[] = [];
    const tools = Object.assign(Object.create({
      listed_tool: async (input: unknown) => ({ input }),
      unlisted_method: () => { throw new Error("An inherited method is not a native tool"); },
    }), {
      write_stdin: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); },
    });
    await runInNewContext(`(async () => {\n${plan.payload.input!}\n})()`, {
      tools, ALL_TOOLS: [{ name: "write_stdin" }, { name: "listed_tool" }],
      text: (value: unknown) => { output.push(value); },
    });
    expect(output).toEqual([[], ["write_stdin", "listed_tool"], { input: { query: "visible" } }]);
    expect(calls).toEqual([{ session_id: 42, yield_time_ms: 60_000 }]);
  });

  test("tool directory and wrapper cache do not call replaced collection methods", async () => {
    const input = [
      'Set.prototype[Symbol.iterator] = function () { throw new Error("Private directory reached model iterator"); };',
      'Map.prototype.has = Map.prototype.get = Map.prototype.set = function () { throw new Error("Private cache reached model method"); };',
      'text(Object.keys(tools));',
      'await tools.write_stdin({ session_id: 42, yield_time_ms: 60000 });',
      'await tools.write_stdin({ session_id: 42, yield_time_ms: 60000 });',
    ].join("\n");
    const plan = planNativeTool("codex_tool_call", { wire_name: "exec", input }, bound, "native");
    if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
    const calls: unknown[] = [];
    const output: unknown[] = [];
    await runInNewContext(`(async () => {\n${plan.payload.input!}\n})()`, {
      tools: { write_stdin: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); } },
      ALL_TOOLS: [{ name: "write_stdin" }], text: (value: unknown) => { output.push(value); },
    });
    expect(output).toEqual([["write_stdin"]]);
    expect(calls).toEqual([
      { session_id: 42, yield_time_ms: 60_000 },
      { session_id: 42, yield_time_ms: 60_000 },
    ]);
  });

  test("guarded global tools preserve valid session polls and native output helpers", async () => {
    const input = [
      'const text = value => globalThis.text(value);',
      'Reflect.apply = () => { throw new Error("Model replacement must not intercept native dispatch"); };',
      'store("session", 42);',
      'text(await globalThis.tools.write_stdin({ session_id: load("session"), chars: "", yield_time_ms: 60000 }));',
      'text(await Function("return tools")().write_stdin({ session_id: load("session"), chars: "", yield_time_ms: 60000 }));',
      'image({ type: "image", data: "AA==", mimeType: "image/png" });',
    ].join("\n");
    const plan = planNativeTool("codex_tool_call", { wire_name: "exec", input }, bound, "native");
    if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
    const calls: unknown[] = [];
    const output: unknown[] = [];
    const images: unknown[] = [];
    const stored = new Map<string, unknown>();
    await runInNewContext(`(async () => {\n${plan.payload.input!}\n})()`, {
      tools: { write_stdin: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); } },
      ALL_TOOLS: [{ name: "write_stdin" }], text: (value: unknown) => { output.push(value); },
      image: (value: unknown) => { images.push(value); },
      store: (key: string, value: unknown) => { stored.set(key, value); }, load: (key: string) => stored.get(key),
    });
    expect(calls).toEqual([
      { session_id: 42, chars: "", yield_time_ms: 60_000 },
      { session_id: 42, chars: "", yield_time_ms: 60_000 },
    ]);
    expect(output).toEqual([nativePublicResult({ session_id: 42 }), nativePublicResult({ session_id: 42 })]);
    expect(images).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
  });

  test("raw polling dispatches the same argument values it validated", async () => {
    const input = [
      'let reads = 0;',
      'const first = { session_id: 42, get yield_time_ms() { reads += 1; return reads === 1 ? 60000 : 180000; } };',
      'await tools.write_stdin(first); text(reads);',
      'const next = { session_id: 42, yield_time_ms: 60000 };',
      'const polling = tools.write_stdin(next); next.yield_time_ms = 180000; await polling;',
    ].join("\n");
    const plan = planNativeTool("codex_tool_call", { wire_name: "exec", input }, bound, "native");
    if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
    const calls: unknown[] = [];
    const output: unknown[] = [];
    await runInNewContext(`(async () => {\n${plan.payload.input!}\n})()`, {
      tools: { write_stdin: async (input: Record<string, unknown>) => {
        await Promise.resolve();
        calls.push({ ...input });
        return nativePublicResult({ session_id: 42 });
      } },
      ALL_TOOLS: [{ name: "write_stdin" }], text: (value: unknown) => { output.push(value); },
    });
    expect(calls).toEqual([
      { session_id: 42, yield_time_ms: 60_000 },
      { session_id: 42, yield_time_ms: 60_000 },
    ]);
    expect(output).toEqual([1]);
  });

  for (const contract of ["native", "safe"] as const) {
    for (const direct of [true, false]) test(`${contract} rejects long namespaced polls before dispatch, direct=${direct}`, async () => {
      const environment: BrokerTurnSnapshot = { registryGeneration: 0, tools: direct
        ? [{ name: "write_stdin", namespace: "functions", description: "Poll", parameters: { type: "object" } }]
        : [{ name: "exec", description: "Gateway", freeform: true, parameters: {} }],
      };
      const args = { session_id: 42, chars: "", yield_time_ms: 60_000 };
      for (const yield_time_ms of [60_001, 180_000, "60000", null]) {
        expect(() => planNativeTool("codex_tool_call", {
          wire_name: "functions__write_stdin", arguments: { ...args, yield_time_ms },
        }, environment, contract)).toThrow("write_stdin yield_time_ms");
      }
      expect(() => planNativeTool("codex_tool_call", {
        wire_name: "functions__write_stdin", input: JSON.stringify(args),
      }, environment, contract)).toThrow("requires structured arguments");
      const plan = planNativeTool("codex_tool_call", {
        wire_name: "functions__write_stdin", arguments: args,
      }, environment, contract);
      if (!("tool" in plan)) throw new Error("Expected an admitted command poll");
      if (direct) expect(plan.payload.arguments).toEqual(args);
      else {
        const calls: unknown[] = [];
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        await new AsyncFunction("tools", "ALL_TOOLS", "text", plan.payload.input!)(
          { functions__write_stdin: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); } },
          [{ name: "functions__write_stdin" }], () => {},
        );
        expect(calls).toEqual([args]);
      }
    });
  }

  test("raw exec checks command polls obtained from registry descriptors and keeps valid arguments", async () => {
    for (const name of ["write_stdin", "functions__write_stdin", "mcp__remote__codex_write_stdin"]) {
      for (const yield_time_ms of [60_001, 60_000]) {
        const args = { session_id: 42, chars: "", yield_time_ms };
        const plan = planNativeTool("codex_tool_call", {
          wire_name: "exec",
          input: `const poll = Object.getOwnPropertyDescriptor(tools, ${JSON.stringify(name)}).value; text(await poll(${JSON.stringify(args)}));`,
        }, bound, "native");
        if (!("tool" in plan)) throw new Error("Expected an admitted native exec");
        const calls: unknown[] = [];
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        const run = new AsyncFunction("tools", "ALL_TOOLS", "text", plan.payload.input!)(
          { [name]: async (input: unknown) => { calls.push(input); return nativePublicResult({ session_id: 42 }); } },
          [{ name }], () => {},
        );
        if (yield_time_ms > 60_000) {
          await expect(run).rejects.toThrow("write_stdin yield_time_ms");
          expect(calls).toEqual([]);
        } else {
          await run;
          expect(calls).toEqual([args]);
        }
      }
    }
  });

  test("inventory advertises the poll limit without changing the native registry", async () => {
    const parameters = { type: "object", properties: { yield_time_ms: { type: "number", maximum: 300_000, default: 180_000 } } };
    const environment: BrokerTurnSnapshot = { registryGeneration: 0, tools: [
      { name: "write_stdin", namespace: "functions", description: "Poll", parameters },
    ] };
    const direct = planNativeTool("codex_tool_inventory", {}, environment, "native");
    expect(direct).toMatchObject({ result: { structuredContent: { tools: [{
      wire_name: "functions__write_stdin", description: expect.stringContaining("at most 60000"),
      parameters: { properties: { yield_time_ms: { maximum: 60_000 } } },
    }] } } });
    expect(JSON.stringify(direct)).not.toContain('"default"');
    expect(parameters.properties.yield_time_ms).toEqual({ type: "number", maximum: 300_000, default: 180_000 });
    const nested = inventory({ query: "write_stdin" });
    const content = await executeCatalog(nested, [{ name: "mcp__remote__codex_write_stdin", description: "Poll" }]);
    expect(finishNativeToolResult(nested.resultContract, { content }).structuredContent).toMatchObject({ tools: [{
      wire_name: "mcp__remote__codex_write_stdin", description: expect.stringContaining("at most 60000"),
    }] });
  });
});
