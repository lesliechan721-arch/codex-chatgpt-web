import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "./helpers/chatgpt-web-adapter";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { compactionAvailableTokens } from "../src/adapters/chatgpt-web/compaction-context";
import type { ContextDeliveryPlan } from "../src/adapters/chatgpt-web/context-planner";
import type { ContextUsageEvidence } from "../src/adapters/chatgpt-web/context-runtime";
import * as contextSnapshot from "../src/adapters/chatgpt-web/context-snapshot";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../src/chatgpt-web-models";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { estimateTokens } from "../src/lib/token-estimate";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";
import { CONTEXT_TEXT_READ_FORMAT, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const tailMarker = "unread-tail-evidence-七三九";
const log = `${"recorded test line\n".repeat(3_000)}${tailMarker}\n`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  chatGptTurnSessions.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Entry = { context_id: string; plan_id: string; required_images: number;
  first_call: { name: string; arguments: Record<string, unknown> } };
function navigation(prompt: string): Entry {
  const match = /<codex_context_navigation_json>\n([^\n]+)\n<\/codex_context_navigation_json>/.exec(prompt);
  if (!match) throw new Error("The actual submitted prompt has no context entry");
  return JSON.parse(match[1]!);
}
function data(result: any): any {
  if (result.structuredContent?.format !== CONTEXT_TEXT_READ_FORMAT) return result.structuredContent;
  const { metadata, body } = parseContextTextReadResult(result);
  return { ...metadata, content: body };
}

function paddedPng(size: number): string {
  const original = Buffer.from(png, "base64");
  const chunk = Buffer.alloc(size - original.length);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("paDd", 4);
  let checksum = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]).toString("base64");
}

async function fixture(manual: boolean, sent: boolean) {
  const root = mkdtempSync(join(tmpdir(), "context-adapter-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `context://${root}`, chatgptWeb: {
    browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
    browserInteractionMode: manual ? "manual" : "automatic",
    appName: manual ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME,
    brokerSocketPath: socket, localToolsEnabled: true, solAvailable: !manual,
    extraHighAvailable: false, proAvailable: false, toolAuthorityMode: "delegated",
    zeroRiskRequireSentConfirmation: sent,
  } };
  const client = new Client({ name: "context-adapter-acceptance", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", manual ? "safe" : "native", "--broker-socket", socket],
    cwd: process.cwd(), stderr: "pipe" }));
  const call = (entry: Entry, name = entry.first_call.name, args: Record<string, unknown> = {}) => {
    const { view, ...reference } = entry.first_call.arguments;
    return client.callTool({ name, arguments: { ...reference,
      ...(name === "codex_context_list" ? { view } : {}), ...args } });
  };
  const credential = (entry: Entry) => manual
    ? { request_id: entry.first_call.arguments.request_id }
    : { turn_token: entry.first_call.arguments.turn_token };
  const input = [
    { type: "function_call", call_id: "recorded-call", name: "exec_command", arguments: '{"cmd":"previous recorded test"}' },
    { type: "function_call_output", call_id: "recorded-call", output: log },
    { type: "message", id: "first-user", role: "user", content: [
      { type: "input_text", text: "Read only the first page of the recorded test log and inspect the picture." },
      { type: "input_image", image_url: `data:image/png;base64,${png}` },
    ], internal_chat_message_metadata_passthrough: { turn_id: "first-turn" } },
  ];
  const request = (turnId: string, history: unknown[]) => parseRequest({
    model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : CHATGPT_WEB_BACKEND_MODEL,
    reasoning: { effort: manual ? "low" : "high" }, input: history,
    tools: [{ type: "function", name: "exec_command", description: "Run a command", parameters: {
      type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: turnId }) },
  });
  cleanups.push(async () => { await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true }); });
  return { broker, provider, client, call, credential, input, request };
}

