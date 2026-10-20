import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createChatGptWebAdapter } from "./helpers/chatgpt-web-adapter";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { DEV_CHAT_TOOLS, DevChatDriver, type DevChatEvent } from "../src/dev-chat/driver";
import { createDevImageProbe, DEV_IMAGE_PROBE_TOOL_NAME } from "../src/dev-chat/image-probe";
import { DevChatStore } from "../src/dev-chat/session";
import { parseRequest } from "../src/responses/parser";
import type { CodexProviderConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  chatGptTurnSessions.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("image probe accepts only exact image IDs and advertises a strict inert contract", () => {
  const tools = DEV_CHAT_TOOLS.filter(tool => tool.name === DEV_IMAGE_PROBE_TOOL_NAME);
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ parameters: {
    type: "object", properties: { image_id: { type: "integer", enum: [1, 2, 3] } },
    required: ["image_id"], additionalProperties: false,
  } });
  for (const input of [undefined, null, 1, "1", [], {}, new Date(),
    { image_id: "1" }, { image_id: true }, { image_id: null }, { image_id: 0 },
    { image_id: 4 }, { image_id: 1.1 }, { image_id: NaN }, { image_id: Infinity },
    { image_id: 1, extra: "data:image/png;base64,not-an-image" },
  ]) expect(() => createDevImageProbe(input)).toThrow("DEV image probe");
});

