/**
 * Real installed Codex + product Responses bridge and input-custody probe.
 * Run: bun scripts/probe-continuity-input-queue.ts
 * Optional: --codex /absolute/path/to/codex --output /absolute/evidence/directory --auth api-key
 * Default: built-in OpenAI route with synthetic ChatGPT auth, only sent to loopback.
 * All provider responses are deterministic fixtures. No tools or real accounts.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityTaskInputStore, type TaskInputIdentity } from "../src/adapters/chatgpt-web/continuity-task-input-store";
import { taskInputControl } from "../src/task-input-control";
import { trustedChatGptTaskUpdateUserText } from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { readJsonRequestBody } from "../src/http-body";

type Json = Record<string, any>;
type Scenario = "waiting" | "boundaries" | "steer" | "capacity" | "capacity-retry" | "unknown" | "reconnect" | "unknown-reconnect" | "cancel";
const timeoutMs = 30_000;
const repository = resolve(import.meta.dir, "..");
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}
const codexPath = option("--codex") ?? Bun.which("codex");
const authRoute = option("--auth") ?? "chatgpt";
if (!["chatgpt", "api-key"].includes(authRoute)) throw new Error("--auth must be chatgpt or api-key.");
if (!codexPath || !isAbsolute(codexPath)) throw new Error("A real installed Codex binary is required.");
const codex = realpathSync(codexPath);
const runId = new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`;
const output = resolve(option("--output") ?? join(repository, ".dev-workflows/continuity-input-queue/builds/001/client-evidence", runId));
if (existsSync(output) && readdirSync(output).length) throw new Error("Evidence already exists; select a new empty output directory.");
mkdirSync(output, { recursive: true, mode: 0o700 });
const probeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cgw-product-client-")));
const isolatedUserDirectory = join(probeRoot, "user");
const bootstrap = join(probeRoot, "bootstrap");
mkdirSync(isolatedUserDirectory); mkdirSync(bootstrap);
// These are actual subprocess configuration/isolation options. The parent environment
// and the user's HOME/CODEX_HOME and existing Codex configuration are never changed.
const isolatedEnvironment = (configuration: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: probeRoot, LANG: "en_US.UTF-8",
  HOME: isolatedUserDirectory, CODEX_HOME: configuration, CODEX_SQLITE_HOME: configuration,
  CGW_LOCAL_PROBE_KEY: "synthetic-loopback-only",
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const delay = (ms: number) => Bun.sleep(ms);
const textOf = (item: Json): string => typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content
  : (item.content ?? []).map((part: Json) => part.text ?? "").join("\n");
const markers = (text: string): string[] => text.match(/PROBE_[A-Z_]+/g) ?? [];
function itemSummary(item: Json): Json {
  return { type: item.type, role: item.role, phase: item.phase, status: item.status,
    id: item.id, markers: markers(textOf(item)), ...(item.call_id ? { nativeToolPresent: true } : {}) };
}
function outputShape(response: Json): Json {
  return { status: response.status, endTurn: response.end_turn,
    output: (response.output ?? []).map((item: Json) => ({ type: item.type, role: item.role, phase: item.phase, status: item.status, text: textOf(item) })) };
}
const report: Json = {
  schema: "codex-chatgpt-web/product-input-client-probe/v1", capturedAt: new Date().toISOString(),
  authRoute: authRoute === "chatgpt" ? "built-in-openai/synthetic-chatgpt" : "custom-provider/synthetic-api-key",
  perScenarioTimeoutMs: timeoutMs, scenarios: [], scope: {
    installedCodex: true, productResponsesBridge: true, productInputControl: true,
    productQueueScheduler: false, browser: false, accounts: false, externalProvider: false, toolCalls: 0,
  }, isolation: { temporaryCodexHome: true, syntheticAuthOnly: true, providerAndChatGPTBaseURLs: "loopback", httpProxy: "loopback" }, limitations: [
    "Physical boundaries are AdapterEvent fixtures, not real ChatGPT browser responses (C03).",
    "No tool capability or competing observer is created. Single-driver and browser Send/ACK races are not covered.",
    "Codex requests SSE. JSON is checked by a loopback companion using the same product bridge event sequence.",
    "Short heartbeat waits do not prove long-duration idle behavior or UI draft recovery.",
    "The loopback provider exercises input custody directly. It does not stand in for full adapter queue integration.",
  ],
  acceptance: { C01: "partial; automatic Responses retry and explicit new turn are measured separately", C02: "partial; product transport subset only", C03: "not tested" },
};
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

async function run(name: Scenario, template: Json): Promise<void> {
  const evidence: Json = { name, status: "running", requests: [], rpc: [], clientEvents: [], wireEvents: [], adapterEvents: [], checks: {}, limitations: [] };
  report.scenarios.push(evidence); save();
  const startedAt = Date.now(), at = () => Date.now() - startedAt;
  const configuration = join(probeRoot, name), workspace = join(configuration, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), "Local synthetic protocol probe. Never use tools.\n");
  writeFileSync(join(configuration, "models.json"), JSON.stringify({ models: [template] }));
  const storage = join(configuration, "custody"); new ContinuityRegistrationStore(storage).initialize();
  const identity: TaskInputIdentity = { thread: digest(`local-thread:${name}`), scope: digest("loopback-probe-scope"), taskId: `probe-${name}` };
  const messageId = `probe-${name}-stable-user-id`, original = `PROBE_${name.toUpperCase().replaceAll("-", "_")}_ORIGINAL`;
  const steerId = "probe-steer-added-user-id";
  const store = new ContinuityTaskInputStore(storage);
  if (name === "capacity" || name === "capacity-retry") store.receive(identity, Array.from({ length: 128 }, (_, i) => ({ messageId: `filler-${i}`, text: `synthetic filler ${i}` })));
  let stopped = false, streamOpen = false, wireBuffer = "", threadId = "", rolloutPath = "", custodyMessageId = "";
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined, readLoop: Promise<void> | undefined, stderr: Promise<string> | undefined;
  let completedResponse: Json | undefined, requestCount = 0;
  let receiveFailurePhase = true;
  const nativeOriginalByRequest = new Map<number, { messageId: string; text: string }>();
  const notifications: Json[] = [], pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let nextRpc = 1, timeout: ReturnType<typeof setTimeout> | undefined;
  let seenFirst!: () => void, releaseFirst!: () => void;
  const firstSeen = new Promise<void>(resolve => { seenFirst = resolve; });
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const normalEvents = (): AdapterEvent[] => name === "boundaries" ? [
    { type: "text_delta", text: "PROBE_FIRST_PHYSICAL", phase: "final_answer" }, { type: "assistant_boundary" },
    { type: "text_delta", text: "PROBE_SECOND_PHYSICAL", phase: "final_answer" }, { type: "done", endTurn: true },
  ] : [{ type: "text_delta", text: "PROBE_FINAL", phase: "final_answer" }, { type: "done", endTurn: true }];
  function wire(chunk: Uint8Array, request: number): void {
    wireBuffer += new TextDecoder().decode(chunk);
    let end: number;
    while ((end = wireBuffer.indexOf("\n\n")) >= 0) {
      const frame = wireBuffer.slice(0, end); wireBuffer = wireBuffer.slice(end + 2);
      const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const value = JSON.parse(data);
      evidence.wireEvents.push({ atMs: at(), request, type: value.type,
        ...(value.item ? { item: itemSummary(value.item) } : {}),
        ...(value.response && ["response.completed", "response.failed", "response.incomplete"].includes(value.type)
          ? { status: value.response.status, errorCode: value.response.error?.code } : {}) });
    }
  }
  async function* adapterEvents(number: number): AsyncGenerator<AdapterEvent> {
    async function* sequence(): AsyncGenerator<AdapterEvent> {
      if (name === "reconnect" || name === "unknown-reconnect" || name === "capacity-retry") {
        const current = nativeOriginalByRequest.get(number)!;
        if (name === "capacity-retry" && number === 1) {
          try { store.receive(identity, [current]); throw new Error("Expected capacity rejection did not occur."); }
          catch (error) {
            if ((error as { code?: string }).code !== "continuity_resource_capacity") throw error;
            evidence.receiveFailure = { code: "continuity_resource_capacity", receiveStatus: "not-received" };
            evidence.originalAbsentAfterRejection = !store.get(identity)!.messages.some(message => message.messageId === current.messageId);
          }
          for (const message of store.list(identity)) store.discard(identity, message.messageId);
          store.cleanup(identity);
          yield { type: "error", code: "continuity_resource_capacity", status: 409, errorType: "invalid_request_error", retryable: false,
            message: "Input was not accepted because capacity was full. Retry the original message ID." };
          return;
        }
        const accepting = name === "unknown-reconnect" && number === 1
          ? new ContinuityTaskInputStore(storage, { afterPayloadWrite: () => { throw new Error("synthetic lost receive receipt"); } }) : store;
        try {
          const accepted = accepting.receive(identity, [current]);
          evidence.receipts ??= [];
          evidence.receipts.push({ request: number, messageId: current.messageId, bodyDigest: digest(current.text), receivedSequence: accepted.receivedSequence,
            copies: accepted.messages.filter(message => message.messageId === custodyMessageId).length, state: "accepted" });
        } catch (error) {
          if (name !== "unknown-reconnect" || number !== 1 || (error as { receiveStatus?: string }).receiveStatus !== "unknown") throw error;
          const reserved = store.get(identity)!;
          evidence.receipts = [{ request: number, messageId: current.messageId, bodyDigest: digest(current.text), receivedSequence: reserved.receivedSequence,
            copies: reserved.messages.filter(message => message.messageId === custodyMessageId).length, state: "unknown" }];
        }
      }
      if ((name === "capacity" || name === "unknown") && receiveFailurePhase) {
        try {
          const accepting = name === "unknown" ? new ContinuityTaskInputStore(storage, { afterPayloadWrite: () => { throw new Error("synthetic receipt-loss window"); } }) : store;
          if (!custodyMessageId) throw new Error("The real provider request has no original stable message ID.");
          // Keep the uncertain receipt unavailable throughout the client's retry
          // budget. Separate unknown-reconnect measures successful same-ID retry.
          if (name === "unknown" && number > 1) throw Object.assign(new Error("Synthetic receipt remains unavailable"), { receiveStatus: "unknown" });
          accepting.receive(identity, [nativeOriginalByRequest.get(number)!]);
          throw new Error("The expected custody rejection did not occur.");
        } catch (error) {
          const failure = error as { code?: string; receiveStatus?: string };
          if (name === "capacity" && failure.code !== "continuity_resource_capacity" || name === "unknown" && failure.receiveStatus !== "unknown") throw error;
          evidence.receiveFailure = { code: failure.code ?? "continuity_unverified", receiveStatus: failure.receiveStatus ?? "not-received" };
          evidence.receiveFailures ??= [];
          evidence.receiveFailures.push({ request: number, ...evidence.receiveFailure,
            messageId: evidence.requests[number - 1].input.find((item: Json) => item.role === "user" && item.markers.includes(original))?.id,
            storedStatus: store.get(identity)?.messages.find(message => message.messageId === custodyMessageId)?.status ?? "absent" });
          yield { type: "error", code: failure.code ?? "continuity_unverified", status: 409, errorType: "invalid_request_error", retryable: false,
            message: name === "capacity" ? "This input was not accepted: task input capacity is full." : "Input acceptance is unknown. Query or retry the original message ID." };
          return;
        }
      }
      // A native repeat that generated a different message ID is a new message.
      // Never alias it to the original ID by matching text in this fixture.
      if ((name === "capacity" || name === "unknown") && !receiveFailurePhase) evidence.explicitNewTurnTransportOnly = true;
      if (name === "cancel" && number === 1) store.receive(identity, [nativeOriginalByRequest.get(number)!]);
      if (name === "waiting") {
        yield { type: "text_delta", text: "PROBE_WAITING", phase: "commentary" };
        await delay(200); yield { type: "heartbeat" }; await delay(200); yield { type: "heartbeat" }; await delay(200);
      }
      if ((name === "steer" || name === "cancel") && number === 1) {
        yield { type: "text_delta", text: "PROBE_HELD_COMMENTARY", phase: "commentary" };
        await held;
        if (stopped) return;
        yield { type: "text_delta", text: "PROBE_FIRST_RESPONSE_FINAL", phase: "final_answer" };
      }
      for (const event of normalEvents()) yield event;
    }
    streamOpen = true; seenFirst();
    try {
      for await (const event of sequence()) {
        if (stopped) return;
        evidence.adapterEvents.push({ atMs: at(), request: number, type: event.type,
          ...(event.type === "text_delta" ? { phase: event.phase, markers: markers(event.text) } : {}) });
        yield event;
      }
    } finally { streamOpen = false; evidence.wireEvents.push({ atMs: at(), request: number, type: "adapter.closed" }); }
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    error(error) {
      evidence.serverErrors ??= [];
      evidence.serverErrors.push({ atMs: at(), expectedTransportCut: name === "reconnect" && error.message === "synthetic loopback connection loss" });
      return new Response("Synthetic local transport ended", { status: 500 });
    },
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
        evidence.otherLocalRequests ??= [];
        evidence.otherLocalRequests.push({ atMs: at(), method: request.method, path: new URL(request.url).pathname });
        return new Response("Only loopback Responses is available", { status: request.method === "POST" ? 404 : 426 });
      }
      const body = await readJsonRequestBody(request) as Json;
      if (request.headers.get("x-local-probe") === "json-companion") return Response.json(buildResponseJSON(normalEvents(), template.slug));
      const number = ++requestCount;
      if (number > 16) return new Response("Synthetic request bound exceeded", { status: 400 });
      const originalItem = (body.input ?? []).filter((item: Json) => item.role === "user" && markers(textOf(item)).includes(original)).at(-1);
      if (!originalItem || typeof originalItem.id !== "string" || digest(textOf(originalItem)) !== digest(original)) throw new Error("Native provider input does not retain the exact synthetic original.");
      nativeOriginalByRequest.set(number, { messageId: originalItem.id, text: textOf(originalItem) });
      const input = (body.input ?? []).filter((item: Json) => markers(textOf(item)).length).map((item: Json) => {
        const turn = item.internal_chat_message_metadata_passthrough?.turn_id;
        return { ...itemSummary(item), turnId: turn, contentItemKinds: item.internal_chat_message_metadata_passthrough?.content_item_kinds,
          clientUserMessageId: item.client_user_message_id,
          trustedUserSource: typeof turn === "string" && !!trustedChatGptTaskUpdateUserText(item, turn) };
      });
      if (number === 1) custodyMessageId = input.find((item: Json) => item.role === "user" && item.markers.includes(original))?.id ?? "";
      evidence.requests.push({ number, atMs: at(), stream: body.stream, firstResponseStillOpen: streamOpen,
        contentEncoding: request.headers.get("content-encoding") ?? "identity", originalBodyDigest: digest(textOf(originalItem)),
        input, nativeToolCalls: (body.input ?? []).filter((item: Json) => /(?:function|custom)_tool_call|function_call/.test(item.type)).length,
        requestKeys: Object.keys(body), metadataKeys: Object.keys(body.client_metadata ?? {}) });
      request.signal.addEventListener("abort", () => evidence.wireEvents.push({ atMs: at(), request: number, type: "request.aborted" }), { once: true });
      const source = bridgeToResponsesSSE(adapterEvents(number), template.slug, undefined, undefined, undefined,
        () => evidence.wireEvents.push({ atMs: at(), request: number, type: "bridge.cancelled" }), 100,
        { onCompletedResponse: response => { completedResponse = response; }, stallTimeoutSec: 20 });
      // Observe the actual product bytes. The reconnect fixture cuts the transport;
      // it does not synthesize Responses events or pretend an adapter completed.
      let cut = false;
      const observed = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          wire(chunk, number); controller.enqueue(chunk);
          if (["reconnect", "unknown-reconnect"].includes(name) && number === 1 && !cut && new TextDecoder().decode(chunk).includes("response.output_text.delta")) {
            cut = true; evidence.wireEvents.push({ atMs: at(), request: number, type: "synthetic.transport.cut" });
            // Close before a Responses terminal, as a truncated transport would.
            // This tests the real client's stream retry without an intentional server exception.
            controller.terminate();
          }
        },
      }));
      return new Response(observed, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  function send(value: Json): void { child!.stdin!.write(JSON.stringify(value) + "\n"); child!.stdin!.flush(); }
  async function rpc(method: string, params: Json): Promise<any> {
    const id = nextRpc++;
    evidence.rpc.push({ atMs: at(), method, clientUserMessageId: params.clientUserMessageId, firstResponseStillOpen: streamOpen });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 8_000);
        pending.set(id, { resolve, reject }); send({ id, method, params });
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  async function waitTurn(after = 0): Promise<Json> {
    while (!stopped) {
      const completed = notifications.slice(after).find(value => value.method === "turn/completed");
      if (completed) return completed.params.turn;
      await delay(20);
    }
    throw new Error("Scenario stopped before a real client terminal.");
  }
  function rollout(): Json[] {
    if (!rolloutPath || !realpathSync(rolloutPath).startsWith(probeRoot + "/")) throw new Error("Rollout path is outside isolated state.");
    return readFileSync(rolloutPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  function controlRead(): Json { return taskInputControl(storage, { action: "read", identity, messageId: custodyMessageId }); }
  const exercise = async () => {
    if (authRoute === "chatgpt") {
      // Mirror the supported native route's fixture mechanism. These tokens are
      // synthetic and every provider URL in the isolated config is loopback.
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const accountId = "00000000-0000-4000-8000-000000000001";
      writeFileSync(join(configuration, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
        tokens: { id_token: `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "input-probe@example.invalid",
          "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: "local-fixture", chatgpt_account_id: accountId } })}.c2ln`,
          access_token: "local-fixture-not-a-credential", refresh_token: "local-fixture-no-refresh", account_id: accountId },
        last_refresh: new Date().toISOString() }), { mode: 0o600 });
    }
    writeFileSync(join(configuration, "config.toml"), [
      `model = ${JSON.stringify(template.slug)}`, `model_provider = "${authRoute === "chatgpt" ? "openai" : "product_bridge_probe"}"`,
      `model_catalog_json = ${JSON.stringify(join(configuration, "models.json"))}`,
      `chatgpt_base_url = "http://127.0.0.1:${server.port}/backend-api"`,
      'approval_policy = "never"', 'check_for_update_on_startup = false',
      ...(authRoute === "chatgpt" ? [`openai_base_url = "http://127.0.0.1:${server.port}/v1"`] : [
      '[model_providers.product_bridge_probe]', 'name = "Deterministic local product bridge probe"',
      `base_url = "http://127.0.0.1:${server.port}/v1"`, 'env_key = "CGW_LOCAL_PROBE_KEY"',
      'wire_api = "responses"', 'supports_websockets = false', 'request_max_retries = 0',
      `stream_max_retries = ${["reconnect", "unknown-reconnect", "capacity-retry"].includes(name) ? 1 : 0}`, 'stream_idle_timeout_ms = 10000']),
      '[features]', 'multi_agent = false', '[analytics]', 'enabled = false',
    ].join("\n"));
    const loopbackProxy = `http://127.0.0.1:${server.port}`;
    child = Bun.spawn([codex, "app-server", "--strict-config"], { cwd: workspace,
      env: { ...isolatedEnvironment(configuration), HTTP_PROXY: loopbackProxy, HTTPS_PROXY: loopbackProxy, ALL_PROXY: loopbackProxy,
        NO_PROXY: "127.0.0.1,localhost,::1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    stderr = new Response(child.stderr).text();
    readLoop = (async () => {
      let buffer = ""; const decoder = new TextDecoder();
      for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (typeof value.id === "number") {
            const waiter = pending.get(value.id); value.error ? waiter?.reject(new Error(JSON.stringify(value.error))) : waiter?.resolve(value.result);
          } else if (value.id !== undefined) {
            evidence.unexpectedServerRequest = value.method;
            send({ id: value.id, error: { code: -32601, message: "Tools and server-side requests are not authorized in this probe" } });
          } else {
            notifications.push(value); const params = value.params ?? {};
            if (value.method.startsWith("codex/event/")) continue;
            evidence.clientEvents.push({ atMs: at(), method: value.method,
              ...(["item/started", "item/completed"].includes(value.method) ? { item: itemSummary(params.item ?? {}) } : {}),
              ...(value.method === "turn/completed" ? { status: params.turn.status, errorCode: params.turn.error?.codexErrorInfo } : {}),
              ...(value.method === "error" ? { willRetry: params.willRetry, errorCode: params.error?.codexErrorInfo } : {}) });
          }
        }
      }
      for (const waiter of pending.values()) waiter.reject(new Error("Isolated app-server exited"));
    })();
    await rpc("initialize", { clientInfo: { name: "product-input-probe", version: "1" }, capabilities: { experimentalApi: true } }); send({ method: "initialized" });
    const started = await rpc("thread/start", { cwd: workspace, model: template.slug, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: "Synthetic local protocol test. Never use tools.", developerInstructions: "Return only the synthetic provider output. No tools." });
    threadId = started.thread.id; rolloutPath = started.thread.path;
    const initialTurn = await rpc("turn/start", { threadId, clientUserMessageId: messageId, input: [{ type: "text", text: original, text_elements: [] }] });
    if (name === "steer") {
      await firstSeen; await delay(150);
      const result = await rpc("turn/steer", { threadId, expectedTurnId: initialTurn.turn.id, clientUserMessageId: steerId,
        input: [{ type: "text", text: "PROBE_STEER_ADDITION", text_elements: [] }] });
      evidence.steerResultKeys = Object.keys(result); evidence.requestCountWhenSteerReturned = requestCount;
      await delay(200); evidence.requestCountBeforeFirstReleased = requestCount; releaseFirst();
    }
    if (name === "cancel") { await firstSeen; await delay(150); await rpc("turn/interrupt", { threadId, turnId: initialTurn.turn.id }); releaseFirst(); }
    const firstTerminal = await waitTurn(); evidence.firstTurn = { status: firstTerminal.status, errorCode: firstTerminal.error?.codexErrorInfo };
    if (name === "capacity" || name === "unknown") {
      receiveFailurePhase = false;
      evidence.requestsBeforeExplicitNewTurn = requestCount;
      // Read original user text from actual native rollout; no manual retyping.
      let nativeMessage: Json | undefined;
      for (let i = 0; i < 25 && !nativeMessage; i++) {
        nativeMessage = rollout().filter(value => value.type === "response_item").map(value => value.payload)
          .find(item => item.role === "user" && markers(textOf(item)).includes(original));
        if (!nativeMessage) await delay(20);
      }
      if (!nativeMessage) throw new Error("Native rollout does not retain the original user input.");
      const readThread = await rpc("thread/read", { threadId, includeTurns: true });
      const publicUser = (readThread.thread?.turns ?? []).flatMap((turn: Json) => turn.items ?? [])
        .find((item: Json) => item.type === "userMessage" && markers(textOf(item)).includes(original));
      const recovered = publicUser ? textOf(publicUser) : textOf(nativeMessage);
      if (digest(recovered) !== digest(original)) throw new Error("Native rollout changed the original user text.");
      evidence.recoveredText = recovered; // synthetic only; removed from saved evidence below
      evidence.recovery = { originalFromRollout: true, bodyDigest: digest(recovered), rolloutMessageId: nativeMessage.id,
        serviceMessageId: custodyMessageId, requestedClientMessageId: messageId, controlReadBeforeRetry: controlRead().ok,
        senderThreadRead: { originalReadable: !!publicUser, itemId: publicUser?.id, originalDigestMatches: !!publicUser && digest(textOf(publicUser)) === digest(original) },
        serviceRecordBeforeRetry: store.get(identity)?.messages.find(message => message.messageId === custodyMessageId)?.status ?? "absent" };
      if (name === "capacity") {
        for (const message of store.list(identity)) store.discard(identity, message.messageId);
        store.cleanup(identity);
      }
      const before = notifications.length;
      try {
        await rpc("turn/start", { threadId, clientUserMessageId: messageId, input: [{ type: "text", text: recovered, text_elements: [] }] });
        const retried = await waitTurn(before); evidence.retryTurn = { status: retried.status, errorCode: retried.error?.codexErrorInfo };
      } catch (error) { evidence.limitations.push("Native same-clientUserMessageId retry failed: " + String(error).slice(0, 400)); }
      const retryInput = evidence.requests[evidence.requestsBeforeExplicitNewTurn]?.input.filter((item: Json) => item.role === "user" && item.markers.includes(original)) ?? [];
      const currentNativeId = retryInput.at(-1)?.id;
      evidence.recovery.nativeRetryCurrentMessageId = currentNativeId;
      evidence.recovery.nativeRetryPreservedOriginalMessageId = currentNativeId === custodyMessageId;
      if (currentNativeId !== custodyMessageId) evidence.limitations.push("An explicit second turn/start created a new provider message ID despite the repeated clientUserMessageId. This is a new-turn observation, not evidence about automatic Responses retry.");
      // Explicit recovery uses the real retained rollout ID and its exact body.
      // The control repair path accepts only existing reservations. A definite
      // rejection needs the internal receive API; do not claim a public retry UI.
      const beforeRecovery = store.get(identity)!;
      const originalIdRepair = taskInputControl(storage, { action: "repair", identity, messageId: custodyMessageId, text: recovered,
        expectedVersion: beforeRecovery.version, expectedIntentGeneration: beforeRecovery.intentGeneration });
      evidence.recovery.originalIDControlRetry = { ok: originalIdRepair.ok, code: originalIdRepair.code };
      if (name === "capacity") {
        if (originalIdRepair.ok) throw new Error("Control repair unexpectedly admitted a previously unreceived identity.");
        evidence.limitations.push("A definitely unreceived message cannot enter through control repair. Its original-ID receive retry is demonstrated only through the internal custody API; native resubmission created a new ID.");
        store.receive(identity, [{ messageId: custodyMessageId, text: recovered }]);
        evidence.recovery.explicitOriginalIDRetryPath = "internal-store.receive";
      } else {
        if (!originalIdRepair.ok) throw new Error("Product control could not repair the original uncertain reservation.");
        evidence.recovery.explicitOriginalIDRetryPath = "task-input-control.repair";
      }
      const target = store.get(identity)?.messages.filter(message => message.messageId === custodyMessageId) ?? [];
      evidence.recovery.serviceCopiesAfterExplicitOriginalIDRetry = target.length;
      evidence.recovery.controlReadAfterExplicitOriginalIDRetry = controlRead().ok;
      if (target.length === 1) {
        const priorS = target[0]!.receivedSequence;
        // Damage only this fixture's retained file, then use the real product control
        // to detect, repair from the saved native text, and copy it again.
        const payload = join(storage, "task-input-payloads");
        for (const file of readdirSync(payload)) rmSync(join(payload, file));
        const missing = taskInputControl(storage, { action: "snapshot" });
        const missingValue = missing.value as Json | undefined;
        const missingTask = (missingValue?.tasks ?? []).find((task: Json) => task.taskId === identity.taskId);
        const missingDetected = !!missing.ok && missingTask?.messages.some((message: Json) => message.messageId === custodyMessageId && message.payload === "missing");
        const current = store.get(identity)!;
        const repair = taskInputControl(storage, { action: "repair", identity, messageId: custodyMessageId, text: recovered,
          expectedVersion: current.version, expectedIntentGeneration: current.intentGeneration });
        const read = controlRead();
        evidence.recovery.productControl = { missingDetected,
          repairSucceeded: repair.ok, readable: read.ok, originalDigestMatches: read.ok && digest(read.value.text) === digest(recovered),
          sequencePreserved: store.get(identity)!.messages.find(message => message.messageId === custodyMessageId)?.receivedSequence === priorS };
      }
      delete evidence.recoveredText;
    }
    if (name === "boundaries") {
      const json = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-local-probe": "json-companion" }, body: JSON.stringify({ stream: false, input: [] }) }).then(response => response.json()) as Json;
      evidence.sseShape = completedResponse && outputShape(completedResponse); evidence.jsonShape = outputShape(json);
      evidence.checks.sameJSONAndSSEOutput = JSON.stringify(evidence.sseShape) === JSON.stringify(evidence.jsonShape);
    }
    evidence.history = rollout().filter(value => value.type === "response_item").map(value => value.payload)
      .filter(item => ["assistant", "user"].includes(item.role) && markers(textOf(item)).length).map(itemSummary);
    const assistant = evidence.clientEvents.filter((event: Json) => event.method === "item/completed" && event.item?.type === "agentMessage").map((event: Json) => event.item);
    evidence.actualAssistant = assistant;
    evidence.checks.noTools = !evidence.unexpectedServerRequest && !evidence.requests.some((request: Json) => request.nativeToolCalls)
      && !evidence.clientEvents.some((event: Json) => ["commandExecution", "mcpToolCall", "fileChange"].includes(event.item?.type));
    evidence.checks.originalInNativeHistory = evidence.history.some((item: Json) => item.role === "user" && item.markers.includes(original));
    evidence.checks.nativePerItemUserProvenance = evidence.requests.every((request: Json) => request.input
      .filter((item: Json) => item.role === "user").every((item: Json) => item.trustedUserSource));
    if (name === "waiting") Object.assign(evidence.checks, {
      completed: firstTerminal.status === "completed", commentaryVisible: assistant.some((item: Json) => item.phase === "commentary" && item.markers.includes("PROBE_WAITING")),
      heartbeatObserved: evidence.wireEvents.some((event: Json) => event.type === "response.heartbeat"),
      noFailedTerminal: !evidence.wireEvents.some((event: Json) => ["response.failed", "response.incomplete"].includes(event.type)),
    });
    if (name === "boundaries") Object.assign(evidence.checks, {
      completed: firstTerminal.status === "completed", twoAssistantItemsVisible: assistant.some((item: Json) => item.markers.includes("PROBE_FIRST_PHYSICAL")) && assistant.some((item: Json) => item.markers.includes("PROBE_SECOND_PHYSICAL")),
      oneTerminal: evidence.wireEvents.filter((event: Json) => event.type === "response.completed").length === 1,
    });
    if (name === "steer") Object.assign(evidence.checks, {
      steerWhileOpen: evidence.rpc.some((entry: Json) => entry.method === "turn/steer" && entry.firstResponseStillOpen),
      laterRequestContainsSteer: evidence.requests.slice(1).some((request: Json) => request.input.some((item: Json) => item.markers.includes("PROBE_STEER_ADDITION"))),
      originalFinalVisible: assistant.some((item: Json) => item.markers.includes("PROBE_FIRST_RESPONSE_FINAL")),
      clientSteerIDOnWire: evidence.requests.some((request: Json) => request.input.some((item: Json) => item.id === steerId)),
    });
    if (name === "steer" && !evidence.checks.originalFinalVisible) evidence.limitations.push("Steering cancelled the first provider transport; its later final text did not enter native output. This is not a lossless observer handoff.");
    if (name === "capacity" || name === "unknown") Object.assign(evidence.checks, {
      nativeFailureVisible: firstTerminal.status === "failed", originalRecoverable: !!evidence.recovery.originalFromRollout,
      originalReadableFromThreadRead: !!evidence.recovery.senderThreadRead.originalReadable && !!evidence.recovery.senderThreadRead.originalDigestMatches,
      automaticErrorRetriesKeepOriginalID: evidence.receiveFailures.every((attempt: Json) => attempt.messageId === custodyMessageId),
      nativeRepeatTransportCompleted: evidence.retryTurn?.status === "completed", oneServiceCopyAfterExplicitOriginalIDRetry: evidence.recovery.serviceCopiesAfterExplicitOriginalIDRetry === 1,
      nativeRepeatPreservesMessageIdentity: evidence.recovery.nativeRetryPreservedOriginalMessageId,
      originalIDRetainedInProviderHistory: evidence.requests.slice(1).some((request: Json) => request.input.some((item: Json) => item.id === custodyMessageId)),
      controlRepairFromOriginal: !!evidence.recovery.productControl?.repairSucceeded && !!evidence.recovery.productControl?.originalDigestMatches,
    });
    if (name === "reconnect" || name === "unknown-reconnect") Object.assign(evidence.checks, { transportCutObserved: evidence.wireEvents.some((event: Json) => event.type === "synthetic.transport.cut"),
      retriedRequestObserved: requestCount > 1, completedAfterReconnect: firstTerminal.status === "completed",
      originalMessageIDPreservedOnTransportRetry: evidence.requests[0]?.input[0]?.id === evidence.requests[1]?.input[0]?.id,
      automaticRetryOneServiceCopy: evidence.receipts?.length === 2 && evidence.receipts.every((receipt: Json) => receipt.copies === 1 && receipt.receivedSequence === 1),
      automaticRetryOriginalBodyReadable: controlRead().ok && digest(controlRead().value.text) === digest(original),
      automaticRetrySettledAccepted: store.get(identity)?.messages.find(message => message.messageId === custodyMessageId)?.status === "accepted" });
    if (name === "capacity-retry") Object.assign(evidence.checks, {
      capacityRejectionObserved: evidence.receiveFailure?.code === "continuity_resource_capacity" && evidence.originalAbsentAfterRejection,
      automaticRetryObserved: requestCount === 2 && evidence.clientEvents.some((event: Json) => event.method === "error" && event.willRetry),
      originalMessageIDPreservedOnRetry: evidence.requests[0]?.input[0]?.id === evidence.requests[1]?.input[0]?.id,
      originalAcceptedExactlyOnce: evidence.receipts?.length === 1 && evidence.receipts[0].messageId === custodyMessageId
        && evidence.receipts[0].copies === 1 && evidence.receipts[0].receivedSequence === 129,
      originalBodyReadable: controlRead().ok && digest(controlRead().value.text) === digest(original),
      completedAfterRetry: firstTerminal.status === "completed",
    });
    if (name === "cancel") Object.assign(evidence.checks, { interruptedClient: firstTerminal.status === "interrupted", inputRetained: controlRead().ok,
      noNewRequestAfterCancel: requestCount === 1, originalTaskRemainsRecoverable: store.get(identity)?.state === "active" });
    if (!evidence.checks.nativePerItemUserProvenance) evidence.limitations.push("This provider route omitted trusted per-item user provenance. It cannot establish the full native adapter source-authority contract.");
    const specific: Record<Scenario, string[]> = {
      waiting: ["completed", "commentaryVisible", "heartbeatObserved", "noFailedTerminal"],
      boundaries: ["completed", "twoAssistantItemsVisible", "oneTerminal", "sameJSONAndSSEOutput"],
      steer: ["steerWhileOpen", "laterRequestContainsSteer"],
      capacity: ["nativeFailureVisible", "originalRecoverable", "originalReadableFromThreadRead", "automaticErrorRetriesKeepOriginalID", "oneServiceCopyAfterExplicitOriginalIDRetry", "controlRepairFromOriginal"],
      "capacity-retry": ["capacityRejectionObserved", "automaticRetryObserved", "originalMessageIDPreservedOnRetry", "originalAcceptedExactlyOnce", "originalBodyReadable", "completedAfterRetry"],
      unknown: ["nativeFailureVisible", "originalRecoverable", "originalReadableFromThreadRead", "automaticErrorRetriesKeepOriginalID", "oneServiceCopyAfterExplicitOriginalIDRetry", "controlRepairFromOriginal"],
      reconnect: ["transportCutObserved", "retriedRequestObserved", "completedAfterReconnect", "originalMessageIDPreservedOnTransportRetry", "automaticRetryOneServiceCopy", "automaticRetryOriginalBodyReadable", "automaticRetrySettledAccepted"],
      "unknown-reconnect": ["transportCutObserved", "retriedRequestObserved", "completedAfterReconnect", "originalMessageIDPreservedOnTransportRetry", "automaticRetryOneServiceCopy", "automaticRetryOriginalBodyReadable", "automaticRetrySettledAccepted"],
      cancel: ["interruptedClient", "inputRetained", "noNewRequestAfterCancel", "originalTaskRemainsRecoverable"],
    };
    evidence.requiredChecks = ["noTools", "originalInNativeHistory", ...(authRoute === "chatgpt" ? ["nativePerItemUserProvenance"] : []), ...specific[name]];
    const failed = evidence.requiredChecks.filter((check: string) => evidence.checks[check] !== true);
    if (failed.length) throw new Error("Product transport/custody checks failed: " + failed.join(", "));
    evidence.status = "observed";
  };
  try {
    await Promise.race([exercise(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Scenario exceeded 30000ms")), timeoutMs); })]);
  } catch (error) { evidence.status = "probe-failed"; evidence.failure = String(error).replaceAll(probeRoot, "<temporary-state>").slice(0, 1500); }
  finally {
    clearTimeout(timeout); stopped = true; releaseFirst(); delete evidence.recoveredText;
    for (const waiter of pending.values()) waiter.reject(new Error("Scenario ended")); pending.clear();
    if (child) { child.kill(); await child.exited; await readLoop; evidence.child = { exitCode: child.exitCode, signalCode: child.signalCode,
      stderrLineCount: (await stderr ?? "").split("\n").filter(Boolean).length }; }
    await server.stop(true); evidence.durationMs = at();
    evidence.cleanup = { childStopped: true, serverStopped: true };
    writeFileSync(join(output, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 }); save();
    console.log(JSON.stringify({ scenario: name, status: evidence.status, requests: requestCount, turn: evidence.firstTurn?.status, checks: evidence.checks, failure: evidence.failure }));
  }
}

try {
  const version = spawnSync(codex, ["--version"], { cwd: bootstrap, env: isolatedEnvironment(bootstrap), encoding: "utf8", timeout: 10_000 });
  report.codexVersion = version.stdout.trim(); report.codexBinarySha256 = createHash("sha256").update(readFileSync(codex)).digest("hex");
  if (report.codexVersion !== "codex-cli 0.163.0") throw new Error("This acceptance probe requires installed codex-cli 0.163.0.");
  report.head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", timeout: 5_000 }).stdout.trim();
  report.productSourceDigests = Object.fromEntries(["src/bridge.ts", "src/task-input-control.ts", "src/adapters/chatgpt-web/continuity-task-input-store.ts"].map(path => [path, digest(readFileSync(join(repository, path), "utf8"))]));
  report.probeSourceSha256 = digest(readFileSync(import.meta.path, "utf8"));
  const schema = join(bootstrap, "schema");
  const generated = spawnSync(codex, ["app-server", "generate-ts", "--experimental", "--out", schema], { cwd: bootstrap, env: isolatedEnvironment(bootstrap), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (generated.status !== 0) throw new Error("Installed Codex protocol generation failed.");
  report.installedProtocol = Object.fromEntries(["TurnStartParams", "TurnSteerParams"].map(name => {
    const text = readFileSync(join(schema, "v2", `${name}.ts`), "utf8");
    return [name, { sha256: digest(text), clientUserMessageId: text.includes("clientUserMessageId?: string") }];
  }));
  const catalog = spawnSync(codex, ["debug", "models", "--bundled"], { cwd: bootstrap, env: isolatedEnvironment(bootstrap), encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (catalog.status !== 0) throw new Error("Installed bundled model catalog is unavailable.");
  const nativeCatalog = JSON.parse(catalog.stdout);
  const productConfig = defaultConfig("full");
  productConfig.toolAuthorityMode = "delegated"; productConfig.browserHost = "launcher";
  productConfig.browserHostDescriptorPath = join(probeRoot, "synthetic-launcher.json");
  const routedCatalog = authRoute === "chatgpt" ? augmentNativeModelCatalog(nativeCatalog, productConfig) : nativeCatalog;
  const template = (routedCatalog.models as Json[]).find((model: Json) => model.slug === (authRoute === "chatgpt" ? "chatgpt-web/gpt-5.6-sol" : "gpt-5.6-sol"));
  if (!template) throw new Error("Installed Codex has no bundled gpt-5.6-sol template.");
  report.modelTemplateSha256 = digest(JSON.stringify(template));
  for (const name of ["waiting", "boundaries", "steer", "capacity", "capacity-retry", "unknown", "reconnect", "unknown-reconnect", "cancel"] as Scenario[]) await run(name, template);
} catch (error) { report.failure = String(error).replaceAll(probeRoot, "<temporary-state>").slice(0, 1500); process.exitCode = 1; }
finally {
  report.productSourceDigestsAfter = Object.fromEntries(Object.keys(report.productSourceDigests ?? {}).map(path => [path, digest(readFileSync(join(repository, path), "utf8"))]));
  report.productSourcesChangedDuringRun = JSON.stringify(report.productSourceDigests) !== JSON.stringify(report.productSourceDigestsAfter);
  rmSync(probeRoot, { recursive: true, force: true }); report.temporaryStateRemoved = true; save();
}
if (report.scenarios.some((scenario: Json) => scenario.status === "probe-failed")) process.exitCode = 1;
console.log(`证据：${output}`);