for (const manual of [false, true]) for (const secondBranch of ["full", "resume"] as const)
  for (const sent of manual ? [true, false] : [false])
    test(`${manual ? "Zero Risk" : "Automatic"} ${secondBranch}, Sent=${sent}: two actual sends expose fresh public MCP navigation`, async () => {
      const f = await fixture(manual, sent);
      const prompts: string[] = [];
      let oldEntry: Entry | undefined;
      let oldReadRef: string | undefined;
      let activeEntry: Entry;
      let modelTask: Promise<void> | undefined;
      const navigate = async (prompt: string) => {
        // The simulated model receives only the compiled prompt and public MCP responses.
        const entry = navigation(prompt);
        const round = prompts.length;
        expect(entry.first_call.arguments.context_id).toBe(entry.context_id);
        expect((await f.call(entry)).isError).not.toBe(true);
        if (oldEntry) {
          expect(entry.context_id).not.toBe(oldEntry.context_id);
          expect(entry.first_call.arguments).not.toEqual(oldEntry.first_call.arguments);
          expect((await f.call(oldEntry)).isError).toBe(true);
          expect((await f.call(entry, "codex_context_read", { context_id: oldEntry.context_id, read_ref: oldReadRef })).isError).toBe(true);
          expect((await f.call(entry, "codex_context_read", { read_ref: oldReadRef })).isError).toBe(true);
        }
        const listing = await f.call(entry, "codex_context_list", { view: "entries", kind: "tool_result", tool_name: "exec_command" });
        expect(listing.isError).not.toBe(true);
        const result = data(listing).entries.find((value: any) => value.call_id === "recorded-call");
        expect(result).toBeDefined();
        if (round === 1) {
          expect(prompt).not.toContain(tailMarker);
          expect(result.delivery).toBe("source_on_demand");
          const first = await f.call(entry, "codex_context_read", { read_ref: result.read_ref });
          expect(first.isError).not.toBe(true);
          expect(data(first).content).toBe(log.slice(0, data(first).range.end_exclusive));
          expect(data(first).has_more).toBe(true);
          expect(data(first).content).not.toContain(tailMarker);
          oldReadRef = result.read_ref;
        } else {
          if (secondBranch === "resume") {
            expect(prompt).not.toContain("Read only the first page");
            expect(entry.required_images).toBe(0);
          }
          const search = await f.call(entry, "codex_context_search", { query: tailMarker, kind: "tool_result" });
          expect(search.isError).not.toBe(true);
          const hit = data(search).hits[0];
          const tail = await f.call(entry, "codex_context_read", { read_ref: hit.read_ref, cursor: hit.read_cursor });
          expect(tail.isError).not.toBe(true);
          expect(data(tail).content).toContain(tailMarker);
        }
        const images = await f.call(entry, "codex_context_list", { view: "entries", kind: "image" });
        expect(images.isError).not.toBe(true);
        const picture = data(images).entries[0];
        expect(picture.media_route).toBe("mcp");
        expect(picture.required).toBe(round === 1 || secondBranch === "full");
        if (picture.required) {
          const blocked = await f.client.callTool({ name: "codex_exec", arguments: { ...f.credential(entry), operation_id: 1,
            task_revision: 0, cmd: "must not execute before image delivery" } });
          expect(blocked.isError).toBe(true);
          expect(JSON.stringify(blocked)).toContain("CONTEXT_NOT_READY");
          if (manual) expect((await f.client.callTool({ name: "codex_turn_complete", arguments: {
            ...f.credential(entry), task_revision: 0, final_answer: "premature success" } })).isError).toBe(true);
        }
        const image = await f.call(entry, "codex_context_read", { read_ref: picture.read_ref });
        expect(image.isError).not.toBe(true);
        expect(image.content).toContainEqual(expect.objectContaining({ type: "image", data: png, mimeType: "image/png" }));
        expect(JSON.stringify(image.structuredContent)).not.toContain(png);
        const overview = await f.call(entry);
        expect(data(overview).live.context_ready).toBe(true);
        oldEntry = entry;
        if (manual) expect((await f.client.callTool({ name: "codex_turn_complete", arguments: {
          ...f.credential(entry), task_revision: 0, final_answer: `Completed navigation ${round}` } })).isError).not.toBe(true);
      };
      const worker = ChatGptBrowserWorker.forProvider(f.provider);
      const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
      const automatic = spyOn(worker, "run").mockImplementation(async turn => {
        const full = await turn.prepare();
        const resume = turn.prepareResume ? await turn.prepareResume() : undefined;
        const compiled = prompts.length && secondBranch === "resume" ? resume! : full;
        activeEntry = navigation(compiled.text);
        expect((await f.call(activeEntry)).isError).toBe(true);
        await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
        expect((await f.call(activeEntry)).isError).toBe(true);
        expect(compiled.images).toHaveLength(0);
        await turn.onSendActivated?.();
        await turn.onSubmitted!();
        prompts.push(compiled.text);
        modelTask = navigate(compiled.text);
        await modelTask;
        const answer = `Completed navigation ${prompts.length}`;
        turn.onTextDelta(answer);
        return answer;
      });
      const control: ChatGptZeroRiskManualControl = {
        async start(_path, activity) {
          const useResume = prompts.length > 0 && secondBranch === "resume";
          const prompt = useResume ? activity.resumePrompt! : activity.prompt;
          activeEntry = navigation(prompt);
          expect((await f.call(activeEntry)).isError).toBe(true);
          const selected = useResume ? activity.contextPlans!.resume! : activity.contextPlans!.full!;
          expect(selected.requiredAttachments).toHaveLength(0);
          prompts.push(prompt);
          if (!sent) await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(activeEntry) });
          return { selectedPlanId: selected.planId, reused: useResume };
        },
        async waitSent() {
          expect((await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(activeEntry) })).isError).not.toBe(true);
          expect((await f.call(activeEntry)).isError).toBe(true); // Start does not replace Sent.
        },
        waitTerminal: () => new Promise<never>(() => {}),
        async markStarted() { modelTask = navigate(prompts.at(-1)!); await modelTask; },
        async waitAttachments() { throw new Error("All MCP images require no manual attachment confirmation"); },
        async end() {}, async cancel() {},
      };
      cleanups.push(async () => { automatic.mockRestore(); taskUpdates.mockRestore(); await modelTask?.catch(() => {}); });
      const adapter = createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control });
      const run = async (parsed: ReturnType<typeof f.request>) => {
        const events: AdapterEvent[] = [];
        await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
        await modelTask;
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect(events.some(event => event.type === "text_delta" && event.text === `Completed navigation ${prompts.length}`)).toBe(true);
      };
      await run(f.request("first-turn", f.input));
      expect((await f.call(oldEntry!)).isError).toBe(true);
      await run(f.request("second-turn", [...f.input,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed navigation 1" }] },
        { type: "message", id: "second-user", role: "user", content: "Continue. Read the remaining evidence.",
          internal_chat_message_metadata_passthrough: { turn_id: "second-turn" } },
      ]));
      expect(prompts).toHaveLength(2);
    }, 30_000);