test("three fixed PNGs contain distinct pixels and only metadata accompanies their images", () => {
  const imageDigests = new Set<string>();
  const pixelDigests = new Set<string>();
  for (const imageId of [1, 2, 3] as const) {
    const probe = createDevImageProbe({ image_id: imageId });
    const png = Buffer.from(probe.image.image_url.split(",")[1]!, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(probe.metadata).toEqual({
      image_id: imageId, mime_type: "image/png", width: 720, height: 240,
      image_bytes: png.length, content_digest: digest(png),
    });
    expect(png.readUInt32BE(16)).toBe(720);
    expect(png.readUInt32BE(20)).toBe(240);
    const chunks: string[] = [];
    const compressed: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      chunks.push(type);
      if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    const pixels = inflateSync(Buffer.concat(compressed));
    expect(pixels.length).toBe(721 * 240);
    expect(pixels.includes(0)).toBe(true);
    expect(pixels.includes(255)).toBe(true);
    imageDigests.add(digest(png));
    pixelDigests.add(digest(pixels));
    const repeated = createDevImageProbe({ image_id: imageId });
    expect(digest(Buffer.from(repeated.image.image_url.split(",")[1]!, "base64"))).toBe(digest(png));
    expect(repeated.metadata).toEqual(probe.metadata);
    const publicText = JSON.stringify({ metadata: probe.metadata, tools: DEV_CHAT_TOOLS });
    expect(publicText).not.toContain("base64");
    expect(publicText).not.toContain("data:image");
    for (const answer of ["482731", "915406", "637258"]) expect(publicText).not.toContain(answer);
  }
  expect(imageDigests.size).toBe(3);
  expect(pixelDigests.size).toBe(3);
});

test("DEV driver carries repeated image results through the real Responses adapter, broker and MCP server", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-dev-image-probe-"));
  roots.push(root);
  // The simulated DEV model consumes the existing inline startup protocol.
  const config = { ...defaultConfig("full"), maxComposerCodePoints: 2_000_000, brokerSocketPath: defaultBrokerEndpoint(join(root, "broker")) };
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  await broker.listen();
  const client = new Client({ name: "dev-image-probe-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", config.brokerSocketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  const devProvider = (provider: CodexProviderConfig): CodexProviderConfig => ({
    ...provider,
    chatgptWeb: {
      ...provider.chatgptWeb,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(root, "thread-environments.json"),
      lunaCheckpointStatePath: join(root, "luna-checkpoints.json"),
    },
  });
  const worker = ChatGptBrowserWorker.forProvider(devProvider(providerConfig(config)));
  const originalRun = worker.run.bind(worker);
  const imageDigests: string[] = [];
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      if (prepared.contextPlan) await turn.onContextPlanSelected?.(prepared.contextPlan.planId);
      await turn.onSendActivated?.();
      await turn.onSubmitted?.();
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("missing DEV image-probe broker token");
      const progress = turn.externalProgress;
      if (!progress) throw new Error("missing DEV image-probe progress transport");
      let operationId = 0;
      for (const imageId of [1, 2, 3, 1]) {
        const previous = progress.snapshot().lastToolBatchRevision;
        const invocation = client.callTool({ name: "codex_tool_call", arguments: {
          turn_token: token, operation_id: ++operationId, task_revision: 0,
          wire_name: DEV_IMAGE_PROBE_TOOL_NAME, arguments: { image_id: imageId },
        } });
        let snapshot = progress.snapshot();
        while (snapshot.lastToolBatchRevision <= previous) {
          snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
        }
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
        const reply = await invocation;
        expect(reply.isError).not.toBe(true);
        const content = reply.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        expect(content.map(part => part.type)).toEqual(["text", "image"]);
        const metadata = reply.structuredContent as Record<string, unknown>;
        expect(JSON.parse(content[0]!.text!)).toEqual(metadata);
        expect(metadata).toMatchObject({ image_id: imageId, mime_type: "image/png", width: 720, height: 240 });
        const image = content[1]!;
        expect(image.mimeType).toBe("image/png");
        const bytes = Buffer.from(image.data!, "base64");
        expect(metadata.image_bytes).toBe(bytes.length);
        expect(metadata.content_digest).toBe(digest(bytes));
        expect(JSON.stringify(metadata)).not.toContain(image.data!);
        imageDigests.push(digest(bytes));
      }
      const previous = progress.snapshot().lastToolBatchRevision;
      const simulatedView = client.callTool({ name: "codex_view_image", arguments: {
        turn_token: token, operation_id: ++operationId, task_revision: 0,
        path: "/dev/no-user-image.png",
      } });
      let snapshot = progress.snapshot();
      while (snapshot.lastToolBatchRevision <= previous) {
        snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
      }
      await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      const simulatedReply = await simulatedView;
      expect(simulatedReply.isError).not.toBe(true);
      expect((simulatedReply.content as Array<{ type: string }>).map(part => part.type)).toEqual(["text"]);
      expect(simulatedReply.structuredContent).toMatchObject({ simulated: true, side_effects_performed: false });
      const answer = "Four MCP image results received in one response.";
      turn.onTextDelta(answer, { expectedDriverGeneration: 0, taskRevision: 0 });
      return answer;
    } finally {
      prepared.release();
    }
  };
  const remote = new RemoteTurnBroker(config.brokerSocketPath);
  const reuseSupport = spyOn(remote, "contextReuseAvailable").mockResolvedValue(false);
  const store = new DevChatStore(join(root, "chats"));
  const driver = new DevChatDriver(config, store,
    provider => createChatGptWebAdapter(devProvider(provider), { broker: remote }), root);
  const events: DevChatEvent[] = [];
  try {
    await client.connect(transport);
    const state = driver.open("image-probe").state;
    const result = await driver.send(state, "Read the image probe in order 1, 2, 3, 1.", event => events.push(event));
    expect(result).toMatchObject({ text: "Four MCP image results received in one response.", toolCalls: 5 });
    expect(browserStarts).toBe(1);
    expect(new Set(imageDigests).size).toBe(3);
    expect(imageDigests[3]).toBe(imageDigests[0]);
    const outputs = state.input.filter(item => item !== null && typeof item === "object"
      && (item as { type?: string }).type === "function_call_output") as Array<{ output: unknown }>;
    expect(outputs).toHaveLength(5);
    for (const output of outputs.slice(0, 4)) {
      const parts = output.output as Array<{ type: string; detail?: string }>;
      expect(parts.map(part => part.type)).toEqual(["input_text", "input_image"]);
      expect(parts[1]!.detail).toBe("original");
    }
    expect(typeof outputs[4]!.output).toBe("string");
    const parsed = parseRequest({ model: state.model, input: state.input, tools: DEV_CHAT_TOOLS });
    const images = parsed.context.messages.filter(message => message.role === "toolResult");
    expect(images).toHaveLength(5);
    for (const message of images.slice(0, 4)) {
      expect(Array.isArray(message.content)).toBe(true);
      expect((message.content as Array<{ type: string }>).map(part => part.type)).toEqual(["text", "image"]);
    }
    const persisted = readFileSync(join(root, "chats", "image-probe.json"), "utf8");
    expect(persisted).toContain("input_image");
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain("data:image");
    expect(eventText).not.toContain("base64");
    for (const answer of ["482731", "915406", "637258"]) expect(eventText).not.toContain(answer);
    expect(events.filter(event => event.type === "tool_result")).toHaveLength(5);
  } finally {
    reuseSupport.mockRestore();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await client.close();
    await driver.close();
    chatGptTurnSessions.clear();
    await Bun.sleep(0);
    await broker.close();
  }
});
