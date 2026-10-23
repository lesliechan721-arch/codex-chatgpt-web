import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { loadConfigFromPath, providerConfig, type AppConfig } from "../src/config";
import { resolveDevProfilePaths } from "../src/dev-chat/profile";
import { prepareWorkingTreeBrowserHelper } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { tunnelStatus } from "../src/tunnel";
import { requireChatGptWebModelRoute, resolveChatGptWebContextLimits, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { prepareContinuityDevProvider, continuityDevProviderEvidence } from "./unified-task-continuity-dev-provider";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions, chatGptTurnExecutionKey, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { recoveryRecord, recoveryResultDigest, recoveryStore } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import type { RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import type { ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { callTurnBroker, type TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { compileChatGptWebPrompt, type CompiledChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { responseRequest } from "../src/server";
import { createLiveRequestBody } from "./validate-context-rendering";
import { extractContinuityFinalResponseText, summarizeContinuityFinalResponse } from "./unified-task-continuity-final-response";
import { boundedCleanupObservation, cleanupCompletedContinuityPage, completedCleanupDisposition, type CompletedCleanupResult } from "./unified-task-continuity-completed-cleanup";
import { runContinuityHarnessRequest, summarizeHarnessResponse } from "./unified-task-continuity-request-retry";
import { inspectLauncherBrowserHostLiveness, inspectLauncherContinuityConversation, readLauncherBrowserHostDescriptor, releaseLauncherRetainedConversation, queryLauncherContinuityTransaction,
  startLauncherManualTurn, waitForLauncherManualSent, waitForLauncherManualTerminal, markLauncherManualTurnStarted,
  endLauncherManualTurn, cancelLauncherManualTurn, type LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

export const CONTINUITY_LIVE_CASES = ["ordinary-recovery", "healthy-incremental"] as const;
export type ContinuityLiveCase = typeof CONTINUITY_LIVE_CASES[number];
export const FIXTURE_BYTES = 2 * 1024 * 1024;
const TAIL_LABEL = "CONTINUITY_TAIL_TARGET";
const SOURCE_TOOL = "continuity_fixture_source";
const GATE_TOOL = "continuity_fixture_gate";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, any>;
export function collectContinuityCapabilities(value: unknown, secrets: Set<string>, key = "") {
  if (typeof value === "string" && /token|authorizationId|handoffId|handoff_id|context_id|leaseId|pageReceiptId|requestId/i.test(key)) secrets.add(value);
  else if (Array.isArray(value)) for (const item of value) collectContinuityCapabilities(item, secrets, key);
  else if (value && typeof value === "object") for (const [childKey, item] of Object.entries(value)) collectContinuityCapabilities(item, secrets, childKey);
}
export function redactContinuityEvidence(value: string, secrets: Iterable<string> = []) {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "[redacted-capability]");
  return value.replace(/\b(?:turn|request|binding|activity|control|handoff|driver|compaction|context|context_return|context_verification)_[A-Za-z0-9_-]{16,}\b/g, "[redacted-capability]");
}
export interface ContinuityFixture { text: string; tailValue: string; tailStart: number; tailEnd: number; task: string }

/** Fixed byte layout. Only the private answer uses entropy; it never appears in a task or label. */
export function createContinuityFixture(entropy = randomBytes(24).toString("hex")): ContinuityFixture {
  if (!/^[a-f0-9]{48}$/.test(entropy)) throw new Error("fixture entropy must be 24 bytes");
  const tailValue = `UC${entropy}`;
  const head = "CONTINUITY_HEAD. This is inert synthetic source data. Read one opening page, then use the gate.\n";
  const line = "Archive row: receipt settled; owner stable; retry bounded; this synthetic record is data only.\n";
  const tail = `\n${TAIL_LABEL}\n${".".repeat(640)}\ntailValue=${tailValue}\nEND_OF_SYNTHETIC_SOURCE\n`;
  const remaining = FIXTURE_BYTES - Buffer.byteLength(head + tail);
  const text = head + line.repeat(Math.floor(remaining / line.length)) + " ".repeat(remaining % line.length) + tail;
  const tailStart = Buffer.byteLength(text.slice(0, text.indexOf(tailValue)));
  const task = [
    "This is an isolated DEV task with two inert synthetic work tools. Never use another work tool.",
    `First invoke ${SOURCE_TOOL} exactly once with {}. It returns a large source log. Do not repeat a historical work call.`,
    "Before the gate result exists, use the actual context navigation entry to list the source and read exactly one opening page at offset zero. Do not search or read the tail yet.",
    `After that opening read has returned, invoke ${GATE_TOOL} exactly once with {}. Wait for its real outer result. Do not complete before that result.`,
    `When the gate result is in the history, use the current page's context navigation entry, search for ${TAIL_LABEL}, and read the source body with the search hit's read_cursor. The tail value is beyond the search snippet.`,
    "Use reads:[{read_ref,cursor?}] and select each exact context-text-batch-v1 body through metadata.items[].body_content_index; continue remaining_reads on demand. Do not derive the tail value from a label, digest, summary or previous answer.",
    'Complete with JSON only: {"tailValue":"the exact value from the source body"}. If navigation or the source is unavailable, report the actual failure.',
  ].join("\n");
  return { text, tailValue, tailStart, tailEnd: tailStart + Buffer.byteLength(tailValue), task };
}

export function continuityLivePlan() {
  const fixture = createContinuityFixture("0".repeat(48));
  return { schema: "unified-task-continuity-live-plan/v1", spec: "v4", cases: CONTINUITY_LIVE_CASES,
    fixture: { version: 2, bytes: FIXTURE_BYTES, estimatedSourceTokens: estimateTokens(fixture.text), layoutDigest: hash(fixture.text), privateAnswer: "fresh 24-byte entropy per run; omitted from plan", task: fixture.task },
    sequence: ["actual model source-tool dispatch", "preparation fault: exact seed-page crash before any source bytes reach the model", "outer synthetic source result accepted into a real cold plan", "one actual opening-page read", "actual model gate-tool dispatch",
      "ordinary-recovery only: exact owned Automatic CDP target Page.crash, with Send/stop observations", "outer gate result via same native turn",
      "actual current-entry search/read and completion", "durable call/result and physical page comparison"],
    sending: { command: "run requires --case=, --mode= and --model=", automatic: "uses existing DEV mode", zeroRisk: "human Send and Sent only; no DOM/CDP access" },
    prepared: ["Automatic ordinary-recovery", "Automatic healthy-incremental"],
    gaps: ["Zero Risk source preparation and fault injection: manual targets are intentionally not exposed; no live Zero Risk case is prepared", "explicit user page-close stop control",
      "checkpoint continuation", "uncommitted compaction recovery", "old-live-page stale credential rejection", "five-page resource pressure and cleanup", "real Codex history-budget loading"],
    guarantees: "project-controlled dispatch and state only; platform-owned activities and platform tokens remain unknown" };
}

export function parseContinuityLiveArgs(args: string[]) {
  const [action = "check", ...options] = args;
  if (action === "--check-only" || action === "check" || action === "plan") {
    if (options.length) throw new Error("check / plan 不接受参数");
    if (action === "plan") return { action: "plan" } as const;
    return { action: "check" } as const;
  }
  const value = (name: string) => options.find(option => option.startsWith(`${name}=`))?.slice(name.length + 1);
  const keys = ["--case", "--mode", "--model", "--output"];
  if (action !== "run" || options.some(option => !keys.some(key => option.startsWith(`${key}=`)))
    || keys.some(key => options.filter(option => option.startsWith(`${key}=`)).length > 1)
    || !CONTINUITY_LIVE_CASES.includes(value("--case") as ContinuityLiveCase)
    || !["automatic", "zero-risk"].includes(value("--mode") ?? "") || !value("--model")) {
    throw new Error("run 需要 --case=ordinary-recovery|healthy-incremental、--mode=automatic|zero-risk、--model=；可选 --output=");
  }
  if (value("--model")!.startsWith("chatgpt-web-continuity/")) throw new Error("旧模式名称已删除；请使用 chatgpt-web/ 名称");
  if (value("--mode") === "zero-risk") throw new Error("Zero Risk 真实来源准备没有公开故障入口；本脚本的两个 case 尚不能执行，不会代办人工 Send/Sent");
  return { action: "run", case: value("--case") as ContinuityLiveCase, mode: value("--mode") as "automatic" | "zero-risk",
    model: value("--model")!, output: value("--output") } as const;
}

/** No Launcher/tunnel/broker startup, turn registration, Verify runtime run, or message send. */
export async function checkContinuityDev() {
  const paths = resolveDevProfilePaths();
  const report: Row = { schema: "unified-task-continuity-live-check/v1", readyToAttempt: false, blockers: [],
    checkOnly: true, modelSent: false, configChanged: false, launcherStarted: false, verificationRun: false };
  let config: AppConfig | undefined, descriptor: LauncherBrowserHostDescriptor | undefined;
  let configValid = false;
  try {
    config = loadConfigFromPath(paths.configPath);
    assert.equal(config.purpose, "dev-harness"); assert.equal(config.mode, "full"); assert.equal(config.browserHost, "launcher");
    assert.equal(resolve(config.browserHostDescriptorPath ?? ""), resolve(paths.descriptorPath));
    const entry = config.runtimeCommand.find(part => part.endsWith("/src/cli.ts"));
    assert.equal(entry && resolve(entry), resolve(import.meta.dir, "../src/cli.ts"), "DEV runtime 必须绑定当前 checkout");
    report.config = { mode: config.browserInteractionMode === "manual" ? "zero-risk" : "automatic",
      connector: config.browserInteractionMode === "manual" ? config.manualAppName : config.automaticAppName,
      sentConfirmationRequired: config.zeroRiskRequireSentConfirmation, authority: config.toolAuthorityMode,
      freshPerTurn: config.experimentalFreshConversationPerTurn,
      account: { solAvailable: config.solAvailable, proAvailable: config.proAvailable, extraHighAvailable: config.extraHighAvailable } };
    if (config.experimentalFreshConversationPerTurn) report.blockers.push("健康页对照需要现有 DEV Fresh 偏好关闭；脚本不会更改配置");
    if (config.browserInteractionMode === "manual" && !config.zeroRiskRequireSentConfirmation) report.blockers.push("Zero Risk 必须保留人工 Sent");
    configValid = true;
  } catch (error) { report.blockers.push(`DEV 配置：${error instanceof Error ? error.message : String(error)}`); }
  if (config && configValid) {
    const checks = await Promise.allSettled([
      inspectLauncherBrowserHostLiveness(paths.descriptorPath, { expectedProfile: "development", timeoutMs: 3_000 }),
      callTurnBroker<Row>(config.brokerSocketPath, { method: "owner_status" }, 1_000),
      prepareContinuityDevProvider(providerConfig(config), paths),
    ]);
    for (const [index, check] of checks.entries()) {
      if (check.status === "rejected") {
        const message = String(check.reason instanceof Error ? check.reason.message : check.reason);
        if (index === 1 && /\b(?:ECONNREFUSED|ENOENT)\b/.test(message)) {
          report.broker = { live: false, protocolVersion: null, recoveryProtocol: null, runPreparation: "startDevChatTransport.listen then actual owner_status before turn admission" };
        } else report.blockers.push(`${["Launcher 活实例", "Broker 活协议", "Verify runtime"][index]}：${message}`);
        continue;
      }
      if (index === 0) {
        descriptor = check.value as LauncherBrowserHostDescriptor;
        report.launcher = { pid: descriptor.pid, version: descriptor.version, instanceDigest: descriptor.launcherInstance ? hash(JSON.stringify(descriptor.launcherInstance)) : null,
          features: descriptor.features, publishedSurfaceCount: Object.keys(descriptor.surfaceTargets).length };
        if (!descriptor.launcherInstance) report.blockers.push("Launcher 没有可核对的当前进程实例身份");
        for (const feature of ["session-continuity-v1", "session-continuity-recovery-v4", "execution-generation-fencing-v1", "context-delivery-plan-v1"])
          if (!descriptor.features?.includes(feature)) report.blockers.push(`Launcher 缺少 ${feature}`);
      } else if (index === 1) {
        const status = check.value as Row;
        report.broker = { live: true, protocolVersion: status.protocolVersion, recoveryProtocol: status.recoveryProtocol, contextProtocol: status.contextProtocol };
        if (!Number.isInteger(status.protocolVersion) || status.protocolVersion < 13 || status.recoveryProtocol !== 2) report.blockers.push("Broker 缺少当前执行隔离协议");
      } else {
        const prepared = check.value as Awaited<ReturnType<typeof prepareContinuityDevProvider>>;
        const capability = prepared.capability;
        report.providerCapability = continuityDevProviderEvidence(prepared);
        report.contextCapability = { staticSchemaChecked: true, schemaDigest: capability.schemaDigest,
          contextProtocol: capability.contextProtocol, textReadFormat: capability.textReadFormat };
      }
    }
    const tunnel = tunnelStatus(config);
    report.tunnel = { ok: tunnel.ok, ready: tunnel.ready };
    if (!tunnel.ok || !tunnel.ready) report.blockers.push("Launcher 拥有的 DEV tunnel 未就绪");
  }
  report.readyToAttempt = report.blockers.length === 0;
  return { paths, config, descriptor, report };
}

export interface ReadEvidence { phase: string; contextDigest: string; start: number; end: number; bytes: number; exact: boolean; confirmed: boolean; tail: boolean }
export interface ContinuityLiveOptions { action: "run"; case: ContinuityLiveCase; mode: "automatic" | "zero-risk"; model: string; output?: string }
export interface ContinuityHarnessContext {
  broker: TurnBroker;
  report: Row; fixture: ContinuityFixture; body: Row; gate: Row; source: Row;
  phase(value: string): void;
  record(): RecoveryThreadRecord;
  pageIdentity(): Promise<Row>;
  crashOwnedPage(page: Row, kind: string): Promise<void>;
  request(body?: Row, allowFailure?: boolean): Promise<Row>;
  appendResult(call: Row, output: string): Row;
  onConfirmedRead(listener?: (row: ReadEvidence) => void): void;
  event(kind: string, details?: Row): void;
  save(): void;
  redact(text: string): string;
}
export interface ContinuityHarnessHooks {
  caseName: string;
  task(fixture: ContinuityFixture): string;
  afterOpening(context: ContinuityHarnessContext): Promise<void>;
  workTools?: Array<{ name: string; description: string }>;
}
export function inspectContinuityEvidence(fixture: ContinuityFixture, rows: ReadEvidence[], calls: Row[], options: {
  fault: boolean; oldTarget: string; newTarget: string; selectedResume: boolean; oldStopped: boolean; newStopped: boolean; tailValue: string;
}) {
  const failures: string[] = [];
  const head = rows.filter(row => row.phase === "opening" && row.exact && row.confirmed);
  const tail = rows.filter(row => row.phase === "continuation" && row.exact && row.confirmed && row.tail);
  if (head.length !== 1 || head[0]?.start !== 0 || head[0].end >= fixture.tailStart) failures.push("首轮缺少唯一真实开头读取，或提前读到尾部");
  if (!tail.length) failures.push("续接缺少覆盖独有值的真实读取收据");
  if (options.fault && head.some(row => tail.some(last => row.contextDigest === last.contextDigest))) failures.push("新页仍使用原导航入口");
  if (options.tailValue !== fixture.tailValue) failures.push("真实答案与尾部独有值不相等");
  for (const name of [SOURCE_TOOL, GATE_TOOL]) if (calls.filter(call => call.name === name).length !== 1) failures.push(`${name} 实际派发次数不是一次`);
  if (calls.some(call => ![SOURCE_TOOL, GATE_TOOL].includes(call.name))) failures.push("发生了未允许的业务派发");
  if (!options.oldTarget || !options.newTarget) failures.push("缺少真实页面身份");
  if (options.fault ? options.oldTarget === options.newTarget : options.oldTarget !== options.newTarget) failures.push("物理页面选择不符合 case");
  if (options.oldStopped || options.newStopped) failures.push("本 case 存在停止事实，不能标为恢复通过");
  if (!options.fault && !options.selectedResume) failures.push("健康页没有选择增量计划");
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const unique = new Map<string, Array<[number, number]>>();
  for (const row of rows.filter(row => row.exact && row.confirmed)) {
    const ranges = unique.get("fixed-source") ?? []; ranges.push([row.start, row.end]); unique.set("fixed-source", ranges);
  }
  let through = 0, uniqueBytes = 0;
  for (const [start, end] of (unique.get("fixed-source") ?? []).sort((a, b) => a[0] - b[0])) {
    uniqueBytes += Math.max(0, end - Math.max(through, start)); through = Math.max(through, end);
  }
  const delivered = rows.filter(row => row.exact && row.confirmed).reduce((sum, row) => sum + row.bytes, 0);
  return { passed: failures.length === 0, failures, preparedReadBytes: total, deliveredReadBytes: delivered,
    uniqueReadBytes: uniqueBytes, repeatedReadBytes: delivered - uniqueBytes, unconfirmedReadBytes: total - delivered };
}

export async function runContinuityLive(options: ContinuityLiveOptions, hooks?: ContinuityHarnessHooks) {
  const inspected = await checkContinuityDev();
  assert.ok(inspected.report.readyToAttempt, `DEV 未就绪：${inspected.report.blockers.join("；")}`);
  const config = inspected.config!, descriptor = inspected.descriptor!, paths = inspected.paths;
  assert.equal(inspected.report.config.mode, options.mode, "脚本不会切换 DEV 发送模式");
  const route = requireChatGptWebModelRoute(options.model, config);
  const fixture = createContinuityFixture();
  if (hooks) fixture.task = hooks.task(fixture);
  assert.ok(!fixture.task.includes(fixture.tailValue), "任务不能包含私有答案");
  const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
  const transportLimits = resolveChatGptWebTransportLimits(route.backendModel, route.adapterEffort, config);
  const sourceTokens = estimateTokens(fixture.text, options.model);
  assert.ok(sourceTokens > limits.contextWindow, "合成日志 token 未超过本模型原网页窗口");
  const runId = `unified-live-${hooks?.caseName ?? options.case}-${options.mode}-${randomUUID().slice(0, 8)}`;
  const output = resolve(options.output ?? join(".dev-workflows/unified-task-continuity/evidence/runs", runId));
  assert.ok(!existsSync(output), "证据目录已存在；使用新的输出目录");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const runtime = mkdtempSync(join(tmpdir(), "unified-continuity-runtime-")), continuity = join(runtime, "session-continuity");
  // This process selects the DEV home. No HOME/CODEX_HOME or configuration file is changed.
  const previousConfigHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = paths.home;
  const secrets = new Set([config.controlToken, descriptor.control.token].filter(Boolean));
  const redact = (text: string) => redactContinuityEvidence(text, secrets);
  const report: Row = { schema: "unified-task-continuity-live/v1", spec: "v4", runId, status: "running", case: hooks?.caseName ?? options.case, mode: options.mode,
    model: options.model, effort: route.adapterEffort, startedAt: new Date().toISOString(), preflight: inspected.report,
    runnerDigest: hash(readFileSync(import.meta.path)), requestBoundaryDigest: hash(readFileSync(new URL("./unified-task-continuity-request-retry.ts", import.meta.url))),
    head: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    fixture: { version: 2, sourceBytes: FIXTURE_BYTES, sourceTokens, sourceDigest: hash(fixture.text), answerDigest: hash(fixture.tailValue), tailStart: fixture.tailStart,
      requestReceivedBytes: [], originalWebLimits: { ...limits, ...transportLimits } },
    provenance: { adapter: "current-source", broker: "real-DEV", helper: "current-source", page: "real-DEV-Launcher", workTools: "real-dispatched-inert-outer-fixture-tools", simulatedPage: false, configChanged: false },
    plans: [], reads: [], calls: [], results: [], pages: [], events: [], journal: [], navigationCosts: [], requests: [], requestRetryDecisions: [],
    limitations: continuityLivePlan().gaps, guarantee: "仅保证项目控制的派发与状态；ChatGPT 平台自有活动是否停止未知；平台 token 未知" };
  const save = () => writeFileSync(join(output, "evidence.json"), redact(JSON.stringify(report, null, 2) + "\n"), { mode: 0o600 });
  const event = (kind: string, details: Row = {}) => { report.events.push({ at: new Date().toISOString(), phase, kind, ...details }); save(); };
  let phase = "source", session: ChatGptTurnSession | undefined;
  let readListener: ((row: ReadEvidence) => void) | undefined;
  let actualWorkerPage: { lease: ContinuityLease; conversation: string; settlement: Promise<void> } | undefined;
  const physicalTargets = new Set<string>();
  const readReceipts = new Map<string, ReadEvidence[]>();
  const navigationReceipts = new Map<string, Row>();
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("验收用户停止"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const heartbeat = setInterval(() => console.log(`验收阶段：${phase}。${options.mode === "zero-risk" ? "等待原流程人工 Send/Sent。" : ""}`), 30_000);
  heartbeat.unref();
  const originalPrepare = ContextScope.prototype.prepare, originalFinish = ContextScope.prototype.finish;
  const originalWorker = ChatGptBrowserWorker.prototype.run;
  let transport: Awaited<ReturnType<typeof startDevChatTransport>> | undefined;
  const summarizeJournal = (label: string) => {
    const ref = session?.runtime.continuityBinding?.recovery;
    assert.ok(ref, "缺少真实 durable work 关系");
    const record = recoveryStore(ref).get(ref.thread);
    if (!record) {
      const registry = JSON.parse(readFileSync(join(ref.directory, "threads.json"), "utf8"));
      assert.ok(!registry.entries?.[ref.thread], "destroyed page retained its registration");
      const row = { label, pageTaskAbsent: true, registryEntryAbsent: true, stopped: false, epoch: undefined,
        attempts: [], calls: [] };
      report.journal.push(row); save(); return row;
    }
    const work = record.works[ref.logicalWorkId];
    assert.ok(work, "current page has no matching work");
    collectContinuityCapabilities(record, secrets);
    const row = { label, version: record.version, epoch: record.epoch, historyRevision: record.historyRevision, taskRevision: work.acceptedTaskRevision,
      workDigest: hash(work.logicalWorkId), state: work.state, stopped: work.state === "stopped", stopReason: work.stopReason ?? null,
      attempts: work.attempts.map(attempt => ({ attempt: attempt.attempt, epoch: attempt.epoch, stage: attempt.stage, writerRetired: attempt.writerRetired })),
      calls: Object.values(record.calls).map(call => ({ callId: call.callId, state: call.state, firstResultDigest: call.firstResultDigest ?? null })) };
    report.journal.push(row); save(); return row;
  };
  const pageIdentity = async () => {
    const binding = session?.runtime.continuityBinding;
    const lease = hooks ? actualWorkerPage?.lease ?? binding?.lease : binding?.lease;
    const conversation = hooks ? actualWorkerPage?.conversation ?? binding?.conversation?.key : binding?.conversation?.key;
    assert.ok(lease && conversation, "缺少真实页面 lease");
    await inspectLauncherContinuityConversation(paths.descriptorPath, conversation, lease);
    const current = readLauncherBrowserHostDescriptor(paths.descriptorPath);
    assert.equal(current.pid, descriptor.pid, "验收期间 Launcher 实例改变");
    assert.deepEqual(current.launcherInstance, descriptor.launcherInstance);
    if (options.mode === "zero-risk") {
      const row = report.pages.at(-1); assert.ok(row?.tabId, "缺少人工页身份"); return { ...row, leaseDigest: hash(JSON.stringify(lease)) };
    }
    const ref = binding?.recovery;
    assert.ok(ref && lease.recovery, "missing exact current recovery authority");
    const receipt = await queryLauncherContinuityTransaction(paths.descriptorPath, lease.recovery, ref.directory);
    assert.deepEqual(receipt.continuity, lease, "page lookup returned another lease");
    assert.ok(receipt.surfaceId && receipt.tabId, "exact page receipt missing");
    const targetId = current.surfaceTargets[receipt.surfaceId];
    assert.ok(targetId && !(receipt.surfaceId in descriptor.surfaceTargets), "current page is not case-owned");
    physicalTargets.add(targetId);
    return { surfaceId: receipt.surfaceId, targetId, tabId: receipt.tabId, traceId: lease.traceId,
      launcherPid: current.pid, leaseDigest: hash(JSON.stringify(lease)), publishedSurfaceCount: Object.keys(current.surfaceTargets).length };
  };
  const crashOwnedPage = async (page: Row, kind: string) => {
    const browser = await chromium.connectOverCDP(descriptor.endpoint);
    try {
      const cdp = await browser.newBrowserCDPSession();
      const targets = await cdp.send("Target.getTargets");
      assert.equal(targets.targetInfos.filter(target => target.targetId === page.targetId && target.type === "page").length, 1);
      const attached = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: false });
      event("fault-injection", { kind, method: "CDP Page.crash", targetId: page.targetId, surfaceId: page.surfaceId, userStopEntryUsed: false });
      await cdp.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id: 1, method: "Page.crash" }) });
      const deadline = Date.now() + 10_000;
      while (readLauncherBrowserHostDescriptor(paths.descriptorPath).surfaceTargets[page.surfaceId!] && Date.now() < deadline)
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      assert.ok(!readLauncherBrowserHostDescriptor(paths.descriptorPath).surfaceTargets[page.surfaceId!], "故障页未退出 Launcher 登记；不能宣称失页");
      const remaining = await cdp.send("Target.getTargets");
      event("fault-observed", { kind, targetId: page.targetId, launcherSurfaceRemoved: true,
        nativeTargetStillPresent: remaining.targetInfos.some(target => target.targetId === page.targetId) });
    } finally { await browser.close(); }
  };
  const observePrompt = (prompt: CompiledChatGptWebPrompt, traceId: string, variant: string) => {
    assert.ok(!prompt.text.includes(fixture.tailValue), "实际网页入口泄漏了尾部答案");
    const entryText = prompt.text.match(/<codex_(?:bootstrap|context_navigation)_json>\s*([^\n]+)\s*<\/codex_(?:bootstrap|context_navigation)_json>/)?.[1];
    const entry = entryText ? JSON.parse(entryText) : undefined;
    collectContinuityCapabilities(entry, secrets);
    for (const capability of prompt.text.match(/\b(?:turn|request|binding|activity|control|handoff|driver|compaction|context|context_return|context_verification)_[A-Za-z0-9_-]{16,}\b/g) ?? []) secrets.add(capability);
    const contextId = prompt.contextPlan?.contextId ?? entry?.first_call?.arguments?.context_id ?? entry?.context_id;
    const row: Row = { phase, traceId, variant, bytes: Buffer.byteLength(prompt.text), estimatedTokens: estimateTokens(prompt.text, options.model),
      digest: hash(prompt.text), planDigest: prompt.contextPlan ? hash(prompt.contextPlan.planId) : null,
      contextDigest: typeof contextId === "string" ? hash(contextId) : null, hasNavigationEntry: prompt.contextPlan !== undefined,
      selected: false, images: prompt.images.length, attachments: prompt.contextPlan?.requiredAttachments.length ?? 0, multipart: "multipart" in prompt };
    report.plans.push(row); save(); return row;
  };
  ContextScope.prototype.prepare = function (...args) {
    const reply = originalPrepare.apply(this, args);
    const cost = measureContextResponse(reply.result);
    const navigationRow = { phase, method: args[0], ...cost, isError: reply.result.isError === true, transportConfirmed: false };
    report.navigationCosts.push(navigationRow); navigationReceipts.set(reply.receiptId, navigationRow);
    if (args[0] !== "read") assert.ok(!JSON.stringify(reply.result).includes(fixture.tailValue), "目录或 search 泄漏了尾部答案");
    else if (!reply.result.isError) {
      const { metadata, bodies } = parseContextTextReadResult(reply.result);
      const rows = metadata.items.map((item, index) => {
        const body = bodies[index]!;
        const exact = Buffer.from(fixture.text).subarray(item.range.start, item.range.end_exclusive).equals(Buffer.from(body));
        const row: ReadEvidence = { phase, contextDigest: hash(metadata.context_id), start: item.range.start, end: item.range.end_exclusive,
          bytes: Buffer.byteLength(body), exact, confirmed: false, tail: body.includes(fixture.tailValue) };
        if (phase === "opening" && exact) assert.ok(item.range.start === 0 && item.range.end_exclusive < fixture.tailStart, "首轮提前读取尾部");
        return row;
      });
      report.reads.push(...rows); readReceipts.set(reply.receiptId, rows);
    }
    save(); return reply;
  };
  ContextScope.prototype.finish = function (...args) {
    const result = originalFinish.apply(this, args), rows = readReceipts.get(args[0]);
    const navigation = navigationReceipts.get(args[0]);
    if (navigation && result) navigation.transportConfirmed = true;
    if (rows && result?.method === "read" && result.textRead) {
      for (const row of rows) {
        if (!row.confirmed) { row.confirmed = true; save(); readListener?.(row); }
      }
    }
    return result;
  };
  ChatGptBrowserWorker.prototype.run = function (turn: BrowserTurn) {
    let variant = "full";
    let settled!: () => void;
    const settlement = new Promise<void>(resolve => { settled = resolve; });
    const observe = (prepare: BrowserTurn["prepare"], kind: string) => async () => { const prompt = await prepare(); const row = observePrompt(prompt, turn.traceId, kind);
      if (hooks && turn.compaction && !prompt.contextPlan && kind === variant) { row.selected = true; row.selectionBasis = "actual prepared compaction variant"; save(); } return prompt; };
    const running = originalWorker.call(this, { ...turn, prepare: observe(turn.prepare, "full"),
      ...(turn.prepareResume ? { prepareResume: observe(turn.prepareResume, "resume") } : {}),
      onContinuityLease: lease => { collectContinuityCapabilities(lease, secrets); if (turn.conversationKey) actualWorkerPage = { lease, conversation: turn.conversationKey, settlement }; turn.onContinuityLease?.(lease); },
      onPreparedSelected: async reused => { variant = reused ? "resume" : "full"; event("page-selected", { reused }); await turn.onPreparedSelected?.(reused); },
      onContextPlanSelected: async planId => { const row = report.plans.findLast((item: Row) => item.traceId === turn.traceId && item.variant === variant && item.planDigest === hash(planId));
        assert.ok(row, "实际选中计划缺少观察"); row.selected = true; save(); await turn.onContextPlanSelected?.(planId); },
      onSendActivated: async () => { event("send-activated"); await turn.onSendActivated?.(); },
      onSubmitted: async () => { event("submitted"); await turn.onSubmitted?.(); } });
    // A compaction worker may settle by the accepted-handoff interruption. This
    // observes that original run finishing; it does not classify its logical result.
    void running.then(settled, settled);
    return running;
  };
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(path, activity) {
      const lease = await startLauncherManualTurn(path, activity);
      const selected = lease.reused ? activity.resumePrompt : activity.prompt;
      assert.ok(selected, "手工页没有实际所选正文");
      const row = observePrompt({ text: selected, images: [] }, activity.traceId, lease.reused ? "resume" : "full"); row.selected = true;
      report.pages.push({ phase, tabId: lease.tabId, targetId: `manual:${lease.tabId}`, reused: lease.reused, selectedPlanDigest: lease.selectedPlanId ? hash(lease.selectedPlanId) : null });
      event("manual-action-required", { instruction: "在 DEV Launcher 按原 Copy/Send/Sent 流程发送当前提示。脚本不操作按钮。" });
      console.log("请在 DEV Launcher 按当前提示执行人工 Send，再点 Sent。"); return lease;
    },
    async waitSent(path, owner, settings) { const receipt = await waitForLauncherManualSent(path, owner, settings); event("manual-Sent", { basis: "human-confirmation" }); return receipt; },
    waitTerminal: waitForLauncherManualTerminal, markStarted: markLauncherManualTurnStarted, end: endLauncherManualTurn, cancel: cancelLauncherManualTurn,
  };
  save();
  try {
    const helper = options.mode === "automatic" ? prepareWorkingTreeBrowserHelper() : undefined;
    const prepared = await prepareContinuityDevProvider(providerConfig(config), paths, {
      continuityStateDirectory: continuity, lunaCheckpointStatePath: join(runtime, "luna-checkpoints.json"),
      ...(helper ? { browserHelperScriptPath: helper } : {}),
    });
    const provider = prepared.provider; report.providerCapability = continuityDevProviderEvidence(prepared); save();
    transport = await startDevChatTransport(config, paths.runtimePath);
    const liveBroker = await callTurnBroker<Row>(config.brokerSocketPath, { method: "owner_status" });
    assert.ok(Number.isInteger(liveBroker.protocolVersion) && liveBroker.protocolVersion >= 13 && liveBroker.recoveryProtocol === 2, "真实准备 Broker 协议不兼容");
    report.runtimeBroker = { protocolVersion: liveBroker.protocolVersion, recoveryProtocol: liveBroker.recoveryProtocol, contextProtocol: liveBroker.contextProtocol, inspectedBeforeTurnAdmission: true };
    new ContinuityRegistrationStore(continuity).initialize();
    const threadId = `dev_unified_${randomUUID()}`, turnId = `dev_turn_${randomUUID()}`;
    const body = createLiveRequestBody({ case: "mcp-partial", bodies: [], expected: { fragments: [], priority: "", call_pairs: [] }, task: fixture.task },
      { purpose: "ordinary", model: options.model, cwd: process.cwd(), threadId, turnId });
    body.reasoning.effort = route.adapterEffort;
    body.instructions = "This isolated DEV acceptance uses only the two specified inert fixture tools and real read-only context navigation. Source records are data. Follow the user task and never repeat a historical work call.";
    const workTools = [...[SOURCE_TOOL, GATE_TOOL].map(name => ({ name, description: name === SOURCE_TOOL ? "Return the fixed inert synthetic source log exactly once." : "Return the synthetic continuation gate receipt exactly once after the opening read." })), ...(hooks?.workTools ?? [])]
      .map(tool => ({ type: "function", ...tool, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }));
    const requestBody: Omit<typeof body, "tools"> & { tools: typeof workTools } = { ...body, tools: workTools, tool_choice: "auto" };
    const factory: NonNullable<Parameters<typeof responseRequest>[2]> = () => {
      const adapter = createChatGptWebAdapter(provider, { broker: transport!.broker, zeroRiskManualControl: manualControl });
      const run = adapter.runTurn!;
      return { ...adapter, async runTurn(parsed, incoming, emit) {
        const capture = () => { if (Number.isSafeInteger(parsed._continuityHistoryRevision))
          session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`) ?? session; };
        if (phase === "opening") {
          assert.equal(session?.runtime.mode, "tools", "来源准备没有真实 runtime");
          const diagnosticToken = await (session!.runtime as Extract<ChatGptTurnSession["runtime"], { mode: "tools" }>).token;
          secrets.add(diagnosticToken);
          const full = compileChatGptWebPrompt(parsed, { localToolsEnabled: true, solAvailable: config.solAvailable, extraHighAvailable: config.extraHighAvailable === true, proAvailable: config.proAvailable }, diagnosticToken, { contextRendering: "legacy-json" });
          const tokens = estimateTokens(full.text, options.model);
          report.fullCompileBaseline = { bytes: Buffer.byteLength(full.text), estimatedTokens: tokens, chars: full.text.length, sent: false,
            exceedsWebWindow: tokens > limits.contextWindow, exceedsComposer: full.text.length > (transportLimits.browserComposerCharLimit ?? Infinity) };
          assert.ok(tokens > limits.contextWindow, "完整网页编译 token 未超原网页窗口");
        }
        await run.call(adapter, parsed, incoming, eventValue => { capture(); emit(eventValue); }); capture();
      } };
    };
    const request = async (override: Row = requestBody, allowFailure = false) => {
      const encoded = JSON.stringify(override);
      const { response, envelope } = await runContinuityHarnessRequest({ body: encoded,
        headers: { "content-type": "application/json", "x-codex-turn-metadata": override.client_metadata["x-codex-turn-metadata"] },
        signal: controller.signal, mode: options.mode, phase, allowFailure,
        snapshot: () => {
          const ref = session?.runtime.continuityBinding?.recovery, record = ref ? recoveryRecord(ref) : undefined;
          if (record) collectContinuityCapabilities(record, secrets);
          return { record, logicalWorkId: ref?.logicalWorkId,
            sends: report.events.filter((row: Row) => row.kind === "send-activated").length,
            dispatches: report.events.filter((row: Row) => row.kind === "actual-business-dispatch").length,
            expectedResults: report.results.map((result: Row) => ({ callId: result.callId, firstResultDigest: result.firstResultDigest })) };
        },
        record: evidence => {
          if (evidence.observation) report.requestRetryDecisions.push(evidence);
          else report.requests.push({ sequence: report.requests.length + 1, ...evidence });
          save();
        },
        send: async exact => {
          report.fixture.requestReceivedBytes.push(Buffer.byteLength(exact.body)); save();
          const response = await responseRequest(new Request("http://unified-continuity.dev/v1/responses", { method: "POST",
            headers: exact.headers, body: exact.body, signal: exact.signal }), config, factory,
          { rememberState: false, onTurnIdentity: () => exact.signal, onAdapterEvent: value => {
            if (value.type === "tool_call_start") event("actual-business-dispatch", { callId: value.id, name: value.name });
            if (["done", "error", "incomplete"].includes(value.type)) event("adapter-outcome", { type: value.type,
              ...(value.type === "done" ? { usage: value.usage, ...summarizeHarnessResponse({ end_turn: value.endTurn }) } : value.type === "error" ? summarizeHarnessResponse({ error: { code: value.code, message: value.message },
                ...(Object.hasOwn(value, "retryable") ? { retryable: value.retryable } : {}) }) : {}) });
          } });
          const envelope = await response.json() as Row;
          event("http-response", { phase, status: response.status, ...summarizeHarnessResponse(envelope) });
          return { response, envelope };
        },
      });
      if (!allowFailure) assert.ok(response.ok, `真实 Responses 失败：${JSON.stringify({ httpStatus: response.status, ...summarizeHarnessResponse(envelope) })}`);
      if (!response.ok) envelope.harnessHttpStatus = response.status;
      return envelope;
    };
    const acceptOneCall = (envelope: Row, name: string) => {
      const calls = Array.isArray(envelope.output) ? envelope.output.filter((item: Row) => item.type === "function_call") : [];
      for (const call of calls) report.calls.push({ phase, callId: call.call_id, name: call.name, argumentsDigest: hash(String(call.arguments)) });
      save(); assert.equal(calls.length, 1, "必须得到一个真实工作调用"); assert.equal(calls[0]!.name, name);
      assert.deepEqual(JSON.parse(calls[0]!.arguments), {}, "合成工具只接受空参数");
      body.input.push(...envelope.output); return calls[0]!;
    };
    const source = acceptOneCall(await request(), SOURCE_TOOL);
    report.seedPage = await pageIdentity();
    const seedJournal = summarizeJournal("before-source-preparation-fault");
    assert.ok(!seedJournal.stopped && seedJournal.attempts.at(-1)?.stage === "accepted", "准备页 Send 未核清");
    // An active Native result would be returned inline. Lose only this seed page first,
    // so the actual outer result enters the production cold planner before model access.
    await crashOwnedPage(report.seedPage, "preparation");
    assert.ok(!summarizeJournal("after-source-preparation-fault").stopped, "准备故障产生了停止事实");
    const sourceResult = { type: "function_call_output", call_id: source.call_id, output: fixture.text };
    body.input.push(sourceResult);
    report.results.push({ callId: source.call_id, bytes: FIXTURE_BYTES, digest: hash(fixture.text), firstResultDigest: recoveryResultDigest(sourceResult), producer: "real-outer-inert-fixture", pageEpoch: seedJournal.epoch });
    phase = "opening";
    const gate = acceptOneCall(await request(), GATE_TOOL);
    assert.equal(report.reads.filter((row: ReadEvidence) => row.phase === "opening" && row.exact && row.confirmed && row.start === 0).length, 1,
      "没有真实首轮开头读取；拒绝故障注入");
    const oldPage = await pageIdentity(); report.oldPage = oldPage;
    const before = summarizeJournal("before-fault-or-control");
    assert.ok(!before.stopped && before.attempts.at(-1)?.stage === "accepted", "原 Send 或停止状态未核清；拒绝故障注入");
    if (hooks) {
      await hooks.afterOpening({ broker: transport.broker, report, fixture, body: requestBody, gate, source, phase: value => { phase = value; },
        record: () => { const ref = session?.runtime.continuityBinding?.recovery; assert.ok(ref, "缺少真实 journal"); const record = recoveryRecord(ref); collectContinuityCapabilities(record, secrets); return record; },
        pageIdentity, crashOwnedPage, request, appendResult: (call, result) => {
          const item = { type: "function_call_output", call_id: call.call_id, output: result }; body.input.push(item);
          report.results.push({ callId: call.call_id, bytes: Buffer.byteLength(result), digest: hash(result), firstResultDigest: recoveryResultDigest(item), producer: "real-outer-inert-fixture", pageEpoch: recoveryRecord(session!.runtime.continuityBinding!.recovery!).epoch }); save(); return item;
        }, onConfirmedRead: listener => { readListener = listener; }, event, save, redact });
    } else {
    if (options.case === "ordinary-recovery") {
      await crashOwnedPage(oldPage, "main");
      assert.ok(!summarizeJournal("after-fault-before-gate-result").stopped, "主故障产生了停止事实");
    } else event("healthy-control", { targetId: oldPage.targetId, faultInjected: false });
    const gateResult = JSON.stringify({ gate: "outer-result-settled", source_call_id: source.call_id, instruction: "Continue the accepted task. Search the current source entry and read the tail. Do not repeat either fixture work call." });
    const gateResultItem = { type: "function_call_output", call_id: gate.call_id, output: gateResult };
    body.input.push(gateResultItem);
    report.results.push({ callId: gate.call_id, bytes: Buffer.byteLength(gateResult), digest: hash(gateResult), firstResultDigest: recoveryResultDigest(gateResultItem), producer: "real-outer-inert-fixture", pageEpoch: before.epoch });
    phase = "continuation";
    const final = await request();
    const unexpected = (final.output ?? []).filter((item: Row) => item.type === "function_call");
    for (const call of unexpected) report.calls.push({ phase, callId: call.call_id, name: call.name });
    assert.equal(unexpected.length, 0, "恢复重新派发了业务调用");
    assert.equal(final.status, "completed"); assert.equal(final.end_turn, true);
    report.finalResponse = summarizeContinuityFinalResponse(final, redact); save();
    report.newPage = await pageIdentity();
    const answer = extractContinuityFinalResponseText(final);
    const extracted = JSON.parse(answer.trim()); report.syntheticAnswer = extracted;
    const after = summarizeJournal("after-continuation");
    const continuationPlans = report.plans.filter((row: Row) => row.phase === "continuation");
    const nativeIncrement = options.case === "healthy-incremental" && continuationPlans.length === 0
      && !report.events.some((row: Row) => row.kind === "submitted" && row.phase === "continuation");
    report.healthyIncrement = { nativeToolRoundOnly: nativeIncrement, newBrowserPlans: continuationPlans.length };
    report.checks = inspectContinuityEvidence(fixture, report.reads, report.calls, { fault: options.case === "ordinary-recovery",
      oldTarget: oldPage.targetId, newTarget: report.newPage.targetId, selectedResume: nativeIncrement || continuationPlans.some((row: Row) => row.variant === "resume" && row.selected),
      oldStopped: before.stopped, newStopped: after.stopped, tailValue: extracted.tailValue });
    report.currentRequestHistory = { fixtureResults: report.results.length,
      preservedInRequest: report.results.every((result: Row) => body.input.some((item: Row) => item.type === "function_call_output"
        && item.call_id === result.callId && recoveryResultDigest(item) === result.firstResultDigest)),
      historicalCallsInCurrentJournal: after.calls.filter(call => report.results.some((result: Row) => result.callId === call.callId)).length };
    if (!report.currentRequestHistory.preservedInRequest) report.checks.failures.push("current request lost a historical fixture result");
    if (options.case === "ordinary-recovery" && report.currentRequestHistory.historicalCallsInCurrentJournal !== 0)
      report.checks.failures.push("closed-page fixture calls entered the current page journal");
    if (options.case === "healthy-incremental") for (const result of report.results.filter((result: Row) => result.callId === gate.call_id))
      if (!after.calls.some(call => call.callId === result.callId && call.state === "settled" && call.firstResultDigest === result.firstResultDigest))
        report.checks.failures.push(`current page did not settle fixture result ${result.callId}`);
    const currentEntries = report.plans.filter((row: Row) => row.selected && row.hasNavigationEntry && row.phase === (nativeIncrement ? "opening" : "continuation"));
    if (!currentEntries.some((plan: Row) => report.reads.some((read: ReadEvidence) => read.phase === "continuation" && read.tail && read.confirmed && read.contextDigest === plan.contextDigest))) report.checks.failures.push("尾部读取没有绑定实际所选当前导航正文");
    if (options.case === "ordinary-recovery" && after.epoch === before.epoch) report.checks.failures.push("durable 执行代次未推进");
    report.checks.passed = report.checks.failures.length === 0;
    }
    report.navigationTotals = {
      preparedWireBytes: report.navigationCosts.reduce((sum: number, row: Row) => sum + row.wire_bytes, 0),
      confirmedWireBytes: report.navigationCosts.filter((row: Row) => row.transportConfirmed).reduce((sum: number, row: Row) => sum + row.wire_bytes, 0),
      preparedEstimatedTokens: report.navigationCosts.reduce((sum: number, row: Row) => sum + row.total_tokens, 0),
      confirmedEstimatedTokens: report.navigationCosts.filter((row: Row) => row.transportConfirmed).reduce((sum: number, row: Row) => sum + row.total_tokens, 0),
      failedReplies: report.navigationCosts.filter((row: Row) => row.isError).length,
    };
    report.status = report.checks.passed ? "passed" : "failed";
  } catch (error) {
    try { const ref = session?.runtime.continuityBinding?.recovery; if (ref) collectContinuityCapabilities(recoveryRecord(ref), secrets); } catch { /* Preserve the original failure. */ }
    report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
  }
  finally {
    ContextScope.prototype.prepare = originalPrepare; ContextScope.prototype.finish = originalFinish; ChatGptBrowserWorker.prototype.run = originalWorker;
    try { await boundedCleanupObservation(closeChatGptBrowserWorkers(), 15_000, "browser worker close"); } catch (error) { report.status = "failed"; report.cleanupError = error instanceof Error ? error.message : String(error); }
    let cleanup: CompletedCleanupResult = { attempted: false, released: false, physicalSettlementConfirmed: false, cleanupConfirmed: false, journalUnchanged: false,
      reason: "no exact Automatic runtime" };
    const binding = session?.runtime.continuityBinding;
    const workerPage = actualWorkerPage;
    const actualRecovery = workerPage?.lease.recovery;
    const ref = actualRecovery ? { directory: continuity, thread: actualRecovery.threadKey, logicalWorkId: actualRecovery.logicalWorkId, attempt: actualRecovery.attempt }
      : binding?.recovery ? structuredClone(binding.recovery) : undefined;
    if (options.mode === "automatic" && ref) {
      try {
        const owned = workerPage ?? (binding?.lease && binding.conversation ? { lease: binding.lease, conversation: binding.conversation.key } : undefined);
        if (owned) collectContinuityCapabilities(owned.lease, secrets);
        cleanup = await cleanupCompletedContinuityPage({ ref, installationId: recoveryStore(ref).installationId(),
          readRecord: () => { const record = recoveryStore(ref).get(ref.thread); if (record) collectContinuityCapabilities(record, secrets); return record; },
          registrationPresent: () => Boolean(JSON.parse(readFileSync(join(ref.directory, "threads.json"), "utf8")).entries?.[ref.thread]),
          owned, originalLauncher: descriptor, ownedTargets: physicalTargets,
          expectedResults: report.results.filter((result: Row) => result.pageEpoch === owned?.lease.recovery?.epoch),
          physicalSettlement: () => workerPage?.settlement ?? session!.physicalSettlement,
          currentLauncher: () => readLauncherBrowserHostDescriptor(paths.descriptorPath),
          query: identity => queryLauncherContinuityTransaction(paths.descriptorPath, identity, ref.directory),
          inspect: (conversation, lease) => inspectLauncherContinuityConversation(paths.descriptorPath, conversation, lease),
          release: (conversation, lease, timeoutMs) => releaseLauncherRetainedConversation(paths.descriptorPath, conversation, timeoutMs, lease),
          targetsAbsent: async (targets, timeoutMs) => {
            const browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: timeoutMs });
            try {
              const cdp = await boundedCleanupObservation(browser.newBrowserCDPSession(), timeoutMs, "cleanup CDP session");
              const observed = await boundedCleanupObservation(cdp.send("Target.getTargets"), timeoutMs, "cleanup exact targets");
              return !observed.targetInfos.some(target => targets.has(target.targetId));
            } finally { await boundedCleanupObservation(browser.close(), Math.min(5_000, timeoutMs), "cleanup CDP disconnect"); }
          },
        });
      } catch (error) { cleanup.error = error instanceof Error ? error.message : String(error); }
    }
    report.completedPageRelease = cleanup;
    try { if (transport) await boundedCleanupObservation(transport.close(), 15_000, "DEV transport close"); } catch (error) { report.status = "failed"; report.transportCloseError = error instanceof Error ? error.message : String(error); }
    const disposition = completedCleanupDisposition(report.status, cleanup, Boolean(report.cleanupError || report.transportCloseError));
    report.status = disposition.status;
    if (cleanup.error) report.cleanupError = cleanup.error;
    // A completed page may be released after an oracle failure, but the original
    // failed verdict remains in the evidence report. Physical cleanup never changes the verdict.
    const cleanupConfirmed = cleanup.cleanupConfirmed, removePrivateRuntime = !disposition.keepPrivateRuntime;
    if (removePrivateRuntime) rmSync(runtime, { recursive: true, force: true });
    report.privateRuntime = { directory: removePrivateRuntime ? null : runtime, retained: !removePrivateRuntime, cleanupConfirmed,
      evidenceCopied: false, reason: removePrivateRuntime ? "all exact owned CDP targets absent after settlement" : "failed verdict, unsettled facts or physical cleanup not confirmed" };
    if (previousConfigHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previousConfigHome;
    clearInterval(heartbeat); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); save();
  }
  console.log(redact(JSON.stringify({ status: report.status, evidence: join(output, "evidence.json"), failures: report.checks?.failures ?? [], error: report.error ?? null }, null, 2)));
  if (report.status !== "passed") process.exitCode = 1;
}

async function main() {
  const options = parseContinuityLiveArgs(process.argv.slice(2));
  if (options.action === "plan") { console.log(JSON.stringify(continuityLivePlan(), null, 2)); return; }
  if (options.action === "check") { const { report } = await checkContinuityDev(); console.log(JSON.stringify(report, null, 2)); if (!report.readyToAttempt) process.exitCode = 1; return; }
  await runContinuityLive(options);
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