for (const sent of [true, false]) test(`Zero Risk mixed image routes, Sent=${sent}: only the fallback subset needs separate confirmation`, async () => {
  const f = await fixture(true, sent);
  // A valid ancillary text chunk increases source size without changing its pixels.
  const padding = Buffer.alloc(4 * 1024 * 1024, "x");
  Buffer.from("padding\0").copy(padding);
  const chunk = Buffer.alloc(padding.length + 12);
  chunk.writeUInt32BE(padding.length);
  chunk.write("tEXt", 4);
  padding.copy(chunk, 8);
  let checksum = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, chunk.length - 4);
  const original = Buffer.from(png, "base64");
  const padded = Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]);
  const history = structuredClone(f.input);
  history[2]!.content!.push({ type: "input_image", image_url: `data:image/png;base64,${padded.toString("base64")}` } as any);
  let entry: Entry;
  let plan: { planId: string; manifestDigest: string; requiredAttachments: Array<{ id: string; label: string }> };
  let pictures: any[] = [];
  let confirmationCalls = 0;
  let modelTask: Promise<void> | undefined;
  let failModel!: (error: unknown) => void;
  const modelFailed = new Promise<never>((_resolve, reject) => { failModel = reject; });
  void modelFailed.catch(() => {});
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      entry = navigation(activity.prompt);
      plan = activity.contextPlans!.full!;
      expect(plan.requiredAttachments).toHaveLength(1);
      expect(entry.required_images).toBe(2);
      if (!sent) await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(entry) });
      return { selectedPlanId: plan.planId };
    },
    async waitSent() {
      await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(entry) });
      expect((await f.call(entry)).isError).toBe(true);
    },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() {
      try {
        let cursor: string | undefined;
        do {
          const listing = await f.call(entry, "codex_context_list", { view: "entries", kind: "image", ...(cursor ? { cursor } : {}) });
          expect(listing.isError).not.toBe(true);
          pictures.push(...data(listing).entries);
          cursor = data(listing).next_cursor ?? undefined;
        } while (cursor);
        const mcp = pictures.find(value => value.media_route === "mcp");
        const attachment = pictures.find(value => value.media_route === "attachment");
        expect(plan.requiredAttachments.map(value => value.id)).toEqual([attachment.target_id]);
        expect(attachment.read_ref).toBeNull();
        expect(plan.requiredAttachments.map(value => value.id)).not.toContain(mcp.target_id);
        const image = await f.call(entry, "codex_context_read", { read_ref: mcp.read_ref });
        expect(image.content).toContainEqual(expect.objectContaining({ type: "image", data: png }));
        const overview = await f.call(entry);
        expect(data(overview).live).toMatchObject({ context_ready: false, required_images: 2, delivered_images: 1 });
        const blocked = await f.client.callTool({ name: "codex_exec", arguments: { ...f.credential(entry),
          task_revision: 0, operation_id: 1, cmd: "must not execute before fallback confirmation" } });
        expect(JSON.stringify(blocked)).toContain("CONTEXT_NOT_READY");
        expect((await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.credential(entry),
          task_revision: 0, final_answer: "Sent and MCP alone do not confirm attachments" } })).isError).toBe(true);
      } catch (error) { failModel(error); throw error; }
    },
    async waitAttachments(_path, owner) {
      confirmationCalls++;
      expect(owner).toMatchObject({ planId: plan.planId, manifestDigest: plan.manifestDigest });
      expect(pictures.filter(value => value.media_route === "attachment")).toHaveLength(1);
      expect(data(await f.call(entry)).live.context_ready).toBe(false);
      modelTask = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          (async () => {
            expect(data(await f.call(entry)).live.context_ready).toBe(true);
            const done = await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.credential(entry),
              task_revision: 0, final_answer: "MCP image and attested fallback delivered" } });
            expect(done.isError).not.toBe(true);
          })().then(resolve, reject);
        }, 0);
      });
      void modelTask.catch(failModel);
      return { status: "user_attested", planId: plan.planId, manifestDigest: plan.manifestDigest,
        requiredCount: 1, attestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30_000).toISOString() };
    },
    async end() {}, async cancel() {},
  };
  const events: AdapterEvent[] = [];
  await Promise.race([createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control }).runTurn!(
    f.request("first-turn", history), { headers: new Headers() }, event => events.push(event)), modelFailed]);
  await modelTask;
  expect(confirmationCalls).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "text_delta" && event.text === "MCP image and attested fallback delivered")).toBe(true);
}, 30_000);

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} carries actual navigation costs into the retained page and compaction reserve`, async () => {
  const f = await fixture(manual, true);
  // Observe the actual selected plan. This evidence is never given to the simulated model.
  const prepared = new Map<string, { send: ContextSend; costs: ContextDeliveryPlan["costs"] }>();
  const originalPrepare = ContextSend.prototype.prepare;
  const planning = spyOn(ContextSend.prototype, "prepare").mockImplementation(async function(this: ContextSend, ...args) {
    const plan = await originalPrepare.apply(this, args);
    if (plan.planId) prepared.set(plan.planId, { send: this, costs: structuredClone(plan.costs) });
    return plan;
  });
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  let round = 0;
  let submittedPrompt = "";
  let firstPlanId = "";
  let secondPlanId = "";
  let initialPageTokens = 0;
  let finalUsage: ContextUsageEvidence | undefined;
  let modelFailure: unknown;
  const answer = (value: number) => `Completed budget navigation ${value}`;
  const inspect = async (prompt: string) => {
    const entry = navigation(prompt);
    if (round === 1) {
      firstPlanId = entry.plan_id;
      const selected = prepared.get(firstPlanId)!;
      expect(selected.send.coverage.latest()).toMatchObject({ planId: firstPlanId, delivered: true });
      initialPageTokens = selected.send.coverage.latest()!.pageTokens;
      const token = String(entry.first_call.arguments.request_id ?? entry.first_call.arguments.turn_token);
      let usage = f.broker.contextUsage(token)!;
      expect(usage.usage.wire_bytes).toBe(0);
      expect(usage.reserved_tokens_used).toBe(0);
      const paid = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await f.call(entry, name, args);
        const next = f.broker.contextUsage(token)!;
        expect(next.usage.wire_bytes).toBeGreaterThan(usage.usage.wire_bytes);
        expect(next.usage.text_tokens + next.usage.visual_token_reserve)
          .toBeGreaterThan(usage.usage.text_tokens + usage.usage.visual_token_reserve);
        expect(next.reserved_tokens_used).toBeGreaterThanOrEqual(usage.reserved_tokens_used);
        usage = next;
        return result;
      };
      expect((await paid(entry.first_call.name)).isError).not.toBe(true);
      const images = await paid("codex_context_list", { view: "entries", kind: "image" });
      expect(images.isError).not.toBe(true);
      const picture = data(images).entries[0];
      expect(picture).toMatchObject({ required: true, media_route: "mcp" });
      const firstImage = await paid("codex_context_read", { read_ref: picture.read_ref });
      expect(firstImage.isError).not.toBe(true);
      expect(firstImage.content).toContainEqual(expect.objectContaining({ type: "image", data: png }));
      const imageReserveUsed = usage.reserved_tokens_used;
      expect(imageReserveUsed).toBeGreaterThan(0);
      expect(imageReserveUsed).toBeLessThanOrEqual(selected.costs.requiredMcpTokens);
      const results = await paid("codex_context_list", { view: "entries", kind: "tool_result" });
      expect(results.isError).not.toBe(true);
      const resultRef = data(results).entries.find((value: any) => value.call_id === "recorded-call").read_ref;
      const firstPage = await paid("codex_context_read", { read_ref: resultRef });
      expect(firstPage.isError).not.toBe(true);
      expect(data(firstPage).has_more).toBe(true);
      expect(data(firstPage).content).not.toContain(tailMarker);
      const search = await paid("codex_context_search", { kind: "tool_result", query: tailMarker });
      expect(search.isError).not.toBe(true);
      expect(data(search).hits).toHaveLength(1);
      const hit = data(search).hits[0];
      const tail = await paid("codex_context_read", { read_ref: hit.read_ref, cursor: hit.read_cursor });
      expect(tail.isError).not.toBe(true);
      expect(data(tail).content).toContain(tailMarker);
      const repeatPage = await paid("codex_context_read", { read_ref: resultRef });
      expect(repeatPage.isError).not.toBe(true);
      expect(data(repeatPage).content).toBe(data(firstPage).content);
      const repeatImage = await paid("codex_context_read", { read_ref: picture.read_ref });
      expect(repeatImage.isError).not.toBe(true);
      expect(usage.usage.image_reads).toBe(2);
      expect(usage.reserved_tokens_used).toBe(imageReserveUsed);
      // Corrupt a public cursor. No private reference or capability is supplied to the model.
      const publicCursor: string = data(firstPage).next_cursor;
      const errors = usage.usage.error_responses;
      const invalidCursor = await paid("codex_context_read", { read_ref: resultRef,
        cursor: `${publicCursor.slice(0, -4)}AAAA` });
      expect(invalidCursor.isError).toBe(true);
      expect(JSON.stringify(invalidCursor.structuredContent)).toContain("INVALID_CURSOR");
      expect(usage.usage.error_responses).toBe(errors + 1);
      expect(usage.usage.navigation_stopped).toBe(false);
      finalUsage = usage;
    } else {
      secondPlanId = entry.plan_id;
      expect(entry.required_images).toBe(0);
      expect((await f.call(entry)).isError).not.toBe(true);
    }
    if (manual) expect((await f.client.callTool({ name: "codex_turn_complete", arguments: {
      ...f.credential(entry), task_revision: 0, final_answer: answer(round) } })).isError).not.toBe(true);
  };
  const automatic = spyOn(worker, "run").mockImplementation(async turn => {
    round++;
    const compiled = round === 1 ? await turn.prepare() : await turn.prepareResume!();
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    await turn.onSendActivated?.();
    await turn.onSubmitted!();
    await inspect(compiled.text);
    turn.onTextDelta(answer(round));
    return answer(round);
  });
  cleanups.push(async () => { automatic.mockRestore(); taskUpdates.mockRestore(); planning.mockRestore(); });
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      round++;
      submittedPrompt = round === 1 ? activity.prompt : activity.resumePrompt!;
      const selected = round === 1 ? activity.contextPlans!.full! : activity.contextPlans!.resume!;
      return { selectedPlanId: selected.planId, reused: round !== 1 };
    },
    async waitSent() {
      expect((await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(navigation(submittedPrompt)) })).isError).not.toBe(true);
    },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() {
      try { await inspect(submittedPrompt); }
      catch (error) { modelFailure = error; throw error; }
    },
    async waitAttachments() { throw new Error("The required image uses MCP"); },
    async end() {}, async cancel() {},
  };
  const adapter = createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control });
  const run = async (history: unknown[], turnId: string) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(f.request(turnId, history), { headers: new Headers() }, event => events.push(event));
    if (modelFailure) throw modelFailure;
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.some(event => event.type === "text_delta" && event.text === answer(round))).toBe(true);
  };
  await run(f.input, "first-turn");
  const first = prepared.get(firstPlanId)!;
  const actualTokens = finalUsage!.usage.text_tokens + finalUsage!.usage.visual_token_reserve;
  const chargedTokens = actualTokens - finalUsage!.reserved_tokens_used;
  expect(chargedTokens).toBeGreaterThan(0);
  const firstRecord = first.send.coverage.latest()!;
  expect(firstRecord.navigationUsage).toEqual({ tokens: actualTokens, wireBytes: finalUsage!.usage.wire_bytes,
    reservedTokensUsed: finalUsage!.reserved_tokens_used, chargedTokens });
  expect(firstRecord.pageTokens).toBe(initialPageTokens + chargedTokens);
  expect(first.send.coverage.pageTokenReserve()).toBe(firstRecord.pageTokens);
  await run([...f.input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: answer(1) }] },
    { type: "message", id: "budget-second-user", role: "user", content: "Continue in the retained page.",
      internal_chat_message_metadata_passthrough: { turn_id: "second-turn" } },
  ], "second-turn");
  const second = prepared.get(secondPlanId)!;
  expect(second.costs.retainedTokens).toBe(firstRecord.pageTokens + estimateTokens(answer(1)));
  expect(second.send.coverage.metadata().find(record => record.planId === firstPlanId)).toEqual(firstRecord);
  expect(second.send.coverage.pageTokenReserve()).toBe(second.send.coverage.latest()!.pageTokens);
  expect(second.send.coverage.pageTokenReserve()).toBeGreaterThan(second.costs.retainedTokens);
  for (const selected of [first, second]) {
    expect(compactionAvailableTokens(f.request("budget-check", f.input), {
      localToolsEnabled: true, solAvailable: !manual, extraHighAvailable: false, proAvailable: false,
    }, selected.send.coverage.pageTokenReserve()))
      .toBe(Math.max(0, selected.costs.contextWindowTokens - selected.send.coverage.pageTokenReserve() - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS));
  }
}, 30_000);

test("Zero Risk rejects an unavailable required image before exposing a manual prompt", async () => {
  const f = await fixture(true, true);
  const history = structuredClone(f.input);
  history[2]!.content![1] = { type: "input_image", image_url: "file_id:unavailable-image" } as any;
  let starts = 0;
  const control: ChatGptZeroRiskManualControl = {
    async start() { starts++; }, async waitSent() {}, waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() {}, async end() {}, async cancel() {},
  };
  const events: AdapterEvent[] = [];
  await expect(createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control }).runTurn!(
    f.request("first-turn", history), { headers: new Headers() }, event => events.push(event)))
    .rejects.toMatchObject({ code: "CONTEXT_IMAGE_UNAVAILABLE" });
  expect(starts).toBe(0);
  expect(events.some(event => event.type === "done")).toBe(false);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} can send a valid retained resume when the full candidate cannot deliver an old image`, async () => {
  const f = await fixture(manual, true);
  const history = [
    { type: "message", role: "user", content: [{ type: "input_image", file_id: "historical-image-without-bytes" }],
      internal_chat_message_metadata_passthrough: { turn_id: "old-turn" } },
    { type: "message", role: "assistant", content: "Earlier picture already inspected in the retained conversation." },
    ...f.input.slice(0, 2),
    { type: "message", id: "first-user", role: "user", content: "Read the saved test evidence.",
      internal_chat_message_metadata_passthrough: { turn_id: "first-turn" } },
  ];
  let entry: Entry;
  let modelTask: Promise<void> | undefined;
  const inspect = async () => {
    expect(entry.required_images).toBe(0);
    const pictures = await f.call(entry, "codex_context_list", { view: "entries", kind: "image" });
    expect(pictures.isError).not.toBe(true);
    expect(data(pictures).entries).toContainEqual(expect.objectContaining({ required: false,
      media_route: "unavailable", read_ref: null }));
    const search = await f.call(entry, "codex_context_search", { kind: "tool_result", query: tailMarker });
    expect(search.isError).not.toBe(true);
    const hit = data(search).hits[0];
    const source = await f.call(entry, "codex_context_read", { read_ref: hit.read_ref, cursor: hit.read_cursor });
    expect(source.isError).not.toBe(true);
    expect(data(source).content).toContain(tailMarker);
    if (manual) expect((await f.client.callTool({ name: "codex_turn_complete", arguments: {
      ...f.credential(entry), task_revision: 0, final_answer: "Valid resume despite invalid full candidate" } })).isError).not.toBe(true);
  };
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  const automatic = spyOn(worker, "run").mockImplementation(async turn => {
    await expect(turn.prepare()).rejects.toMatchObject({ code: "CONTEXT_IMAGE_UNAVAILABLE" });
    const compiled = await turn.prepareResume!();
    entry = navigation(compiled.text);
    expect(compiled.images).toHaveLength(0);
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    await turn.onSendActivated?.();
    await turn.onSubmitted!();
    modelTask = inspect();
    await modelTask;
    turn.onTextDelta("Valid resume despite invalid full candidate");
    return "Valid resume despite invalid full candidate";
  });
  cleanups.push(async () => { automatic.mockRestore(); taskUpdates.mockRestore(); await modelTask?.catch(() => {}); });
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      expect(activity.prompt).toBe("");
      expect(activity.contextPlans!.full).toBeUndefined();
      entry = navigation(activity.resumePrompt!);
      expect((await f.call(entry)).isError).toBe(true);
      return { reused: true, selectedPlanId: activity.contextPlans!.resume!.planId };
    },
    async waitSent() { await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(entry) }); },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() { modelTask = inspect(); await modelTask; },
    async end() {}, async cancel() {},
  };
  const events: AdapterEvent[] = [];
  await createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control }).runTurn!(
    f.request("first-turn", history), { headers: new Headers() }, event => events.push(event));
  await modelTask;
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "text_delta" && event.text === "Valid resume despite invalid full candidate")).toBe(true);
}, 30_000);

