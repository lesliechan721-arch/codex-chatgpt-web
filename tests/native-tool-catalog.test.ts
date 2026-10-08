import { describe, expect, test } from "bun:test";
import {
  finishNativeToolResult,
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
