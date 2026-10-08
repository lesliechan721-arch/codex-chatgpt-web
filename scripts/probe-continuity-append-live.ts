import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { resolveDevProfilePaths } from "../src/dev-chat/profile";
import { prepareWorkingTreeBrowserHelper } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { readJsonRequestBody } from "../src/http-body";
import { responseRequest } from "../src/server";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web";
import { chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { cancelLauncherManualTurn, endLauncherManualTurn, inspectLauncherContinuityConversation, markLauncherManualTurnStarted,
  readLauncherBrowserHostDescriptor, startLauncherManualTurn, waitForLauncherManualSent,
  waitForLauncherManualTerminal } from "../src/launcher-browser-host";

// A1: 真实 app-server、工作区 adapter/helper、DEV Broker、Launcher、MCP 和 Native 命令。
// 使用 DEV 当前的 Automatic 或 Zero Risk 模式，不更改交互模式。
// 不保存原始请求、完整 prompt、能力 token、外部凭据或完整 rollout。
// --check-only 不启动服务、客户端、浏览器或 tunnel，也不建立手工 turn。
const args = process.argv.slice(2);
const option = (name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const paths = resolveDevProfilePaths();
// 仅本探针进程选择 DEV 配置。HOME 和 CODEX_HOME 均不修改。
process.env.CODEX_CHATGPT_WEB_HOME = paths.home;
let config: ReturnType<typeof loadConfig>;
try { config = loadConfig(); }
catch (error) {
  console.error(JSON.stringify({ readyToAttempt: false,
    blockers: [`DEV 配置无法由当前工作区解析：${error instanceof Error ? error.message : String(error)}`] }, null, 2));
  process.exit(1);
}
assert.equal(config.purpose, "dev-harness");
assert.equal(config.mode, "full");
assert.equal(config.browserHost, "launcher");
const descriptorPath = config.browserHostDescriptorPath!;
assert.equal(resolve(descriptorPath), resolve(paths.descriptorPath), "只能使用隔离 DEV Launcher");
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
assert.equal(descriptor.profile, "development");
const manual = config.browserInteractionMode === "manual";
const codexCandidate = option("--codex") ?? Bun.which("codex");
assert.ok(codexCandidate, "找不到 codex 客户端");
const codex = realpathSync(resolve(codexCandidate));
let launcherProcess = "running";
try { process.kill(descriptor.pid, 0); }
catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  // EPERM 表示该 PID 存在，但沙箱不允许发送信号；不能把它当作进程已结束。
  launcherProcess = code === "EPERM" ? "present-permission-denied" : code ?? "unknown";
}
const blockers: string[] = [];
if (manual && config.zeroRiskRequireSentConfirmation !== true) blockers.push("Zero Risk 验收需要首次人工发送及 Sent 确认");
if (!config.tunnel) blockers.push("DEV MCP tunnel 配置缺失");
if (!["running", "present-permission-denied"].includes(launcherProcess)) blockers.push(`DEV Launcher 进程检查失败：${launcherProcess}`);
if (!descriptor.features?.includes("session-continuity-v1")) blockers.push("DEV Launcher 未声明 session-continuity-v1 支持");
const preflight = { purpose: config.purpose, mode: config.mode, interaction: config.browserInteractionMode,
  connectorName: manual ? config.manualAppName : config.automaticAppName,
  sentConfirmationRequired: manual && config.zeroRiskRequireSentConfirmation, launcherProfile: descriptor.profile,
  launcherProcess, descriptorVersion: descriptor.version, tunnelConfigured: Boolean(config.tunnel),
  brokerSocketExists: existsSync(config.brokerSocketPath), surfaceCount: Object.keys(descriptor.surfaceTargets).length,
  readyToAttempt: blockers.length === 0, blockers,
  limitations: ["只读检查不验证 MCP tunnel 的实时连接；正式执行由 startDevChatTransport 检查", "socket 文件存在不等于 Broker 进程有效"] };
console.log(JSON.stringify(preflight, null, 2));
if (args.includes("--check-only")) process.exit(blockers.length ? 1 : 0);
assert.equal(blockers.length, 0, blockers.join("；"));

type Message = Record<string, any>;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const runId = `a1-${manual ? "zero-risk" : "automatic"}-${Date.now()}-${suffix}`;
const outputDir = resolve(option("--output") ?? join(".dev-workflows/continuity-append-handoff/tmp", runId));
mkdirSync(outputDir, { recursive: true });
const runtimeDir = join(outputDir, "runtime");
const continuityDir = join(runtimeDir, "session-continuity");
const clientRoot = realpathSync(mkdtempSync(join(tmpdir(), "cgw-append-live-")));
const clientHome = join(clientRoot, "codex-home");
const workspace = join(clientRoot, "workspace");
mkdirSync(clientHome);
mkdirSync(workspace);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const baseMarker = `CGW_APPEND_BASE_${suffix}`;
const appendMarker = `CGW_APPEND_NEW_${suffix}`;
const resultMarker = `CGW_NATIVE_RESULT_${suffix}`;
const command = `sleep 5; printf '%s\\n' '${resultMarker}'`;
const firstText = `这是一个真实连续性验收，不是模拟。必须通过当前 Codex 连接器执行一次 Native exec_command，参数为 ${JSON.stringify({ cmd: command, login: false, yield_time_ms: 10_000, max_output_tokens: 128 })}。`
  + "连接器所需的领取环境、启动、等待、确认追加和完成控制调用都允许，包括 codex_task_update_ack；这些控制调用不算额外 Native 工作工具。不要执行第二次 exec_command 或其他 Native 工作工具。"
  + `必须读取真实命令结果，并确认其中包含 ${resultMarker}，才可给出最终答案。若未收到追加，最终答案只包含 ${baseMarker}。`
  + "如控制通道交付新用户指令，必须先调用 codex_task_update_ack 工具，使用控制信封中的 delivery_id 和 through_revision，收到成功回执后才允许输出最终答案。普通文字不算 ACK。若连接器或命令不可用，请明确报告实际错误和原因，不要输出成功标记，也不要假称已执行命令。";
const appendText = `追加验收指令：保留当前工作，不重新执行任何 Native 工作工具；允许必要的连接器等待、确认追加和完成控制调用。首先调用 codex_task_update_ack，使用本次控制信封提供的 delivery_id 和 through_revision，收到成功回执后再回答。不要把普通文字确认当作工具 ACK。用 ${appendMarker} 替换先前要求的最终答案，最终答案只包含 ${appendMarker}。`;
writeFileSync(join(workspace, "AGENTS.md"), "# 连续性验收\n\n只执行明确要求的无害 sleep/printf 命令。保持命令和最终标记准确。\n");
const report: Message = { schema: "codex-chatgpt-web/continuity-append-live-evidence/v1", runId,
  startedAt: new Date().toISOString(), status: "running", provenance: {
    client: "real-codex-app-server", adapter: "working-tree-createChatGptWebAdapter",
    page: `real-DEV-Launcher-${manual ? "Zero-Risk" : "Automatic"}`, nativeTool: "real-exec-command-sleep-printf",
    authority: "delegated-request-carried", model: option("--model") ?? (manual
      ? config.zeroRiskProEnabled ? "chatgpt-web-continuity/zero-risk-pro" : "chatgpt-web-continuity/zero-risk"
      : "chatgpt-web-continuity/gpt-5.6-sol"),
    simulatedPage: false, simulatedTools: false, configFilesChanged: false,
    baselineHead: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  }, preflight, events: [], requests: [], checks: {} };
const secrets = new Set<string>([config.controlToken, descriptor.control.token].filter(Boolean));
function redact(value: string): string {
  for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
  return value.replace(/\b(?:turn|request|binding|activity)_[A-Za-z0-9_-]{16,}\b/g, "[redacted-capability]");
}
const save = () => writeFileSync(join(outputDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
function record(event: string, fields: Message = {}): void {
  const safe = JSON.parse(redact(JSON.stringify(fields)));
  report.events.push({ at: new Date().toISOString(), event, ...safe });
  save();
  console.log(`${event} ${JSON.stringify(safe)}`);
}
save();
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("用户停止了真实验收"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
// 无任务计时器替代人工发送。此心跳只报告当前阶段。
let phase = "启动 DEV transport";
const heartbeat = setInterval(() => console.log(`等待：${phase}。${manual ? "人工发送没有探针超时；" : ""}Ctrl+C 可停止。`), 30_000);
heartbeat.unref();
let transport: Awaited<ReturnType<typeof startDevChatTransport>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let threadId: string | undefined;
let nativeTurnId: string | undefined;
let firstSession: ChatGptTurnSession | undefined;
let capabilityToken: string | undefined;
let firstLease: unknown;
let manualTabId: string | undefined;
const probeWorkers = new Set<ChatGptBrowserWorker>();
let sessionObservations = 0;
let manualStarts = 0;
let manualStarted = 0;
let sentConfirmations = 0;
let automaticRuns = 0;
let automaticPrepared = 0;
let automaticSendActivations = 0;
let automaticSubmissions = 0;
let appendedRequestSeen = false;
const nativeCommands = new Set<string>();
const nativeCompleted = new Set<string>();
const parsedKeys = new Set<string>();
const notifications: Message[] = [];
const notificationWaiters = new Set<() => void>();
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let probeFailure: Error | undefined;
function failProbe(error: Error): void {
  if (probeFailure) return;
  probeFailure = error;
  for (const item of pending.values()) item.reject(error);
  for (const waiter of [...notificationWaiters]) waiter();
}
let nextId = 1;
function send(value: unknown): void {
  assert.ok(child, "app-server 尚未启动");
  child.stdin!.write(JSON.stringify(value) + "\n");
  child.stdin!.flush();
}
async function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  // 仅限制即时 JSON-RPC 回执；不限制人工发送或模型任务。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolveRpc, rejectRpc) => {
      timer = setTimeout(() => rejectRpc(new Error(`JSON-RPC 回执超时：${method}`)), 20_000);
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc });
      send({ id, method, params });
    });
  } finally { clearTimeout(timer); pending.delete(id); }
}
async function notification(predicate: (message: Message) => boolean): Promise<Message> {
  return await new Promise((resolveWait, rejectWait) => {
    const check = () => {
      if (probeFailure) { cleanup(); rejectWait(probeFailure); return; }
      const found = notifications.find(predicate);
      if (found) { cleanup(); resolveWait(found); }
    };
    const abort = () => {
      cleanup();
      rejectWait(probeFailure ?? (controller.signal.reason instanceof Error
        ? controller.signal.reason : new Error("真实验收已停止")));
    };
    const cleanup = () => { notificationWaiters.delete(check); controller.signal.removeEventListener("abort", abort); };
    notificationWaiters.add(check);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort(); else check();
  });
}
function surfaceSnapshot(): Message {
  const current = readLauncherBrowserHostDescriptor(descriptorPath);
  assert.equal(current.profile, "development");
  assert.equal(current.pid, descriptor.pid, "验收期间 DEV Launcher 不能换进程");
  return { ...current.surfaceTargets };
}
async function verifySurface(): Promise<void> {
  assert.ok(firstSession?.runtime.continuityBinding?.lease, "真实 session 必须有连续性页面 lease");
  const binding = firstSession.runtime.continuityBinding;
  const lease = binding.lease!;
  assert.deepEqual(lease, firstLease, "追加必须保留同一物理页面 lease");
  if (manual) {
    // Manual descriptor 不公开 surfaceTargets。真实 tabId 与该 tab 独有的 lease 共同证明页面身份。
    assert.ok(manualTabId, "必须取得真实 Launcher manual tab ID");
    assert.equal(report.surface.tabId, manualTabId, "必须保留同一手工 tab ID");
    assert.equal(manualStarts, 1, "不得建立第二个手工回合或页面");
    assert.ok(binding.conversation, "手工页面必须关联当前连续性 conversation");
    const physical = await inspectLauncherContinuityConversation(descriptorPath, binding.conversation.key, lease);
    assert.deepEqual(physical.continuity, firstLease, "Launcher 必须仍持有同一手工页面 lease");
    return;
  }
  const current = surfaceSnapshot();
  const created = Object.keys(current).filter(key => !(key in descriptor.surfaceTargets));
  assert.equal(created.length, 1, "验收只能创建一个 DEV 物理页面");
  assert.equal(current[created[0]!], report.surface.targetId, "页面必须保留相同 browser target");
  assert.equal(created[0], report.surface.surfaceId, "页面必须保留相同 surface ID");
}