for (const branch of ["full", "resume"] as const) test(`Zero Risk selects ${branch === "full" ? "a new page with a fast full body" : "a retained page with resume navigation"} when only resume has a context entry`, async () => {
  const f = await fixture(true, true);
  const shortResult = "Short recorded result for the retained page.";
  const history = [
    { type: "function_call", call_id: "short-recorded-call", name: "exec_command", arguments: '{"cmd":"previous short test"}' },
    { type: "function_call_output", call_id: "short-recorded-call", output: shortResult },
    { type: "message", role: "assistant", content: "Earlier short task completed." },
    { type: "message", role: "user", id: "current-short-user", content: "Continue the short recorded task.",
      internal_chat_message_metadata_passthrough: { turn_id: "first-turn" } },
  ];
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  cleanups.push(async () => { taskUpdates.mockRestore(); });
  let resumeEntry: Entry;
  let request: { request_id: string };
  let selectedPlanId: string;
  let modelFailure: unknown;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      expect(activity.prompt).not.toContain("<codex_context_navigation_json>");
      expect(activity.prompt).toContain(shortResult);
      const resumeContext = JSON.parse(/<codex_context_json>\n([^\n]+)/.exec(activity.resumePrompt!)![1]!);
      expect(resumeContext.messages).not.toContainEqual(expect.objectContaining({ content: shortResult }));
      resumeEntry = navigation(activity.resumePrompt!);
      const plans = activity.contextPlans!;
      expect(plans.full).toBeDefined();
      expect(plans.resume!.planId).toBe(resumeEntry.plan_id);
      expect(plans.full!.planId).not.toBe(plans.resume!.planId);
      expect(plans.full!.requiredAttachments).toHaveLength(0);
      const submittedPrompt = branch === "full" ? activity.prompt : activity.resumePrompt!;
      request = JSON.parse(/<codex_zero_risk_request_json>\n([^\n]+)/.exec(submittedPrompt)![1]!);
      selectedPlanId = plans[branch]!.planId;
      expect((await f.call(resumeEntry)).isError).toBe(true);
      return { selectedPlanId, reused: branch === "resume" };
    },
    async waitSent() {
      expect((await f.client.callTool({ name: "codex_turn_start", arguments: request })).isError).not.toBe(true);
      expect((await f.call(resumeEntry)).isError).toBe(true);
    },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() {
      try {
        const overview = await f.call(resumeEntry);
        if (branch === "full") {
          // A descriptor selects the unchanged full body; the prepared resume entry remains unauthorized.
          expect(overview.isError).toBe(true);
        } else {
          expect(overview.isError).not.toBe(true);
          expect(data(overview).live.context_ready).toBe(true);
          expect(resumeEntry.plan_id).toBe(selectedPlanId);
          const listing = await f.call(resumeEntry, "codex_context_list", { view: "entries", kind: "tool_result" });
          expect(listing.isError).not.toBe(true);
          const recorded = data(listing).entries.find((entry: any) => entry.call_id === "short-recorded-call");
          expect(recorded.delivery).toBe("source_on_demand");
          const result = await f.call(resumeEntry, "codex_context_read", { read_ref: recorded.read_ref });
          expect(result.isError).not.toBe(true);
          expect(data(result).content).toBe(shortResult);
        }
        const completion = await f.client.callTool({ name: "codex_turn_complete", arguments: {
          ...request, task_revision: 0, final_answer: `Completed selected ${branch} body` } });
        expect(completion.isError, JSON.stringify(completion.structuredContent ?? completion.content)).not.toBe(true);
      } catch (error) { modelFailure = error; throw error; }
    },
    async waitAttachments() { throw new Error("Both candidates have no manual fallback attachments"); },
    async end() {}, async cancel() {},
  };
  const events: AdapterEvent[] = [];
  await createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control }).runTurn!(
    f.request("first-turn", history), { headers: new Headers() }, event => events.push(event));
  if (modelFailure) throw modelFailure;
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "text_delta" && event.text === `Completed selected ${branch} body`)).toBe(true);
}, 30_000);

