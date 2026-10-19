/**
 * Explicit native-client integration probe, outside the normal tests directory.
 * Run: bun test scripts/probe-continuity-input-adapter.test.ts
 * Optional: CGW_INPUT_ADAPTER_CODEX=/absolute/codex
 *           CGW_INPUT_ADAPTER_EVIDENCE_DIR=/new/empty/directory
 * The real product parser, adapter, queue, observers and Responses bridge run.
 * Only the browser/Launcher boundary uses the existing deterministic test fixture.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultConfig, type AppConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { readJsonRequestBody } from "../src/http-body";
import { responseRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";
import { trustedChatGptTaskUpdateUserText } from "../src/adapters/chatgpt-web/environment";
import { taskInputQueue } from "../src/adapters/chatgpt-web/continuity-task-input-runtime";
import { chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { createSessionContinuityFixtures } from "../tests/helpers/session-continuity-fixture";

type Json = Record<string, any>;
const repository = resolve(import.meta.dir, "..");
const limitMs = 30_000;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const textOf = (item: Json): string => typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content
  : (item.content ?? []).map((part: Json) => part.text ?? "").join("\n");
const markers = (text: string): string[] => text.match(/PROBE_[A-Z_]+/g) ?? [];
const itemSummary = (item: Json): Json => ({ id: item.id, type: item.type, role: item.role, phase: item.phase,
  markers: markers(textOf(item)), ...(textOf(item).startsWith("Completed response ") ? { text: textOf(item) } : {}) });
function stateSummary(state: Json | undefined): Json | undefined {
  if (!state) return undefined;
  const { acknowledgementDirectory: _privatePath, ...value } = state; return value;
}
async function until<T>(read: () => T | undefined | false, label: string, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await Bun.sleep(10); }
  throw new Error(`Timed out waiting for ${label}.`);
}

const selectedBinary = process.env.CGW_INPUT_ADAPTER_CODEX ?? Bun.which("codex");
if (!selectedBinary || !isAbsolute(selectedBinary)) throw new Error("An installed absolute Codex path is required.");
const codex = realpathSync(selectedBinary);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-adapter-${process.pid}`;
const output = resolve(process.env.CGW_INPUT_ADAPTER_EVIDENCE_DIR
  ?? join(repository, ".dev-workflows/continuity-input-queue/builds/001/client-evidence", runId));
if (existsSync(output) && readdirSync(output).length) throw new Error("Evidence directory must be new or empty.");
mkdirSync(output, { recursive: true, mode: 0o700 });
// Keep the fixture's nested Unix socket below the platform pathname limit.
const temporary = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-na-")));
const bootstrap = join(temporary, "bootstrap"); mkdirSync(bootstrap);
const userDirectory = join(temporary, "user"); mkdirSync(userDirectory);
const environment = (configuration: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: temporary,
  HOME: userDirectory, CODEX_HOME: configuration, CODEX_SQLITE_HOME: configuration,
});
const productPaths = ["src/server.ts", "src/responses/parser.ts", "src/bridge.ts", "src/adapters/chatgpt-web/index.ts",
  "src/adapters/chatgpt-web/continuity-task-input-runtime.ts", "src/adapters/chatgpt-web/task-input-scheduler.ts",
  "src/adapters/chatgpt-web/continuity-task-input-store.ts", "src/adapters/chatgpt-web/turn-execution.ts",
  "src/adapters/chatgpt-web/turn-broker.ts", "tests/helpers/session-continuity-fixture.ts"];
const sourceDigests = () => Object.fromEntries(productPaths.map(path => [path, sha(readFileSync(join(repository, path)))]));
const report: Json = {
  schema: "codex-chatgpt-web/native-input-adapter-probe/v1", capturedAt: new Date().toISOString(),
  perScenarioTimeoutMs: limitMs, scenarios: [], scope: {
    installedCodex: true, nativeOpenAIRoute: true, responseRequest: true, productParser: true,
    productAdapter: true, productQueue: true, productObserver: true, productResponsesBridge: true,
    deterministicBrowserWorker: true, realLauncher: false, realChatGPT: false, toolsExecuted: 0,
  }, isolation: { temporaryConfiguration: true, syntheticChatGPTAuth: true, allHTTPBaseURLsAndProxies: "loopback" },
  limitations: [
    "The existing session-continuity fixture simulates the browser and Launcher. This is not C03.",
    "Only no-tool Automatic responses are exercised; tool ACK and dispatch races remain separate evidence.",
    "Short controlled waits do not establish long-running browser, UI or restart behavior.",
  ], acceptance: { C01: "representative native queue integration only", C02: "observer detach and physical continuation subset", C03: "not tested" },
};
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let catalog: Json;
const fixtures = createSessionContinuityFixtures(import.meta.path);
afterEach(fixtures.disposeTestFixtures);
beforeAll(() => {
  const version = spawnSync(codex, ["--version"], { cwd: bootstrap, env: environment(bootstrap), encoding: "utf8", timeout: 10_000 });
  report.codexVersion = version.stdout.trim(); report.binarySha256 = sha(readFileSync(codex));
  expect(report.codexVersion).toBe("codex-cli 0.163.0");
  const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { cwd: bootstrap, env: environment(bootstrap), encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  expect(bundled.status).toBe(0); catalog = JSON.parse(bundled.stdout);
  report.head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", timeout: 5_000 }).stdout.trim();
  report.sourceDigests = sourceDigests(); report.probeSha256 = sha(readFileSync(import.meta.path)); save();
});
afterAll(() => {
  report.sourceDigestsAfter = sourceDigests();
  report.productSourcesChangedDuringRun = JSON.stringify(report.sourceDigests) !== JSON.stringify(report.sourceDigestsAfter);
  rmSync(temporary, { recursive: true, force: true }); report.temporaryStateRemoved = true; save();
  console.log(`贯通证据：${output}`);
});

async function probe(reconnect: boolean): Promise<void> {
  const name = reconnect ? "native-steer-reconnect" : "native-steer";
  const evidence: Json = { name, status: "running", requests: [], rpc: [], clientEvents: [], adapterEvents: [], wireEvents: [],
    physical: [], observers: [], otherLocalRequests: [], checks: {} };
  report.scenarios.push(evidence); save();
  const startedAt = Date.now(), at = () => Date.now() - startedAt;
  const configuration = join(temporary, name), workspace = join(configuration, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), "Synthetic local queue probe. Never execute tools.\n");
  const original = "PROBE_NATIVE_QUEUE_ORIGINAL", addition = "PROBE_NATIVE_QUEUE_ADDITION";
  const parsedRequests = new Map<number, CodexParsedRequest>();
  const transportControllers = new Map<number, TransformStreamDefaultController<Uint8Array>>();
  const held = new Map<number, { release: () => void }>();
  let f: ReturnType<typeof fixtures.fixture> | undefined;
  let source: ChatGptTurnSession | undefined, requestCount = 0;
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined, readLoop: Promise<void> | undefined, stderr: Promise<string> | undefined;
  let nextId = 1, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreObserver: (() => void) | undefined;
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  const notifications: Json[] = [];
  const config: AppConfig = { ...defaultConfig("full"), browserHost: "launcher", browserInteractionMode: "automatic", toolAuthorityMode: "delegated" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/v1/responses") {
      evidence.otherLocalRequests.push({ atMs: at(), method: request.method, path });
      return new Response("Local Responses fixture only", { status: request.method === "POST" ? 404 : 426 });
    }
    const number = ++requestCount;
    if (!f || number > 6) return new Response("Fixture request bound exceeded", { status: 400 });
    const body = await readJsonRequestBody(request.clone()) as Json;
    const input = (body.input ?? []).filter((item: Json) => markers(textOf(item)).length).map((item: Json) => {
      const turnId = item.internal_chat_message_metadata_passthrough?.turn_id;
      return { ...itemSummary(item), turnId, contentItemKinds: item.internal_chat_message_metadata_passthrough?.content_item_kinds,
        trustedUserSource: typeof turnId === "string" && !!trustedChatGptTaskUpdateUserText(item, turnId) };
    });
    evidence.requests.push({ number, atMs: at(), input, stream: body.stream, bodyDigest: sha(JSON.stringify(body)),
      contentEncoding: request.headers.get("content-encoding") ?? "identity" });
    request.signal.addEventListener("abort", () => evidence.wireEvents.push({ atMs: at(), request: number, type: "http.aborted" }), { once: true });
    const response = await responseRequest(request, config, provider => {
      // The factory injects the fixture's local provider, exactly where production
      // constructs its adapter. Parsed input and emitted output remain untouched.
      Object.assign(provider, f!.provider);
      const adapter = f!.adapter();
      return { ...adapter, async preflight(parsed, incoming) {
        await adapter.preflight!(parsed, incoming); parsedRequests.set(number, parsed);
        incoming.abortSignal?.addEventListener("abort", () => evidence.wireEvents.push({ atMs: at(), request: number, type: "observer.aborted" }), { once: true });
      } };
    }, { rememberState: false,
      fetchNative: async () => { throw new Error("Native upstream is forbidden in this local probe."); },
      fetchUpstreamProvider: async () => { throw new Error("External upstream is forbidden in this local probe."); },
      onAdapterEvent: event => evidence.adapterEvents.push({ request: number, atMs: at(), type: event.type,
        ...(event.type === "text_delta" ? { text: event.text, phase: event.phase } : {}),
        ...(event.type === "done" ? { endTurn: event.endTurn } : {}),
        ...(event.type === "error" ? { code: event.code } : {}) }),
    });
    evidence.requests.find((entry: Json) => entry.number === number).status = response.status;
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      evidence.httpFailures ??= []; const value = await response.json() as Json;
      evidence.httpFailures.push({ request: number, code: value.error?.code, message: String(value.error?.message ?? "").replaceAll(temporary, "<temporary>").slice(0, 500) });
      return Response.json(value, { status: response.status });
    }
    let buffer = "";
    const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transportControllers.set(number, controller); buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (!data || data === "[DONE]") continue;
          const value = JSON.parse(data);
          evidence.wireEvents.push({ atMs: at(), request: number, type: value.type,
            ...(value.item ? { item: itemSummary(value.item) } : {}),
            ...(value.type === "response.completed" ? { status: value.response.status,
              output: (value.response.output ?? []).map(itemSummary) } : {}) });
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(observed, { status: response.status, headers: response.headers });
  } });
  function send(value: Json): void { child!.stdin.write(JSON.stringify(value) + "\n"); child!.stdin.flush(); }
  async function rpc(method: string, params: Json): Promise<Json> {
    const id = nextId++; evidence.rpc.push({ atMs: at(), method, clientUserMessageId: params.clientUserMessageId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 8_000);
      pending.set(id, { resolve, reject }); send({ id, method, params });
    }); } finally { clearTimeout(timer); pending.delete(id); }
  }
  const exercise = async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const accountId = "00000000-0000-4000-8000-000000000001";
    writeFileSync(join(configuration, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { id_token: `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "queue-probe@example.invalid",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: "local-fixture", chatgpt_account_id: accountId } })}.c2ln`,
        access_token: "local-fixture-not-a-credential", refresh_token: "local-fixture-no-refresh", account_id: accountId },
      last_refresh: new Date().toISOString() }), { mode: 0o600 });
    const model = "chatgpt-web/gpt-5.6-sol";
    writeFileSync(join(configuration, "models.json"), JSON.stringify(augmentNativeModelCatalog(catalog, config)));
    writeFileSync(join(configuration, "config.toml"), [
      `model = ${JSON.stringify(model)}`, 'model_provider = "openai"',
      `model_catalog_json = ${JSON.stringify(join(configuration, "models.json"))}`,
      `openai_base_url = "http://127.0.0.1:${server.port}/v1"`, `chatgpt_base_url = "http://127.0.0.1:${server.port}/backend-api"`,
      'approval_policy = "never"', 'check_for_update_on_startup = false', '[features]', 'multi_agent = false', '[analytics]', 'enabled = false',
    ].join("\n"));
    const proxy = `http://127.0.0.1:${server.port}`;
    child = Bun.spawn([codex, "app-server", "--strict-config"], { cwd: workspace,
      env: { ...environment(configuration), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "127.0.0.1,localhost,::1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    stderr = new Response(child.stderr).text();
    readLoop = (async () => {
      let buffer = ""; const decoder = new TextDecoder();
      for await (const chunk of child!.stdout) {
        buffer += decoder.decode(chunk, { stream: true }); let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (typeof value.id === "number") {
            const target = pending.get(value.id); value.error ? target?.reject(new Error(JSON.stringify(value.error))) : target?.resolve(value.result);
          } else if (value.id !== undefined) {
            evidence.unexpectedServerRequest = value.method;
            send({ id: value.id, error: { code: -32601, message: "Tools are forbidden in this local queue probe" } });
          } else {
            notifications.push(value); if (value.method.startsWith("codex/event/")) continue;
            evidence.clientEvents.push({ atMs: at(), method: value.method,
              ...(["item/started", "item/completed"].includes(value.method) ? { item: itemSummary(value.params?.item ?? {}) } : {}),
              ...(value.method === "turn/completed" ? { status: value.params.turn.status } : {}),
              ...(value.method === "error" ? { willRetry: value.params.willRetry } : {}) });
          }
        }
      }
      for (const target of pending.values()) target.reject(new Error("Isolated native app-server exited."));
    })();
    await rpc("initialize", { clientInfo: { name: "native-product-queue-probe", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const thread = await rpc("thread/start", { cwd: workspace, model, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: "Local synthetic test. Never use tools.", developerInstructions: "Return only the local provider output. Never use tools." });
    f = fixtures.fixture(false, { taskUpdates: true, root: join(configuration, "fixture"), codexHome: configuration, threadId: thread.thread.id });
    config.browserHostDescriptorPath = f.descriptorPath; config.brokerSocketPath = f.provider.chatgptWeb!.brokerSocketPath!;
    f.controls.deferCompletion = true; f.controls.emitReviewCommentary = true;
    const implementation = f.automatic.getMockImplementation()!;
    f.automatic.mockImplementation(async turn => {
      const number = evidence.physical.length + 1;
      const entry: Json = { number, traceId: turn.traceId, startedAtMs: at() }; evidence.physical.push(entry);
      turn.abortSignal?.addEventListener("abort", () => { entry.abortedAtMs = at(); }, { once: true });
      try { const answer = await implementation(turn); entry.answer = answer; entry.finishedAtMs = at(); return answer; }
      catch (error) { entry.failure = String(error).replaceAll(temporary, "<temporary>").slice(0, 500); throw error; }
    });
    f.controls.onStarted = () => {
      const number = f!.submissions.length, turn = f!.automatic.mock.calls[number - 1]![0];
      held.set(number, { release: f!.controls.releaseDeferredCompletion! });
      evidence.physical[number - 1].readyAtMs = at();
      evidence.physical[number - 1].taskUpdateState = stateSummary(f!.broker.taskUpdateState(f!.submissions[number - 1]!.turnToken!));
      evidence.physical[number - 1].promptDigest = sha(f!.submissions[number - 1]!.prompt);
      evidence.physical[number - 1].promptContainsAddition = f!.submissions[number - 1]!.prompt.includes(addition);
      evidence.physical[number - 1].reusedPage = f!.submissions[number - 1]!.reused;
      if (number === 2) evidence.firstSettledBeforeSecond = source?.isPhysicallySettled();
      evidence.physical[number - 1].abortSignalAbortedAtReady = turn.abortSignal?.aborted;
    };
    const initial = await rpc("turn/start", { threadId: thread.thread.id, clientUserMessageId: "probe-native-initial",
      input: [{ type: "text", text: original, text_elements: [] }] });
    await until(() => held.get(1), "first physical response");
    const firstParsed = parsedRequests.get(1)!;
    source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(firstParsed)}`);
    if (!source) throw new Error("The real adapter did not retain its physical session.");
    const queue = taskInputQueue(source); if (!queue) throw new Error("The real adapter has no durable input queue.");
    await until(() => evidence.wireEvents.some((entry: Json) => entry.request === 1 && entry.type === "response.output_text.delta"), "first commentary bytes");
    const attachObserver = source.attachToolObserver.bind(source);
    const observer = spyOn(source, "attachToolObserver").mockImplementation(() => {
      const current = attachObserver();
      const entry: Json = { generation: current.generation, attachedAtMs: at() }; evidence.observers.push(entry);
      return { generation: current.generation, detach: () => { entry.detachedAtMs = at(); current.detach(); } };
    });
    restoreObserver = () => observer.mockRestore();
    evidence.steerSentWhileFirstHeld = !evidence.physical[0].finishedAtMs;
    await rpc("turn/steer", { threadId: thread.thread.id, expectedTurnId: initial.turn.id, clientUserMessageId: "probe-native-addition",
      input: [{ type: "text", text: addition, text_elements: [] }] });
    const received = await until(() => { const task = queue.store.get(queue.identity); return task?.messages.length ? task : undefined; }, "real queue receipt");
    evidence.receipt = structuredClone(received);
    await until(() => evidence.wireEvents.some((entry: Json) => entry.request === 1 && ["http.aborted", "observer.aborted"].includes(entry.type)), "old HTTP observer detach");
    await until(() => evidence.observers.length && source!.isCurrentToolObserver(evidence.observers.at(-1).generation), "steered current observer");
    evidence.ownerAfterOldHTTPDetached = { active: source.isActive(), physicalSettled: source.isPhysicallySettled(),
      physicalAbortSignalAborted: f.automatic.mock.calls[0]![0].abortSignal?.aborted, physicalCount: f.submissions.length,
      taskUpdateState: stateSummary(f.broker.taskUpdateState(f.submissions[0]!.turnToken!)) };
    if (reconnect) {
      const controller = await until(() => transportControllers.get(2), "current HTTP stream");
      evidence.wireEvents.push({ atMs: at(), request: 2, type: "synthetic.transport.cut" }); controller.terminate();
      await until(() => parsedRequests.get(3), "native automatic same-ID retry");
      await until(() => evidence.observers.length === 2 && source!.isCurrentToolObserver(evidence.observers[1].generation), "reconnected observer");
      evidence.receiptAfterReconnect = queue.store.get(queue.identity);
    }
    evidence.firstReleasedAtMs = at(); held.get(1)!.release();
    await until(() => held.get(2), "queued second physical response");
    evidence.secondPhysicalQueue = queue.store.get(queue.identity);
    evidence.secondPhysicalSends = f.submissions.length;
    held.get(2)!.release();
    const terminal = await until(() => notifications.find(value => value.method === "turn/completed"), "native completed terminal");
    evidence.nativeTerminal = terminal.params.turn.status;
    evidence.finalTask = queue.store.get(queue.identity);
    const currentRequest = reconnect ? 3 : 2;
    const nativeFinal = evidence.clientEvents.filter((entry: Json) => entry.method === "item/completed" && entry.item?.type === "agentMessage" && entry.item.phase === "final_answer");
    const actualOutputs = evidence.wireEvents.filter((entry: Json) => entry.type === "response.output_item.done" && entry.item?.role === "assistant" && entry.item.phase === "final_answer");
    const additions = evidence.requests.flatMap((entry: Json) => entry.input.filter((item: Json) => item.role === "user" && item.markers.includes(addition)));
    const delivery = evidence.finalTask?.deliveries[0];
    evidence.checks = {
      realNativeProvenance: evidence.requests.length >= 2 && evidence.requests.every((entry: Json) => entry.input.filter((item: Json) => item.role === "user").every((item: Json) => item.trustedUserSource)),
      noToolsExecuted: !evidence.unexpectedServerRequest && f.controls.toolResults.length === 0
        && !evidence.adapterEvents.some((entry: Json) => entry.type === "tool_call_start"),
      steerDuringPhysical: evidence.steerSentWhileFirstHeld,
      receivedOnceBeforeBoundary: evidence.receipt.receivedSequence === 1 && evidence.receipt.messages.length === 1 && evidence.receipt.messages[0].status === "accepted" && evidence.receipt.deliveries.length === 0,
      oldHTTPDetachedOwnerContinues: evidence.ownerAfterOldHTTPDetached.active && !evidence.ownerAfterOldHTTPDetached.physicalSettled
        && evidence.ownerAfterOldHTTPDetached.physicalAbortSignalAborted === false && evidence.ownerAfterOldHTTPDetached.physicalCount === 1,
      observerHandoffPreservesM0G0: evidence.ownerAfterOldHTTPDetached.taskUpdateState?.acceptedRevision === 0
        && evidence.ownerAfterOldHTTPDetached.taskUpdateState?.driverGeneration === 0,
      exactlyTwoPhysicalResponses: f.submissions.length === 2 && evidence.physical.length === 2,
      firstSettledBeforeSecond: evidence.firstSettledBeforeSecond === true,
      queuedPromptUsesOriginalBody: evidence.physical[1].promptContainsAddition === true,
      samePageReused: f.submissions[0]!.key === f.submissions[1]!.key && evidence.physical[1].reusedPage === true,
      newPhysicalStartsM0G0: evidence.physical[1].taskUpdateState?.acceptedRevision === 0 && evidence.physical[1].taskUpdateState?.driverGeneration === 0,
      exactInitialDelivery: delivery?.mode === "initial" && delivery.physicalResponseId === evidence.physical[1].traceId
        && delivery.acceptedRevision === 0 && delivery.driverGeneration === 0 && delivery.receivedSequences[0] === 1
        && delivery.messageIds[0] === additions[0]?.id && delivery.completedMessageIds[0] === additions[0]?.id,
      onlyCurrentObserverGetsFinals: actualOutputs.length === 2 && actualOutputs.every((entry: Json) => entry.request === currentRequest),
      bothPhysicalOutputsVisibleToNative: nativeFinal.some((entry: Json) => entry.item.text === "Completed response 1.")
        && nativeFinal.some((entry: Json) => entry.item.text === "Completed response 2."),
      nativeAndTaskCompleted: evidence.nativeTerminal === "completed" && evidence.finalTask?.state === "completed"
        && evidence.finalTask.messages[0]?.status === "completed" && evidence.finalTask.receivedSequence === 1,
      oneGenuineCompletedResponse: evidence.wireEvents.filter((entry: Json) => entry.type === "response.completed").length === 1,
      noFakeIncomplete: !evidence.wireEvents.some((entry: Json) => ["response.incomplete", "response.failed"].includes(entry.type))
        && !evidence.adapterEvents.some((entry: Json) => entry.type === "incomplete"),
      ...(reconnect ? { nativeAutomaticRetrySameMessageID: evidence.requests.length === 3 && additions.length === 2 && additions[0].id === additions[1].id,
        reconnectKeepsOneReceipt: evidence.receiptAfterReconnect?.receivedSequence === 1 && evidence.receiptAfterReconnect.messages.length === 1 } : {}),
    };
    for (const [check, passed] of Object.entries(evidence.checks)) expect(passed, check).toBe(true);
    evidence.status = "passed";
  };
  try {
    await Promise.race([exercise(), new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error("Scenario exceeded 30000ms.")), limitMs); })]);
  } catch (error) { evidence.status = "failed"; evidence.failure = String(error).replaceAll(temporary, "<temporary>").slice(0, 1500); throw error; }
  finally {
    clearTimeout(deadlineTimer);
    for (const gate of held.values()) gate.release();
    restoreObserver?.();
    for (const waiter of pending.values()) waiter.reject(new Error("Probe ended.")); pending.clear();
    if (child) { child.kill(); await child.exited; await readLoop; evidence.child = { exitCode: child.exitCode, signalCode: child.signalCode,
      stderrLineCount: (await stderr ?? "").split("\n").filter(Boolean).length }; }
    await server.stop(true); evidence.durationMs = at(); evidence.cleanup = { nativeChildStopped: true, providerStopped: true };
    evidence.productSourcesChangedDuringScenario = JSON.stringify(report.sourceDigests) !== JSON.stringify(sourceDigests());
    writeFileSync(join(output, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 }); save();
    console.log(JSON.stringify({ scenario: name, status: evidence.status, durationMs: evidence.durationMs,
      requests: requestCount, physicalResponses: evidence.physical.length, checks: evidence.checks, failure: evidence.failure }));
  }
}

test("Codex 0.163.0 steer crosses the real product queue and two physical responses", () => probe(false), limitMs + 5_000);
test("Codex 0.163.0 reconnect keeps the real queued source identity and current observer", () => probe(true), limitMs + 5_000);