try {
  // 该探针采用独立 state 目录，需先完成真实 setup 的注册存储初始化。
  // 不修改 DEV/生产存储，也不在请求失败时重置注册记录。
  new ContinuityRegistrationStore(continuityDir).initialize();
  record("isolated-continuity-storage-initialized");
  // 只修改内存中的探针 route；不修改 DEV 或生产配置文件。
  config.toolAuthorityMode = "delegated";
  transport = await startDevChatTransport(config, paths.home);
  const broker = transport.broker;
  const browserHelperScriptPath = manual ? undefined : prepareWorkingTreeBrowserHelper();
  if (!manual) {
    assert.ok(browserHelperScriptPath, "Automatic 验收必须使用当前工作区的真实 browser helper");
    record("working-tree-helper", { path: browserHelperScriptPath });
  }
  const observedWorkers = new WeakSet<ChatGptBrowserWorker>();
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(path, activity) {
      manualStarts++;
      assert.equal(manualStarts, 1, "追加不能要求第二次手工 start/发送");
      const lease = await startLauncherManualTurn(path, activity);
      manualTabId = lease.tabId;
      record("manual-lease", { tabId: lease.tabId, reused: lease.reused, starts: manualStarts });
      record("ACTION_REQUIRED", { instruction: "在 DEV Launcher 复制首条提示，粘贴到该 ChatGPT 页，选择 Launcher 显示的 Zero Risk 插件和模型，发送一次，然后点 Sent。之后等待脚本自动追加。" });
      phase = "首次人工发送和 Sent";
      return lease;
    },
    async waitSent(path, owner, options) {
      const result = await waitForLauncherManualSent(path, owner, options);
      sentConfirmations++;
      record("manual-sent", { confirmations: sentConfirmations });
      return result;
    },
    waitTerminal: waitForLauncherManualTerminal,
    async markStarted(path, owner) {
      await markLauncherManualTurnStarted(path, owner);
      manualStarted++;
      record("manual-started", { starts: manualStarted });
      phase = "真实 Native 命令开始";
    },
    end: endLauncherManualTurn,
    cancel: cancelLauncherManualTurn,
  };
  const adapterFactory: Parameters<typeof responseRequest>[2] = provider => {
    const actual = { ...provider, chatgptWeb: { ...provider.chatgptWeb,
      ...(browserHelperScriptPath ? { browserHelperScriptPath } : {}),
      threadEnvironmentStatePath: join(runtimeDir, "thread-environments.json"),
      lunaCheckpointStatePath: join(runtimeDir, "luna-checkpoints.json"),
      continuityStateDirectory: continuityDir,
      browserDiagnosticsPath: join(runtimeDir, "diagnostics"),
    } };
    const worker = ChatGptBrowserWorker.forProvider(actual);
    probeWorkers.add(worker);
    if (!manual) {
      if (!observedWorkers.has(worker)) {
        observedWorkers.add(worker);
        const realRun = worker.run.bind(worker);
        // 只观察真实 worker 生命周期；保留所有生产 callback 和真实浏览器执行。
        worker.run = turn => {
          automaticRuns++;
          assert.equal(automaticRuns, 1, "追加不能重建物理 browser 响应");
          phase = "真实 Automatic 浏览器执行和 Native 工具";
          return realRun({ ...turn,
            async onPreparedSelected(reused) {
              automaticPrepared++;
              record("automatic-page-selected", { reused, prepared: automaticPrepared });
              await turn.onPreparedSelected?.(reused);
            },
            async onSendActivated() {
              automaticSendActivations++;
              record("automatic-send-activated", { activations: automaticSendActivations });
              await turn.onSendActivated?.();
            },
            async onSubmitted() {
              automaticSubmissions++;
              record("automatic-submitted", { submissions: automaticSubmissions });
              await turn.onSubmitted?.();
            },
          }).catch(error => {
            record("automatic-worker-error", { message: error instanceof Error ? error.message : String(error) });
            throw error;
          });
        };
      }
    }
    const adapter = createChatGptWebAdapter(actual, { broker, zeroRiskManualControl: manualControl, codexHome: clientHome });
    const run = adapter.runTurn!.bind(adapter);
    return { ...adapter, async runTurn(parsed, incoming, emit) {
      assert.equal(parsed._conversationPolicy, "continuity-first", "真实请求必须选择连续性模式");
      const identity = extractChatGptTurnIdentity(parsed);
      assert.equal(identity.threadId, threadId, "追加必须属于同一原生线程");
      nativeTurnId ??= identity.turnId;
      assert.equal(identity.turnId, nativeTurnId, "追加必须属于同一原生 turn");
      const namespace = chatGptWebExecutionNamespace(actual);
      const captureSession = () => {
        // prepareContinuityRequest 可在 run 内设置 historyRevision；只观察已建立的实际键。
        if (!Number.isSafeInteger(parsed._continuityHistoryRevision) || parsed._continuityHistoryRevision! < 0) return;
        const key = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
        const session = chatGptTurnSessions.find(key);
        if (!session) return;
        parsedKeys.add(key);
        sessionObservations++;
        if (firstSession) assert.equal(session, firstSession, "必须复用同一物理 session/runtime/响应");
        else {
          firstSession = session;
          assert.equal(session.runtime.mode, "tools");
          assert.equal(Boolean(session.runtime.manualControl), manual);
          assert.ok(session.runtime.taskUpdates, "活动响应必须协商追加协议");
        }
      };
      captureSession();
      await run(parsed, incoming, event => { captureSession(); emit(event); });
      captureSession();
    } };
  };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
        return new Response("Not found", { status: 404 });
      }
      const body = await readJsonRequestBody(request.clone()) as Message;
      const input: Message[] = Array.isArray(body.input) ? body.input : [];
      const hasAppend = input.some(item => item.role === "user" && (JSON.stringify(item.content) ?? "").includes(appendMarker));
      const resultItems = input.filter(item => ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type));
      const entry: Message = { sequence: report.requests.length + 1, hasAppend, resultCount: resultItems.length,
        hasRealResultMarker: resultItems.some(item => JSON.stringify(item).includes(resultMarker)) };
      report.requests.push(entry);
      if (hasAppend && !appendedRequestSeen) {
        appendedRequestSeen = true;
        assert.ok(resultItems.length > 0 && entry.hasRealResultMarker, "A1 必须在同一真实请求携带 Native 结果与追加文本");
        record("append-with-real-result", { sequence: entry.sequence, resultCount: resultItems.length });
      }
      const response = await responseRequest(request, config, adapterFactory, {
        rememberState: false, onTurnIdentity: () => controller.signal,
        onAdapterEvent(event) {
          if (event.type === "error") {
            const message = redact(event.message);
            record("adapter-error", { code: event.code, status: event.status, message });
            failProbe(new Error(`真实 adapter 失败：${event.code ?? "unknown"}（HTTP ${event.status ?? "unknown"}）：${message}`));
          }
        },
      });
      entry.status = response.status;
      save();
      if (!response.ok) failProbe(new Error(`真实 Responses 请求失败：HTTP ${response.status}`));
      assert.notEqual(response.status, 409, "同源追加不能返回模式切换 409");
      return response;
    },
  });
  const catalog = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(catalog.status, 0, "无法读取本机 Codex 模型目录");
  writeFileSync(join(clientRoot, "models.json"), JSON.stringify(augmentNativeModelCatalog(JSON.parse(catalog.stdout), config)));
  const model = report.provenance.model;
  const localKey = randomUUID();
  secrets.add(localKey);
  writeFileSync(join(clientHome, "config.toml"), [
    `model = ${JSON.stringify(model)}`, 'model_provider = "cgw_append_live"',
    `model_catalog_json = ${JSON.stringify(join(clientRoot, "models.json"))}`,
    'approval_policy = "never"', 'model_auto_compact_token_limit = 100000000',
    '[model_providers.cgw_append_live]', 'name = "DEV continuity append live acceptance"',
    `base_url = "http://127.0.0.1:${server.port}/v1"`, 'env_key = "CGW_APPEND_LIVE_KEY"',
    'wire_api = "responses"', 'supports_websockets = false',
    '[features]', 'multi_agent = false',
  ].join("\n"), { mode: 0o600 });
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: clientHome, CODEX_SQLITE_HOME: clientHome, CGW_APPEND_LIVE_KEY: localKey };
  delete childEnvironment.OPENAI_API_KEY;
  child = Bun.spawn([codex, "app-server"], { cwd: workspace, env: childEnvironment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  void child.exited.then(() => {
    if (report.status === "running") controller.abort(new Error("真实 app-server 提前退出"));
    for (const item of pending.values()) item.reject(new Error("真实 app-server 已退出"));
  });
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child!.stdout!) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message: Message = JSON.parse(line);
        if (message.id !== undefined && message.method) {
          send({ id: message.id, error: { code: -32601, message: "验收不支持额外交互请求" } });
          controller.abort(new Error(`app-server 请求了额外交互：${message.method}`));
        } else if (typeof message.id === "number") {
          const item = pending.get(message.id);
          if (message.error) item?.reject(new Error(redact(JSON.stringify(message.error)))); else item?.resolve(message.result);
        } else {
          notifications.push(message);
          const item = message.params?.item;
          if (item?.type === "commandExecution") {
            if (message.method === "item/started") nativeCommands.add(item.id);
            if (message.method === "item/completed") nativeCompleted.add(item.id);
          }
          if (message.method === "turn/completed" && message.params?.threadId === threadId
            && (!nativeTurnId || message.params?.turn?.id === nativeTurnId)) {
            const status = message.params?.turn?.status;
            if (status !== "completed" || nativeCommands.size === 0) {
              failProbe(new Error(`真实原生 turn 已结束：${status ?? "unknown"}`
                + (nativeCommands.size === 0 ? "；未执行预期的 Native 命令" : "")));
            }
          }
          for (const waiter of [...notificationWaiters]) waiter();
        }
      }
    }
  })().catch(error => controller.abort(error));
  await rpc("initialize", { clientInfo: { name: "continuity-append-live", version: "1" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  const started = await rpc("thread/start", { cwd: workspace, model, approvalPolicy: "never", sandbox: "read-only",
    developerInstructions: "这是隔离 DEV 验收。工具由真实 Codex Native 执行。只按用户给出的 sleep/printf 命令执行一次。" });
  threadId = started.thread.id;
  report.threadFingerprint = sha256(threadId!);
  const active = await rpc("turn/start", { threadId, input: [{ type: "text", text: firstText }] });
  const turnId = active.turn.id;
  nativeTurnId ??= turnId;
  await notification(message => message.method === "item/started" && message.params?.threadId === threadId
    && message.params?.turnId === turnId && message.params?.item?.type === "commandExecution");
  assert.equal(nativeCommands.size, 1, "追加时只有一个真实 Native 命令正在执行");
  assert.ok(firstSession && firstSession.runtime.mode === "tools");
  capabilityToken = await firstSession.runtime.token;
  secrets.add(capabilityToken);
  firstLease = structuredClone(firstSession.runtime.continuityBinding?.lease);
  if (manual) {
    assert.ok(manualTabId);
    report.surface = { tabId: manualTabId };
  } else {
    const newSurfaces = Object.entries(surfaceSnapshot()).filter(([key]) => !(key in descriptor.surfaceTargets));
    assert.equal(newSurfaces.length, 1);
    report.surface = { surfaceId: newSurfaces[0]![0], targetId: newSurfaces[0]![1] };
  }
  const before = broker.taskUpdateState(capabilityToken);
  assert.ok(before, "追加前必须有 task-updates 状态");
  report.before = { acceptedRevision: before.acceptedRevision, deliveredRevision: before.deliveredRevision,
    acknowledgedRevision: before.acknowledgedRevision, driverGeneration: before.driverGeneration };
  await verifySurface();
  record("native-command-started", { commandCount: nativeCommands.size, realSleepSeconds: 5 });
  phase = "真实 turn/steer 追加、控制通道交付及 ACK";
  await rpc("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: appendText }] });
  record("native-steer-accepted");
  const completed = await notification(message => message.method === "turn/completed" && message.params?.threadId === threadId
    && message.params?.turn?.id === turnId);
  assert.equal(completed.params.turn.status, "completed", "真实原生 turn 必须成功完成");
  await firstSession.physicalSettlement;
  await verifySurface();
  assert.ok(appendedRequestSeen, "必须观察到真实结果与追加的联合请求");
  assert.ok(parsedKeys.size >= 2, "追加必须建立新的逻辑 execution key");
  assert.ok(sessionObservations >= 2, "追加前后都必须观察到物理 session");
  assert.equal(manualStarts, manual ? 1 : 0);
  assert.equal(manualStarted, manual ? 1 : 0);
  assert.equal(sentConfirmations, manual ? 1 : 0);
  if (!manual) {
    assert.equal(automaticRuns, 1);
    assert.equal(automaticPrepared, 1);
    assert.equal(automaticSendActivations, 1);
    assert.equal(automaticSubmissions, 1);
  }
  assert.equal(nativeCommands.size, 1);
  assert.equal(nativeCompleted.size, 1);
  const after = broker.taskUpdateState(capabilityToken);
  assert.ok(after, "完成后仍需保留协议状态证据");
  assert.equal(after.acceptedRevision, before.acceptedRevision + 1, "新增用户指令只接收一次");
  assert.equal(after.deliveredRevision, after.acceptedRevision, "追加必须经真实 MCP 控制通道交付");
  assert.equal(after.acknowledgedRevision, after.acceptedRevision, "真实模型必须确认追加");
  assert.equal(after.driverGeneration, before.driverGeneration + 1, "只建立一次新驱动");
  report.after = { acceptedRevision: after.acceptedRevision, deliveredRevision: after.deliveredRevision,
    acknowledgedRevision: after.acknowledgedRevision, driverGeneration: after.driverGeneration };
  const rollout: Message[] = readFileSync(started.thread.path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const nativeItems = rollout.filter(entry => entry.type === "response_item").map(entry => entry.payload);
  const calls = nativeItems.filter(item => ["function_call", "custom_tool_call"].includes(item?.type));
  const results = nativeItems.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item?.type));
  assert.equal(calls.length, 1, "真实 rollout 只能有一次 Native 工具调用");
  assert.equal(results.length, 1, "真实 rollout 只能有一次 Native 工具结果");
  assert.ok(JSON.stringify(results[0]).includes(resultMarker), "真实 sleep/printf 必须返回要求的标记");
  const outcome = firstSession.settledOutcome();
  assert.ok(outcome?.type === "final");
  // Browser markdown can escape underscores in the otherwise identical marker.
  const answerText = outcome.answer.replace(/\\_/g, "_");
  assert.ok(answerText.includes(appendMarker), "新增文本必须影响真实最终答案");
  assert.ok(!answerText.includes(baseMarker), "最终答案必须采用追加后的要求");
  report.finalAnswerFingerprint = sha256(outcome.answer);
  report.checks = { no409: report.requests.every((entry: Message) => entry.status === 200),
    appendWithRealResult: appendedRequestSeen, appendChangesFinalAnswer: true,
    samePhysicalSession: true, samePhysicalResponse: true, samePageLease: true,
    manualStarts, manualStarted, sentConfirmations, nativeCommandExecutions: nativeCommands.size,
    automaticRuns, automaticPrepared, automaticSendActivations, automaticSubmissions,
    nativeRolloutCalls: calls.length, nativeRolloutResults: results.length,
    logicalExecutionKeys: parsedKeys.size, acceptedAndDeliveredAndAcknowledged: true };
  assert.ok(report.checks.no409, "所有真实 Responses 请求必须成功");
  report.status = "passed";
  record(`A1_${manual ? "ZERO_RISK" : "AUTOMATIC"}_PASSED`, report.checks);
  child.kill();
  await child.exited;
  // stderr 只保存摘要，防止工具、环境或凭据进入证据文件。
  report.clientStderrChars = (await stderr).length;
} catch (error) {
  report.status = "failed";
  report.error = redact(error instanceof Error ? error.message : String(error));
  if (transport && capabilityToken) {
    try {
      const state = transport.broker.taskUpdateState(capabilityToken);
      if (state) report.failureState = { acceptedRevision: state.acceptedRevision,
        deliveredRevision: state.deliveredRevision, acknowledgedRevision: state.acknowledgedRevision,
        driverGeneration: state.driverGeneration };
    } catch { /* Capability retirement does not replace the original failure. */ }
  }
  const outcome = firstSession?.settledOutcome();
  if (outcome?.type === "final") report.failureAnswer = redact(outcome.answer).slice(0, 2_000);
  record(`A1_${manual ? "ZERO_RISK" : "AUTOMATIC"}_FAILED`, { error: report.error });
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  const cleanupReason = new Error("验收结束");
  controller.abort(cleanupReason);
  if (child) { child.kill(); await child.exited; }
  const cleanupErrors: string[] = [];
  const cleanupFailure = (error: unknown) => cleanupErrors.push(redact(error instanceof Error ? error.message : String(error)));
  // 只终止本探针捕获的 session 和 worker；先等待物理执行结束，再退出其连续性绑定。
  if (firstSession?.isActive()) {
    try { firstSession.cancel(cleanupReason); } catch (error) { cleanupFailure(error); }
  }
  await Promise.all([...probeWorkers].map(worker => worker.close().catch(cleanupFailure)));
  await firstSession?.physicalSettlement.catch(cleanupFailure);
  if (threadId) await leaveContinuityMode(continuityDir, threadId).catch(error => {
    cleanupFailure(error);
  });
  if (cleanupErrors.length) report.cleanupError = cleanupErrors.join("；");
  server?.stop(true);
  await transport?.close();
  rmSync(clientRoot, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  save();
  console.log(`证据文件：${join(outputDir, "evidence.json")}`);
}