for (const manual of [false, true]) for (const source of ["system", "delegation"] as const)
  test(`${manual ? "Zero Risk" : "Automatic"} resume preserves required ${source} image bytes ahead of crowded historical user images`, async () => {
    const f = await fixture(manual, true);
    // Scale the 9 x 3 MiB + 4 MiB reproduction below the real 32 MiB source limit.
    // Only the existing bounded snapshot budget is reduced; every source byte, route,
    // receipt and public MCP return uses the production implementation.
    const createSnapshot = contextSnapshot.createContextSnapshot;
    const snapshotBudget = spyOn(contextSnapshot, "createContextSnapshot").mockImplementation((request, options = {}) =>
      createSnapshot(request, options.imageStoragePolicy === "bounded"
        ? { ...options, maxStorageBytes: Math.floor(3.2 * 1024 * 1024) } : options));
    cleanups.push(async () => { snapshotBudget.mockRestore(); });
    const historicalImage = paddedPng(300 * 1024);
    const requiredImage = paddedPng(400 * 1024);
    const imageContent = [{ type: "input_text", text: "Use this required reference." },
      { type: "input_image", image_url: `data:image/png;base64,${requiredImage}` }];
    const history = [
      ...(source === "system" ? [{ type: "message", role: "system", content: imageContent }] : []),
      ...Array.from({ length: 9 }, (_, index) => ({ type: "message", id: `historical-image-${index}`, role: "user",
        content: [{ type: "input_image", image_url: `data:image/png;base64,${historicalImage}` }] })),
      { type: "message", role: "assistant", content: "Earlier images already inspected." },
      ...(source === "delegation" ? [{ type: "agent_message", id: "parent-image-instruction", author: "/root",
        recipient: "/root/image-child", content: imageContent }] : []),
      { type: "message", id: "image-priority-current", role: "user", content: "Continue with the reference.",
        internal_chat_message_metadata_passthrough: { turn_id: "first-turn" } },
    ];
    const parsed = f.request("first-turn", history);
    if (source === "delegation") {
      const raw = parsed._rawBody as { client_metadata: Record<string, string> };
      raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
        ...JSON.parse(raw.client_metadata["x-codex-turn-metadata"]!), request_kind: "turn",
        parent_thread_id: "image-parent", subagent_kind: "thread_spawn", agent_name: "/root/image-child",
      });
    }
    const worker = ChatGptBrowserWorker.forProvider(f.provider);
    const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
    let fullEntry: Entry;
    let resumeEntry: Entry;
    let modelFailure: unknown;
    let attachmentConfirmations = 0;
    const answer = `Required ${source} image delivered through MCP`;
    const inspect = async () => {
      expect(resumeEntry.required_images).toBe(1);
      expect(resumeEntry.plan_id).not.toBe(fullEntry.plan_id);
      const before = await f.call(resumeEntry);
      expect(before.isError).not.toBe(true);
      expect(data(before).live).toMatchObject({ context_ready: false, required_images: 1, delivered_images: 0 });
      const pictures: any[] = [];
      let cursor: string | undefined;
      do {
        const listing = await f.call(resumeEntry, "codex_context_list", { view: "entries", kind: "image", ...(cursor ? { cursor } : {}) });
        expect(listing.isError).not.toBe(true);
        pictures.push(...data(listing).entries);
        cursor = data(listing).next_cursor ?? undefined;
      } while (cursor);
      const required = pictures.filter(picture => picture.required);
      expect(required).toHaveLength(1);
      expect(required[0]).toMatchObject({ source_kind: source, original_role: source === "system" ? "system" : "agentMessage",
        media_route: "mcp" });
      if (source === "delegation") expect(required[0]).toMatchObject({ author: "/root", recipient: "/root/image-child" });
      expect(typeof required[0].read_ref).toBe("string");
      expect(pictures.filter(picture => picture.source_kind === "user")).toHaveLength(9);
      expect(pictures.some(picture => !picture.required && picture.media_route === "unavailable")).toBe(true);
      const returned = await f.call(resumeEntry, "codex_context_read", { read_ref: required[0].read_ref });
      expect(returned.isError).not.toBe(true);
      const blocks = returned.content as Array<{ type: string; mimeType?: string; data?: string }>;
      const image = blocks.find(block => block.type === "image")!;
      expect(image).toBeDefined();
      expect(image.mimeType).toBe("image/png");
      expect(typeof image.data).toBe("string");
      expect(Buffer.from(image.data!, "base64").byteLength).toBe(400 * 1024);
      expect(image.data === requiredImage).toBe(true);
      expect(data(await f.call(resumeEntry)).live).toMatchObject({ context_ready: true, delivered_images: 1 });
      if (manual) expect((await f.client.callTool({ name: "codex_turn_complete", arguments: {
        ...f.credential(resumeEntry), task_revision: 0, final_answer: answer } })).isError).not.toBe(true);
    };
    const automatic = spyOn(worker, "run").mockImplementation(async turn => {
      try {
        const full = await turn.prepare();
        const resume = await turn.prepareResume!();
        fullEntry = navigation(full.text);
        resumeEntry = navigation(resume.text);
        expect(full.contextPlan!.planId).not.toBe(resume.contextPlan!.planId);
        expect(full.contextPlan!.requiredAttachments.length).toBeGreaterThan(0);
        expect(full.images.length).toBeGreaterThan(0);
        expect(full.images).toHaveLength(full.contextPlan!.requiredAttachments.length);
        expect(resume.contextPlan!.requiredAttachments).toHaveLength(0);
        expect(resume.images).toHaveLength(0);
        await turn.onContextPlanSelected!(resume.contextPlan!.planId);
        await turn.onSendActivated?.();
        await turn.onSubmitted!();
        await inspect();
        turn.onTextDelta(answer);
        return answer;
      } catch (error) { modelFailure = error; throw error; }
    });
    cleanups.push(async () => { automatic.mockRestore(); taskUpdates.mockRestore(); });
    const control: ChatGptZeroRiskManualControl = {
      async start(_path, activity) {
        try {
          fullEntry = navigation(activity.prompt);
          resumeEntry = navigation(activity.resumePrompt!);
          const full = activity.contextPlans!.full!;
          const resume = activity.contextPlans!.resume!;
          expect(full.planId).not.toBe(resume.planId);
          expect(full.requiredAttachments.length).toBeGreaterThan(0);
          expect(resume.requiredAttachments).toHaveLength(0);
          return { selectedPlanId: resume.planId, reused: true };
        } catch (error) { modelFailure = error; throw error; }
      },
      async waitSent() {
        expect((await f.client.callTool({ name: "codex_turn_start", arguments: f.credential(resumeEntry) })).isError).not.toBe(true);
      },
      waitTerminal: () => new Promise<never>(() => {}),
      async markStarted() { try { await inspect(); } catch (error) { modelFailure = error; throw error; } },
      async waitAttachments() {
        attachmentConfirmations++;
        throw new Error("The selected resume image must use MCP and require no attachment confirmation");
      },
      async end() {}, async cancel() {},
    };
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: control }).runTurn!(
      parsed, { headers: new Headers() }, event => events.push(event));
    if (modelFailure) throw modelFailure;
    expect(attachmentConfirmations).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.some(event => event.type === "text_delta" && event.text === answer)).toBe(true);
  }, 30_000);
