import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type CDPSession } from "playwright-core";
import { checkContinuityDev } from "./validate-unified-task-continuity";
import { providerConfig } from "../src/config";
import { prepareContinuityDevProvider, continuityDevProviderEvidence } from "./unified-task-continuity-dev-provider";
import { createLiveRequestBody } from "./validate-context-rendering";
import { extractContinuityFinalResponseText, summarizeContinuityFinalResponse } from "./unified-task-continuity-final-response";
import { prepareWorkingTreeBrowserHelper } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { chatGptTurnSessions, chatGptTurnExecutionKey, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { recoveryRecord, recoveryStore, recoveryResultDigest, acceptRecoveryResults, type RuntimeRecoveryReference } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { callTurnBroker, type TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { estimateTokens } from "../src/lib/token-estimate";
import { readLauncherBrowserHostDescriptor, inspectLauncherContinuityConversation, releaseLauncherRetainedConversation, retireLauncherContinuityWriter, queryLauncherContinuityTransaction } from "../src/launcher-browser-host";
import { responseRequest } from "../src/server";
import { RESOURCE_SYNTHETIC_INSTRUCTIONS, observeResourceBrokerControl, resourceResponseObservation,
  resourceSuccessorControlEvidence, resourceSuccessorRevisionEvidence, summarizeResourcePreparedProtocol, summarizeResourceTaskUpdateJournal } from "./unified-task-continuity-resource-control";

type Row = Record<string, any>;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const TOOL = "unified_resource_receipt";
export function redactResourceEvidence(value: string, secrets: readonly string[]) {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "[redacted]");
  return value.replace(/\b(?:turn|safe_turn|request|binding|activity|delivery|update|compaction|context_return|context_verification)_[A-Za-z0-9_-]{16,}\b/g, "[redacted-capability]");
}
export const RESOURCE_LIVE_CASES = ["five-page-pressure", "old-live-fencing", "user-close-stop"] as const;
/** A runTurn error is a failed Responses envelope even when its HTTP transport succeeded. */
export function inspectRejectedResourceAppend(response: Pick<Response, "ok" | "status">, envelope: Row) {
  const error = envelope.error;
  const code = error && typeof error === "object" && typeof error.code === "string" && error.code.trim() ? error.code : null;
  const output = Array.isArray(envelope.output) ? envelope.output : [];
  const completed = envelope.status === "completed" || envelope.end_turn === true || output.some((item: Row) =>
    ["function_call", "custom_tool_call", "tool_search_call", "compaction"].includes(item.type)
    // The production builder can emit completed assistant text without a phase
    // before a later error. Only explicit commentary is permitted here.
    || item.type === "message" && item.phase !== "commentary");
  const failedEnvelope = envelope.status === "failed" && Array.isArray(envelope.output);
  const httpError = !response.ok && (envelope.status === undefined || envelope.status === "failed");
  const rejected = !completed && code !== null && (httpError || response.status === 200 && failedEnvelope);
  return { rejected, code, representation: rejected ? httpError ? "http-error" : "failed-response" : null };
}
type LiveCase = typeof RESOURCE_LIVE_CASES[number];
type RunOptions = { action: "run"; case: LiveCase; mode: "automatic"; model: string; output?: string; launcherInspector?: string };
export const CLEANUP_HOLD_TTL_MS = 120_000;

export function resourceLivePlan() {
  return { schema: "unified-task-continuity-resource-plan/v1", spec: "v4", cases: RESOURCE_LIVE_CASES,
    default: "check-only; no broker startup, browser connection, Verify runtime or model send",
    runCommand: "bun run scripts/validate-unified-task-continuity-resources.ts run --case=five-page-pressure --mode=automatic --model=chatgpt-web/gpt-6-sol-instant",
    requirements: ["existing isolated Full Native Automatic DEV Launcher and tunnel", "current Verify runtime evidence", "Broker protocol >=13, recoveryProtocol=2; Launcher/helper executionProtocol=1", "no existing DEV task pages or active Broker: refuse rather than reclaim another task"],
    casesDetails: {
      "five-page-pressure": { expectedInitialModelSends: 6, expectedResponsesRequests: 12, tools: "one real model-dispatched inert receipt per task, then one real completion",
        steps: ["create five independent synthetic tasks sequentially; retain their healthy ready pages", "sixth allocation must destroy the earliest successful idle page before targetCreated", "observe CDP targetCreated/targetDestroyed from before first send through final cleanup", "re-read every completed journal after pressure and cleanup", "release only exact case-owned conversation leases"],
        boundary: "Requires a clean DEV task-page baseline; original home surface stays present. CDP covers native target existence, not platform activity." },
      "old-live-fencing": { expectedInitialModelSends: 2, expectedResponsesRequests: 3,
        steps: ["real model calls the inert receipt; capture original runtime and accepted Send", "same public Responses history returns the actual result and appends one real plain-text instruction", "when the model submits ACK, verify its deliveryId against the real Broker delivery and hold the request", "persist retireAttempt for that exact current original-page attempt, without page close or Broker revoke", "while the native target is still present, request original Broker Native tool, that real ACK and final-output admission", "release the held real model ACK into the original rejecting method", "retry the accepted appended public task; production recovery authorizes the successor", "optional exact target close-failure hold keeps original page present through real successor completion"],
        boundary: "Without --launcher-inspector the physical overlap may be partial. With the bounded exact-target hold, pass requires original target presence through successor completion, real pending ACK rejection, successor completion and real final cleanup. The injected close failures are labelled controlled DEV faults, never natural browser faults." },
      "user-close-stop": { expectedInitialModelSends: 1, expectedResponsesRequests: 2,
        steps: ["real model calls inert receipt; task remains running", "human closes only the named task tab using DEV Launcher UI", "observe persistent page-close stop", "return the real inert result, retry the same public task, observe rejection and no new target"],
        boundary: "No automated close, crash or signal substitutes for the human action; waits at most five minutes." },
    },
    cleanupHold: { optIn: "old-live-fencing only: --launcher-inspector=http://127.0.0.1:9239", ttlMs: CLEANUP_HOLD_TTL_MS,
      launchCommand: "CODEX_WEB_GPT_BUN=\"$(command -v bun)\" CODEX_CHATGPT_WEB_BUN=\"$(command -v bun)\" ./launcher/node_modules/.bin/electron --inspect=127.0.0.1:9239 ./launcher --dev-profile",
      authorization: "Root must first authorize any DEV Launcher replacement/startup and model sends. This script never starts/stops Launcher or opens inspector.",
      checks: ["inspector HTTP and WebSocket must both use 127.0.0.1 and the same port", "main-process PID, DEV profile and exact Launcher instance must match the live descriptor", "unique exact case-owned surface/target maps to one real webContents", "wrap only that object's close; throw a labelled real failure; never patch prototype/global close or return fake success"],
      restore: "TTL in Launcher restores the original method and makes one exact physical close; runner finally restores first and requests the original cleanup retry. Restoration does not clobber a newer method owner.",
      failure: "Identity mismatch, unsupported inspector evaluation or method property: refuse injection and sending continuation. No fallback to an unrelated target." },
    gaps: ["Zero Risk requires its original human Send/Sent flow; this script refuses automatic substitution", "Cleanup hold and real pending ACK flow are prepared but have not been executed; actual DEV behavior remains unverified"],
    evidence: ["source/helper digests, package/runtime versions, actual Broker/Launcher protocol", "native target and surface identities, monotonic event sequence and live counts", "work/attempt/revision, stop, terminal digest and real dispatch/result counts", "stale Broker call outcome codes; no tokens, page URLs/titles or personal content"],
    guarantee: "Only project dispatch and state are checked. Platform-owned activity and platform tokens remain unknown." };
}

export function parseResourceLiveArgs(args: string[]): { action: "check" | "plan" } | RunOptions {
  const [action = "check", ...options] = args;
  if (["check", "--check-only", "plan"].includes(action)) {
    if (options.length) throw new Error("check / plan 不接受参数");
    return { action: action === "plan" ? "plan" : "check" };
  }
  const keys = ["--case", "--mode", "--model", "--output", "--launcher-inspector"];
  const get = (key: string) => options.find(option => option.startsWith(`${key}=`))?.slice(key.length + 1);
  if (action !== "run" || options.some(option => !keys.some(key => option.startsWith(`${key}=`)))
    || keys.some(key => options.filter(option => option.startsWith(`${key}=`)).length > 1)
    || !RESOURCE_LIVE_CASES.includes(get("--case") as LiveCase) || !get("--model") || get("--mode") !== "automatic")
    throw new Error("显式 run 需要 --case=five-page-pressure|old-live-fencing|user-close-stop、--mode=automatic、--model=；Zero Risk 不代办 Send/Sent");
  if (get("--model")!.startsWith("chatgpt-web-continuity/")) throw new Error("旧模式名称已删除；请使用 chatgpt-web/ 名称");
  if (!get("--model")!.startsWith("chatgpt-web/")) throw new Error("仅支持常规 chatgpt-web/ DEV 路由");
  if (get("--output") === "") throw new Error("output 不能为空");
  const launcherInspector = get("--launcher-inspector");
  if (launcherInspector !== undefined) { validateInspectorEndpoint(launcherInspector); if (get("--case") !== "old-live-fencing") throw new Error("inspector 仅适用于 old-live-fencing"); }
  return { action: "run", case: get("--case") as LiveCase, mode: "automatic", model: get("--model")!, output: get("--output"), launcherInspector };
}

export function validateInspectorEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("inspector URL 无效"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("inspector 必须是 http://127.0.0.1:明确端口，且没有路径、凭据或查询");
  return url;
}

/** Returns source only. Nothing is evaluated during check/plan/import or local safety tests. */
export function cleanupHoldExpression(input: { key: string; descriptorPath: string; pid: number; instance: Row; surfaceId: string; targetId: string; ttlMs?: number }) {
  const settings = { ...input, ttlMs: input.ttlMs ?? CLEANUP_HOLD_TTL_MS };
  assert.ok(settings.ttlMs >= 1 && settings.ttlMs <= CLEANUP_HOLD_TTL_MS);
  return `(() => {
    const setting = ${JSON.stringify(settings)};
    const requireModule = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);
    if (!requireModule) throw new Error('main-module require unavailable');
    const descriptor = JSON.parse(requireModule('node:fs').readFileSync(setting.descriptorPath, 'utf8'));
    if (process.pid !== setting.pid || descriptor.pid !== setting.pid || descriptor.profile !== 'development'
      || ['instanceId', 'pid', 'startIdentity'].some(key => descriptor.launcherInstance?.[key] !== setting.instance[key])
      || descriptor.surfaceTargets[setting.surfaceId] !== setting.targetId) throw new Error('exact DEV identity mismatch');
    if (globalThis[setting.key]) throw new Error('cleanup hold already exists');
    const electron = requireModule('electron');
    const contents = electron.webContents.fromDevToolsTargetId(setting.targetId);
    if (!contents || contents.isDestroyed() || electron.webContents.getAllWebContents().filter(item => item === contents).length !== 1
      || contents.getOrCreateDevToolsTargetId() !== setting.targetId) throw new Error('exact target is unavailable');
    const ownProperty = Object.getOwnPropertyDescriptor(contents, 'close');
    if (ownProperty && ownProperty.configurable !== true) throw new Error('target close cannot be safely wrapped');
    const originalClose = contents.close;
    if (typeof originalClose !== 'function') throw new Error('target close missing');
    const state = { targetId: setting.targetId, installedAt: Date.now(), expiresAt: Date.now() + setting.ttlMs, intercepted: 0, restored: false, restoreReason: null, timer: null };
    const blockedClose = function() { state.intercepted++; throw new Error('controlled-unified-resource-target-close-failure'); };
    state.restore = (reason, release = false) => {
      if (state.restored) return { restored: true, targetId: state.targetId, intercepted: state.intercepted, reason: state.restoreReason };
      if (contents.close !== blockedClose) throw new Error('target close owner changed; refusing to overwrite');
      if (ownProperty) Object.defineProperty(contents, 'close', ownProperty); else delete contents.close;
      state.restored = true; state.restoreReason = reason; clearTimeout(state.timer);
      if (release && !contents.isDestroyed()) originalClose.call(contents);
      return { restored: true, targetId: state.targetId, intercepted: state.intercepted, reason };
    };
    Object.defineProperty(contents, 'close', { configurable: true, writable: true, value: blockedClose });
    state.timer = setTimeout(() => { try { state.restore('fixed-TTL', true); } catch { state.restoreReason = 'target-close-owner-changed'; } }, setting.ttlMs); state.timer.unref?.();
    globalThis[setting.key] = state;
    return { installed: true, targetId: state.targetId, expiresAt: state.expiresAt, ttlMs: setting.ttlMs };
  })()`;
}

class MainInspector {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: Row): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => { const reply = JSON.parse(String(event.data)) as Row; const wait = this.pending.get(reply.id); if (!wait) return;
      clearTimeout(wait.timer); this.pending.delete(reply.id); if (reply.error) wait.reject(new Error("Inspector 协议拒绝")); else wait.resolve(reply.result); });
    socket.addEventListener("close", () => { for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error("Inspector 已断开")); } this.pending.clear(); });
  }
  static async connect(endpoint: string) {
    const url = validateInspectorEndpoint(endpoint);
    const response = await fetch(new URL("json/list", url), { signal: AbortSignal.timeout(3_000), redirect: "error" }); assert.ok(response.ok, "Inspector 未就绪");
    const targets = await response.json() as Row[];
    const nodes = targets.filter(target => target.type === "node"); assert.equal(nodes.length, 1, "Inspector 必须唯一指向主进程");
    const websocket = new URL(nodes[0]!.webSocketDebuggerUrl);
    assert.ok(websocket.protocol === "ws:" && websocket.hostname === "127.0.0.1" && websocket.port === url.port && !websocket.username && !websocket.password && !websocket.search && !websocket.hash, "Inspector WebSocket 必须保持相同 loopback 端口");
    const socket = new WebSocket(websocket.href);
    await new Promise<void>((resolveOpen, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error("Inspector 连接超时")); }, 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Inspector 连接失败")); }, { once: true }); });
    return new MainInspector(socket);
  }
  async evaluate(expression: string): Promise<Row> {
    const id = ++this.nextId;
    const result = await new Promise<Row>((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Inspector 操作超时")); }, 3_000);
      this.pending.set(id, { resolve: resolveResult, reject, timer }); this.socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    assert.ok(!result.exceptionDetails, "Inspector 表达式拒绝；没有合法完成注入");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

export interface PhysicalEvent { sequence: number; kind: "baseline" | "created" | "destroyed" | "sample"; targetId?: string; task?: number; physicalCount: number }
/** taskRevision is durable logical acceptedTaskRevision; taskUpdates holds the separate protocol heads. */
export interface JournalEvidence { task: number; label: string; workDigest: string; epoch: number; historyRevision: number; taskRevision: number; state: string; stopReason: string | null; terminalDigest: string | null; terminalReceiptDigest: string | null; attempts: Array<{ attempt: number; epoch: number; stage: string; writerRetired: boolean }>; calls: Array<{ callId: string; state: string; firstResultDigest: string | null }>; taskUpdates?: ReturnType<typeof summarizeResourceTaskUpdateJournal> }
export function inspectResourcePressureEvidence(evidence: { events: PhysicalEvent[]; targets: string[]; journals: JournalEvidence[]; results: Array<{ task: number; callId: string; firstResultDigest: string }>; cleanupTargets: string[]; baselinePreserved: boolean }) {
  const failures: string[] = [];
  if (evidence.events.some(event => event.physicalCount > 5 || event.physicalCount < 0)) failures.push("真实任务页面数量超出五页上限");
  if (evidence.targets.length !== 6 || new Set(evidence.targets).size !== 6) failures.push("缺少六个独立真实页面身份");
  const createdSix = evidence.events.find(event => event.kind === "created" && event.targetId === evidence.targets[5]);
  const destroyedFirst = evidence.events.find(event => event.kind === "destroyed" && event.targetId === evidence.targets[0]);
  if (!createdSix || !destroyedFirst || destroyedFirst.sequence >= createdSix.sequence) failures.push("第六页创建之前没有确定旧页的真实销毁事件");
  if (!evidence.events.some(event => event.task === 5 && event.physicalCount === 5)) failures.push("没有保留前五个健康空闲页的压力观察");
  for (let task = 1; task <= 6; task++) {
    const before = evidence.journals.find(row => row.task === task && row.label === "completed");
    const after = evidence.journals.findLast(row => row.task === task && row.label === "after-cleanup");
    if (!before || !after || before.state !== "completed" || after.state !== "completed" || !before.terminalDigest || !before.terminalReceiptDigest
      || before.workDigest !== after.workDigest || before.terminalDigest !== after.terminalDigest || before.terminalReceiptDigest !== after.terminalReceiptDigest
      || before.historyRevision !== after.historyRevision || before.taskRevision !== after.taskRevision || before.epoch !== after.epoch
      || JSON.stringify(before.attempts) !== JSON.stringify(after.attempts) || JSON.stringify(before.calls) !== JSON.stringify(after.calls)) failures.push(`任务 ${task} 的 journal 终态或执行关系没有完整保留`);
    if (evidence.journals.filter(row => row.task === task).some(row => row.stopReason !== null || row.state === "stopped")) failures.push(`任务 ${task} 产生了非用户停止事实`);
    const result = evidence.results.filter(row => row.task === task);
    if (result.length !== 1 || !after || after.calls.length !== 1 || !after.calls.some(call => call.callId === result[0]?.callId && call.state === "settled" && call.firstResultDigest === result[0]?.firstResultDigest)) failures.push(`任务 ${task} 缺少唯一真实派发和结果结算`);
  }
  if (!evidence.baselinePreserved) failures.push("原有页面身份发生变化");
  if (new Set(evidence.cleanupTargets).size !== 5 || evidence.cleanupTargets.some(target => !evidence.targets.slice(1).includes(target))) failures.push("清理目标不是本 case 剩余的五个页面");
  if (evidence.events.at(-1)?.physicalCount !== 0) failures.push("case 页面尚未全部销毁");
  return { passed: failures.length === 0, failures };
}

export function inspectOldLiveFencingEvidence(evidence: { pending: { real: boolean; throughRevision: number; beforeAcknowledgedRevision: number; afterOldProbesAcknowledgedRevision: number };
  probes: Array<{ boundary: string; rejected: boolean; obsolete: boolean; presentBefore: boolean; presentAfter: boolean }>;
  successor: { originalTarget: string; target: string; oldPresentAtCompletion: boolean; revisions: ReturnType<typeof resourceSuccessorRevisionEvidence>; state: string; stopped: boolean; sameRetiredWork: boolean; historyPreserved: boolean; epochAdvanced: boolean };
  closeFault: { controlled: boolean; attempts: number; state: string } }) {
  const failures: string[] = [];
  if (!evidence.pending.real || evidence.pending.throughRevision <= evidence.pending.beforeAcknowledgedRevision
    || evidence.pending.afterOldProbesAcknowledgedRevision !== evidence.pending.beforeAcknowledgedRevision) failures.push("缺少真实 pending ACK，或旧 ACK 已越权推进");
  for (const boundary of ["tool", "ACK", "final"]) {
    const matches = evidence.probes.filter(row => row.boundary === boundary);
    if (matches.length !== 1 || !matches[0]!.rejected || !matches[0]!.obsolete || !matches[0]!.presentBefore || !matches[0]!.presentAfter) failures.push(`旧 ${boundary} 未在真实旧页存在时按代次拒绝`);
  }
  const next = evidence.successor;
  if (!next.originalTarget || !next.target || next.target === next.originalTarget || !next.oldPresentAtCompletion) failures.push("后继完成时没有真实新旧页面重叠");
  const revisions = next.revisions;
  if (!revisions || !Number.isSafeInteger(revisions.logicalWorkAcceptedTaskRevision) || revisions.logicalWorkAcceptedTaskRevision! <= 0
    || revisions.logicalWorkAcceptedTaskRevision !== revisions.retiredLogicalWorkAcceptedTaskRevision) failures.push("后继没有保留原逻辑工作 acceptedTaskRevision");
  if (!revisions || [revisions.connectorAcceptedRevision, revisions.connectorAcknowledgedRevision,
    revisions.protocolAcceptedRevision, revisions.protocolAcknowledgedRevision].some(revision => revision !== evidence.pending.throughRevision))
    failures.push("后继实际 ACK 与持久 task-update 协议 revision 不一致");
  if (next.state !== "completed" || next.stopped || !next.sameRetiredWork || !next.historyPreserved || !next.epochAdvanced) failures.push("后继任务关系、完成或停止状态不符合合同");
  if (!evidence.closeFault.controlled || evidence.closeFault.attempts !== 3 || evidence.closeFault.state !== "failed") failures.push("没有真实三次有界目标页清理故障");
  return { passed: failures.length === 0, failures };
}

/** Shared preflight is read-only. Add resource ownership checks without launching a runtime. */
export async function checkResourceDev() {
  const checked = await checkContinuityDev();
  const report = { ...checked.report, schema: "unified-task-continuity-resource-check/v1", blockers: [...checked.report.blockers] } as Row;
  if (report.config?.mode !== "automatic") report.blockers.push("本脚本需要当前 DEV Automatic 模式");
  if (checked.descriptor) {
    const taskSurfaces = Object.keys(checked.descriptor.surfaceTargets).filter(id => id !== checked.descriptor!.surfaceId);
    report.existingTaskSurfaceCount = taskSurfaces.length;
    if (taskSurfaces.length) report.blockers.push("DEV 已有任务页面；先由用户处理，脚本不会回收原页面");
    const rawDescriptor = JSON.parse(readFileSync(checked.paths.descriptorPath, "utf8")) as Row;
    report.launcher.executionProtocol = rawDescriptor.executionProtocol ?? null;
    if (rawDescriptor.executionProtocol !== 1) report.blockers.push("真实 Launcher 缺少 executionProtocol=1");
  }
  if (report.broker?.live) report.blockers.push("已有 Broker 活实例；本脚本需要独占空闲 DEV Broker 端点，不关闭其他实例");
  report.readyToAttempt = report.blockers.length === 0;
  return { ...checked, report };
}

function sourceEvidence() {
  const paths = ["src/adapters/chatgpt-web/index.ts", "src/adapters/chatgpt-web/turn-broker.ts", "src/adapters/chatgpt-web/prompt.ts", "src/adapters/chatgpt-web/mcp-server.ts",
    "src/adapters/chatgpt-web/continuity-recovery-store.ts", "src/adapters/chatgpt-web/browser-helper-main.ts", "launcher/electron/browser-host.cjs", "launcher/electron/continuity-execution-authority.cjs",
    "scripts/unified-task-continuity-resource-control.ts"];
  return { packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version, bunVersion: Bun.version,
    head: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    files: Object.fromEntries(paths.map(path => [path, digest(readFileSync(path))])), runnerDigest: digest(readFileSync(import.meta.path)) };
}

async function runResourceLive(options: RunOptions) {
  const checked = await checkResourceDev();
  assert.ok(checked.report.readyToAttempt, `DEV 未就绪：${checked.report.blockers.join("；")}`);
  const { config: optionalConfig, descriptor: optionalDescriptor, paths } = checked;
  const config = optionalConfig!, descriptor = optionalDescriptor!;
  const route = requireChatGptWebModelRoute(options.model, config);
  assert.equal(route.interactionMode, "automatic", "此路由不属于 Automatic Full Native 验收范围");
  const runId = `unified-resource-${options.case}-${randomUUID().slice(0, 8)}`;
  const output = resolve(options.output ?? join(".dev-workflows/unified-task-continuity/evidence/runs", runId));
  assert.ok(!existsSync(output), "证据目录已存在；使用新目录");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const privateRuntime = mkdtempSync(join(tmpdir(), "cgw-resource-"));
  const continuity = join(privateRuntime, "session-continuity");
  const report: Row = { schema: "unified-task-continuity-resource-live/v1", spec: "v4", runId, case: options.case, status: "running",
    startedAt: new Date().toISOString(), model: options.model, effort: route.adapterEffort, preflight: checked.report, source: sourceEvidence(),
    provenance: { adapter: "current-source", broker: "real-DEV", helper: "current-source", launcher: "real-DEV", simulatedPage: false, configChanged: false },
    events: [], pages: [], journal: [], calls: [], results: [], responses: [], probes: [], cleanupTargets: [], limitations: [], plans: [], sends: [], brokerControls: [],
    controlObservationBoundary: { brokerReturnObserved: true, mcpTransportObserved: false, modelReadConfirmed: false,
      limitation: "Broker return observations do not prove MCP serialization, transport or model reading. A real current-generation ACK remains mandatory." },
    privateRuntime: { directory: privateRuntime, retained: true, note: "private live authority journal; not a shareable evidence artifact" }, guarantee: resourceLivePlan().guarantee };
  const secrets = [config.controlToken, descriptor.control.token].filter(Boolean);
  const redact = (text: string) => redactResourceEvidence(text, secrets);
  const save = () => writeFileSync(join(output, "evidence.json"), redact(JSON.stringify(report, null, 2) + "\n"), { mode: 0o600 });
  const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = paths.home;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("验收进程被用户中止"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let task = 0, sequence = 0, cdp: CDPSession | undefined;
  let observationSequence = 0;
  const nextObservation = () => ++observationSequence;
  let transport: Awaited<ReturnType<typeof startDevChatTransport>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let inspector: MainInspector | undefined, cleanupHoldInstalled = false;
  const cleanupHoldKey = `__unifiedResourceCleanupHold_${runId.replaceAll("-", "_")}`;
  let heldPage: { targetId: string; recovery: NonNullable<NonNullable<ChatGptTurnSession["runtime"]["continuityBinding"]>["lease"]>["recovery"]; directory: string } | undefined;
  let restoreAck: (() => void) | undefined;
  let restoreControlObservation: (() => void) | undefined;
  let controlOrigin = "connector";
  const baselineTargets = new Set<string>(), physical = new Set<string>(), destroyed = new Set<string>();
  const owned: Array<{ task: number; targetId: string; surfaceId: string; session: ChatGptTurnSession; ref: RuntimeRecoveryReference }> = [];
  const originalWorkerRun = ChatGptBrowserWorker.prototype.run;
  ChatGptBrowserWorker.prototype.run = function (turn: BrowserTurn) {
    let selectedVariant: string | undefined;
    const identity = () => ({ traceDigest: digest(turn.traceId),
      ...(turn.continuity?.recovery ? { workDigest: digest(turn.continuity.recovery.logicalWorkId), epoch: turn.continuity.recovery.epoch,
        attempt: turn.continuity.recovery.attempt, transactionDigest: digest(turn.continuity.recovery.transactionId) } : {}) });
    const observe = (prepare: BrowserTurn["prepare"], variant: string) => async () => {
      const prompt = await prepare();
      report.plans.push({ task, ...identity(), observationSequence: nextObservation(), variant, selected: selectedVariant === variant, bytes: Buffer.byteLength(prompt.text), estimatedTokens: estimateTokens(prompt.text, options.model),
        digest: digest(prompt.text), images: prompt.images.length, attachments: prompt.contextPlan?.requiredAttachments.length ?? 0,
        protocol: summarizeResourcePreparedProtocol(prompt.text) }); save(); return prompt;
    };
    return originalWorkerRun.call(this, { ...turn, prepare: observe(turn.prepare, "full"), ...(turn.prepareResume ? { prepareResume: observe(turn.prepareResume, "resume") } : {}),
      onPreparedSelected: async reused => { await turn.onPreparedSelected?.(reused); selectedVariant = reused ? "resume" : "full"; const plan = report.plans.findLast((row: Row) => row.traceDigest === digest(turn.traceId) && row.variant === selectedVariant); if (plan) plan.selected = true; save(); },
      onSendActivated: async () => { await turn.onSendActivated?.(); report.sends.push({ task, ...identity(), observationSequence: nextObservation(), kind: "activated", at: new Date().toISOString() }); save(); },
      onSubmitted: async () => { await turn.onSubmitted?.(); report.sends.push({ task, ...identity(), observationSequence: nextObservation(), kind: "accepted-receipt", at: new Date().toISOString() }); save(); } });
  };
  const originalHelperCompatibility = LauncherBrowserHelperClient.prototype.assertContinuityCompatible;
  LauncherBrowserHelperClient.prototype.assertContinuityCompatible = async function (recovery = false) {
    await originalHelperCompatibility.call(this, recovery);
    const features = [...(this as unknown as { helperFeatures: Set<string> }).helperFeatures].sort();
    report.helper.handshakes.push({ task, at: new Date().toISOString(), recovery, features }); save();
  };
  const event = (kind: PhysicalEvent["kind"], targetId?: string) => { report.events.push({ sequence: ++sequence, at: new Date().toISOString(), kind, task, targetId, physicalCount: physical.size }); save(); };
  const journal = (item: typeof owned[number], label: string): JournalEvidence => {
    const record = recoveryRecord(item.ref), work = record.works[item.ref.logicalWorkId]!;
    for (const attempt of work.attempts) if (attempt.sendEvidence) secrets.push(attempt.sendEvidence.authorizationId);
    if (work.taskUpdateJournal) secrets.push(work.taskUpdateJournal.streamId, ...work.taskUpdateJournal.deliveries.map(delivery => delivery.deliveryId));
    const row: JournalEvidence = { task: item.task, label, workDigest: digest(work.logicalWorkId), epoch: record.epoch, historyRevision: record.historyRevision,
      taskRevision: work.acceptedTaskRevision, state: work.state, stopReason: work.stopReason ?? null, terminalDigest: work.terminalDigest ?? null,
      terminalReceiptDigest: work.terminalReceiptId ? digest(work.terminalReceiptId) : null,
      taskUpdates: summarizeResourceTaskUpdateJournal(work.taskUpdateJournal),
      attempts: work.attempts.map(attempt => ({ attempt: attempt.attempt, epoch: attempt.epoch, stage: attempt.stage, writerRetired: attempt.writerRetired })),
      calls: Object.values(record.calls).map(call => ({ callId: call.callId, state: call.state, firstResultDigest: call.firstResultDigest ?? null })) };
    report.journal.push(row); save(); return row;
  };
  const sameLauncher = () => { const current = readLauncherBrowserHostDescriptor(paths.descriptorPath); assert.equal(current.pid, descriptor.pid); assert.deepEqual(current.launcherInstance, descriptor.launcherInstance); return current; };
  const heartbeat = setInterval(() => console.log(`真实资源验收：${options.case}；任务 ${task}；物理任务页 ${physical.size}。`), 30_000);
  heartbeat.unref();
  save();
  try {
    const helper = prepareWorkingTreeBrowserHelper(); assert.ok(helper, "当前源码 helper 构建入口不存在");
    const prepared = await prepareContinuityDevProvider(providerConfig(config), paths, {
      continuityStateDirectory: continuity, lunaCheckpointStatePath: join(privateRuntime, "luna-checkpoints.json"), browserHelperScriptPath: helper,
    });
    const provider = prepared.provider; report.providerVerification = continuityDevProviderEvidence(prepared); save();
    transport = await startDevChatTransport(config, paths.runtimePath);
    const status = await callTurnBroker<Row>(config.brokerSocketPath, { method: "owner_status" });
    assert.ok(status.protocolVersion >= 13 && status.recoveryProtocol === 2, "真实 Broker 缺少 protocol13/recovery2");
    report.runtimeBroker = { protocolVersion: status.protocolVersion, recoveryProtocol: status.recoveryProtocol, contextProtocol: status.contextProtocol, ownerDigest: digest(String(status.owner)), inspectedBeforeSend: true };
    report.acknowledgements = [];
    restoreControlObservation = observeResourceBrokerControl(transport.broker, row => {
      report.brokerControls.push({ ...row, at: new Date().toISOString() });
      if (row.methodBoundary === "broker-ack-method" && ["broker-returned", "broker-rejected"].includes(row.stage)) {
        report.acknowledgements.push({ ...row, accepted: row.stage === "broker-returned" });
      }
      save();
    }, value => secrets.push(value), () => ({ task, origin: controlOrigin }), nextObservation);
    new ContinuityRegistrationStore(continuity).initialize();
    report.helper = { digest: digest(readFileSync(helper)), handshakes: [] };
    browser = await chromium.connectOverCDP(descriptor.endpoint);
    cdp = await browser.newBrowserCDPSession();
    for (const target of (await cdp.send("Target.getTargets")).targetInfos) baselineTargets.add(target.targetId);
    cdp.on("Target.targetCreated", ({ targetInfo }) => { if (targetInfo.type !== "page" || baselineTargets.has(targetInfo.targetId)) return; physical.add(targetInfo.targetId); event("created", targetInfo.targetId); });
    cdp.on("Target.targetDestroyed", ({ targetId }) => { if (physical.delete(targetId)) { destroyed.add(targetId); event("destroyed", targetId); } });
    await cdp.send("Target.setDiscoverTargets", { discover: true }); event("baseline");
    if (options.launcherInspector) {
      inspector = await MainInspector.connect(options.launcherInspector);
      const processIdentity = await inspector.evaluate(`(() => {
        const requireModule = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);
        if (!requireModule) throw new Error('main require unavailable');
        const descriptor = JSON.parse(requireModule('node:fs').readFileSync(${JSON.stringify(paths.descriptorPath)}, 'utf8'));
        return { pid: process.pid, electronVersion: process.versions.electron, profile: descriptor.profile, launcherInstance: descriptor.launcherInstance };
      })()`);
      assert.equal(processIdentity.pid, descriptor.pid); assert.equal(processIdentity.profile, "development"); assert.deepEqual(processIdentity.launcherInstance, descriptor.launcherInstance);
      report.inspector = { mainPid: processIdentity.pid, electronVersion: processIdentity.electronVersion, launcherInstanceDigest: digest(JSON.stringify(processIdentity.launcherInstance)), loopbackOnly: true };
    }
    const count = options.case === "five-page-pressure" ? 6 : 1;
    for (task = 1; task <= count; task++) {
      const turnId = `dev_resource_turn_${randomUUID()}`, threadId = `dev_resource_thread_${randomUUID()}`;
      const receipt = `RESOURCE_RECEIPT_${task}`, answer = `RESOURCEDONE${task}`;
      const seed = createLiveRequestBody({ case: "mcp-partial", bodies: [], expected: { fragments: [], priority: "", call_pairs: [] },
        task: `This is an isolated synthetic DEV task. Invoke ${TOOL} exactly once with {}. Wait for its actual outer result. Then complete with the exact text ${answer}. Use no other work tool. Never read files or run commands.` },
      { purpose: "ordinary", model: options.model, cwd: process.cwd(), threadId, turnId });
      const body = { ...seed, instructions: RESOURCE_SYNTHETIC_INSTRUCTIONS,
        tools: [{ type: "function", name: TOOL, description: "Return an inert fixed receipt from the outer test runner exactly once.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }], tool_choice: "auto" };
      let session: ChatGptTurnSession | undefined;
      const factory: NonNullable<Parameters<typeof responseRequest>[2]> = () => {
        const adapter = createChatGptWebAdapter(provider, { broker: transport!.broker }), run = adapter.runTurn!;
        return { ...adapter, async runTurn(parsed, incoming, emit) { const capture = () => { if (Number.isSafeInteger(parsed._continuityHistoryRevision)) session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`) ?? session; };
          await run.call(adapter, parsed, incoming, value => { capture(); emit(value); }); capture(); } };
      };
      const request = async () => { const encoded = JSON.stringify(body); const response = await responseRequest(new Request("http://unified-resource.dev/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": body.client_metadata["x-codex-turn-metadata"] }, body: encoded, signal: controller.signal }), config, factory,
      { rememberState: false, onTurnIdentity: () => controller.signal }); const envelope = await response.json() as Row;
        report.responses.push({ task, requestNumber: report.responses.length + 1, ...resourceResponseObservation(encoded, response, envelope) }); save(); return { response, envelope }; };
      const first = await request(); assert.ok(first.response.ok, "首轮真实 Responses 失败");
      const calls = (first.envelope.output ?? []).filter((item: Row) => item.type === "function_call");
      assert.equal(calls.length, 1); assert.equal(calls[0].name, TOOL); assert.deepEqual(JSON.parse(calls[0].arguments), {});
      report.calls.push({ task, callId: calls[0].call_id, name: TOOL, argumentsDigest: digest(calls[0].arguments) });
      assert.ok(session?.runtime.continuityBinding?.recovery && session.runtime.continuityBinding.lease && session.runtime.continuityBinding.conversation, "真实 runtime 缺少任务和页面绑定");
      const current = sameLauncher(), known = new Set(owned.map(item => item.surfaceId));
      const added = Object.entries(current.surfaceTargets).filter(([surfaceId]) => surfaceId !== descriptor.surfaceId && !known.has(surfaceId));
      assert.equal(added.length, 1, "不能唯一识别新页面；停止后续发送");
      const [surfaceId, targetId] = added[0]!;
      const item = { task, surfaceId, targetId, session, ref: structuredClone(session.runtime.continuityBinding.recovery) }; owned.push(item);
      report.pages.push({ task, surfaceId, targetId, launcherPid: descriptor.pid, leaseDigest: digest(JSON.stringify(session.runtime.continuityBinding.lease)) });
      const before = journal(item, "before-result"); assert.equal(before.attempts.at(-1)?.stage, "accepted"); assert.equal(before.stopReason, null);
      body.input.push(...first.envelope.output);
      const result = { type: "function_call_output", call_id: calls[0].call_id, output: receipt };
      report.results.push({ task, callId: result.call_id, firstResultDigest: recoveryResultDigest(result), bytes: Buffer.byteLength(receipt), producer: "real-inert-outer-runner" });
      if (options.case === "old-live-fencing") {
        assert.equal(session.runtime.mode, "tools");
        const token = await (session.runtime as Extract<ChatGptTurnSession["runtime"], { mode: "tools" }>).token; secrets.push(token);
        report.originalBrokerTokenDigest = digest(token);
        const originalAck = transport.broker.acknowledgeTaskUpdate;
        let ackCaptured = false;
        // Hold the actual model ACK before its original commit. Socket handling awaits this
        // Promise; the production method remains the authority and supplies every outcome.
        const heldAck = async (requestToken: string, deliveryId: string, throughRevision: number, contract: "native" | "safe") => {
          if (requestToken !== token || ackCaptured) return originalAck.call(transport!.broker, requestToken, deliveryId, throughRevision, contract);
          ackCaptured = true; secrets.push(deliveryId);
          const channels = (transport!.broker as unknown as { channels: Map<string, { taskUpdates?: { deliveries: Map<string, Row>; state: Row } }> }).channels;
          const delivery = channels.get(token)?.taskUpdates?.deliveries.get(deliveryId);
          const state = channels.get(token)?.taskUpdates?.state;
          assert.ok(delivery && state && delivery.throughRevision === throughRevision && delivery.fromRevision === state.acknowledgedRevision + 1
            && state.acceptedRevision === throughRevision && state.deliveredRevision === throughRevision, "没有真实已接受且待 ACK 的连续 delivery");
          report.pendingUpdate = { provenance: "real-public-Responses-append-and-model-ACK", deliveryDigest: digest(deliveryId), fromRevision: delivery.fromRevision,
            throughRevision, acceptedRevision: state.acceptedRevision, acknowledgedRevision: state.acknowledgedRevision, driverGeneration: state.driverGeneration };
          assert.ok(session!.runtime.continuityBinding?.recovery, "追加后缺少真实 current attempt");
          item.ref = structuredClone(session!.runtime.continuityBinding.recovery);
          const pageRecovery = session!.runtime.continuityBinding.lease?.recovery;
          assert.ok(pageRecovery, "旧页面没有精确物理恢复身份");
          if (inspector) {
            const installed = await inspector.evaluate(cleanupHoldExpression({ key: cleanupHoldKey, descriptorPath: paths.descriptorPath, pid: descriptor.pid,
              instance: descriptor.launcherInstance!, surfaceId, targetId }));
            assert.ok(installed.installed && installed.targetId === targetId); cleanupHoldInstalled = true;
            heldPage = { targetId, recovery: structuredClone(pageRecovery), directory: item.ref.directory };
            report.cleanupHold = { ...installed, controlledFault: true, naturalBrowserFault: false };
          }
          const present = (await cdp!.send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId); assert.ok(present, "原页已经消失");
          const record = recoveryRecord(item.ref);
          recoveryStore(item.ref).retireAttempt(item.ref.thread, { scope: record.scope, expectedVersion: record.version }, item.ref.logicalWorkId, item.ref.attempt);
          report.retiredAttempt = journal(item, "durably-retired-with-real-pending-ACK");
          const attempts = [
            { boundary: "tool", request: { method: "native_operation_start" as const, token, contract: "native" as const, nativeWaitProtocol: 1, taskUpdateProtocol: 1,
              operationId: 9000001, taskRevision: state.acceptedRevision, entry: "codex_tool_call" as const, nativeInput: { wire_name: TOOL, arguments: {} }, waitMs: 1 } },
            { boundary: "ACK", request: { method: "task_update_ack" as const, token, contract: "native" as const, taskUpdateProtocol: 1, deliveryId, throughRevision } },
            { boundary: "final", request: { method: "owner_final_output_begin" as const, token, ownerContext: { expectedDriverGeneration: state.driverGeneration,
              taskRevision: state.acceptedRevision, acknowledgedRevision: state.acknowledgedRevision } } },
          ];
          for (const probe of attempts) {
            const presentBefore = (await cdp!.send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId); assert.ok(presentBefore);
            let rejected = false, code: string | null = null, obsolete = false;
            controlOrigin = "obsolete-runner-probe";
            try { await callTurnBroker(config.brokerSocketPath, probe.request, 3_000); }
            catch (error) { rejected = true; code = String((error as Row).code ?? "unknown"); obsolete = /obsolete execution/.test(error instanceof Error ? error.message : String(error)); }
            finally { controlOrigin = "connector"; }
            const presentAfter = (await cdp!.send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId);
            report.probes.push({ boundary: probe.boundary, rejected, code, obsolete, originalTargetPresentBefore: presentBefore, originalTargetPresentAfter: presentAfter,
              ...(probe.boundary === "ACK" ? { deliveryDigest: digest(deliveryId), throughRevision, realPendingDelivery: true } : {}) }); save();
            assert.ok(rejected && obsolete && presentAfter, "真实旧 Broker 未按原执行代次拒绝，或旧页已消失");
          }
          const afterProbes = await callTurnBroker<Row>(config.brokerSocketPath, { method: "owner_task_update_state", token });
          report.pendingUpdate.afterOldProbesAcknowledgedRevision = afterProbes.state.acknowledgedRevision;
          assert.equal(afterProbes.state.acknowledgedRevision, state.acknowledgedRevision, "旧 ACK 越权推进了任务确认");
          report.realAckReleasedIntoRetiredAttempt = true; save();
          try { return originalAck.call(transport!.broker, requestToken, deliveryId, throughRevision, contract); }
          catch (error) {
            report.realAckRejection = { rejected: true, code: typeof (error as Row).code === "string" ? (error as Row).code : null }; save();
            throw error;
          }
        };
        transport.broker.acknowledgeTaskUpdate = heldAck as unknown as TurnBroker["acknowledgeTaskUpdate"];
        restoreAck = () => { if (transport) transport.broker.acknowledgeTaskUpdate = originalAck; };
        body.input.push(result, { type: "message", id: `msg_resource_append_${turnId}`, role: "user",
          content: [{ type: "input_text", text: `Accepted update: the actual receipt has returned; never repeat any business operation. Before completing with ${answer}, obtain and ACK the actual pending delivery under the current task-updates-v1 contract. If no current control envelope is available, use the public read-only codex_tool_inventory schema with a new operation_id and the exact acknowledged task_revision explicitly supplied by the current task contract or Broker ACK reply. Use only the actual returned delivery_id and through_revision with the current capability. Wait only for original operations under their original identities. Read and process every next delivery before the final answer. Never invent IDs or revisions, reuse a historical delivery on a successor, or repeat business work to obtain a control envelope.` }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId } });
        const rejectedAppend = await request();
        restoreAck(); restoreAck = undefined;
        assert.ok(ackCaptured && report.realAckReleasedIntoRetiredAttempt && report.probes.length === 3, "真实追加没有到达模型 ACK 或撤权检查未完成");
        assert.ok(report.realAckRejection?.rejected && report.realAckRejection.code === "continuity_source_unproven", "真实旧模型 ACK 未被原代次权限明确拒绝");
        report.rejectedAppend = inspectRejectedResourceAppend(rejectedAppend.response, rejectedAppend.envelope); save();
        assert.ok(report.rejectedAppend.rejected, "旧已撤权执行不应合法完成追加回复");
        const settled = journal(item, "after-held-model-ACK-rejection");
        assert.ok(settled.calls.every(call => call.state === "settled"), "真实追加结果没有结算");
        if (!inspector) report.limitations.push("没有受控物理清理 hold；原页存在时撤权及拒绝已观测，但后继继续时的旧页重叠需要单独证明。");
      }
      if (options.case === "user-close-stop") {
        console.log(`人工步骤：在 DEV Launcher 关闭本任务标签页。task=${task} surfaceId=${surfaceId} targetId=${targetId}。不要关闭其他页。脚本等待持久 page-close 停止。`);
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline && !controller.signal.aborted && recoveryRecord(item.ref).works[item.ref.logicalWorkId]!.state !== "stopped") await Bun.sleep(250);
        const stopped = journal(item, "after-human-close"); assert.equal(stopped.state, "stopped"); assert.equal(stopped.stopReason, "page-close");
        acceptRecoveryResults(item.ref, [result]); body.input.push(result);
        const targetsBefore = report.events.filter((row: PhysicalEvent) => row.kind === "created").length;
        const retry = await request(); const after = journal(item, "after-stop-retry");
        assert.equal(after.state, "stopped"); assert.equal(after.stopReason, "page-close");
        assert.ok(!retry.response.ok && /stopped/.test(String(retry.envelope.error?.code ?? "")), "同一停止工作没有明确拒绝重试");
        assert.equal(report.events.filter((row: PhysicalEvent) => row.kind === "created").length, targetsBefore, "停止工作重试创建了新页");
        report.status = "passed"; break;
      }
      if (options.case !== "old-live-fencing") body.input.push(result);
      const final = await request(); assert.ok(final.response.ok); assert.equal(final.envelope.status, "completed"); assert.equal(final.envelope.end_turn, true);
      assert.equal((final.envelope.output ?? []).filter((value: Row) => value.type === "function_call").length, 0, "重复派发了业务工具");
      report.responses.at(-1).finalResponse = summarizeContinuityFinalResponse(final.envelope, redact); save();
      const text = extractContinuityFinalResponseText(final.envelope).trim();
      assert.equal(text, answer); report.responses.at(-1).answerDigest = digest(text);
      if (options.case === "old-live-fencing") {
        const replacement = Object.entries(sameLauncher().surfaceTargets).filter(([id]) => id !== descriptor.surfaceId && id !== surfaceId);
        assert.equal(replacement.length, 1); assert.notEqual(replacement[0]![1], targetId);
        item.surfaceId = replacement[0]![0]; item.targetId = replacement[0]![1]; item.session = session!; item.ref = structuredClone(session!.runtime.continuityBinding!.recovery!);
        report.successor = { targetId: item.targetId, surfaceId: item.surfaceId, oldTargetStillPresent: (await cdp.send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId) };
        const finalAttempt = recoveryRecord(item.ref).works[item.ref.logicalWorkId]!.attempts.find(attempt => attempt.attempt === item.ref.attempt);
        assert.ok(finalAttempt && item.session.traceId && item.session.runtime.mode === "tools", "最终后继缺少准确物理执行身份");
        const finalToken = await item.session.runtime.token; secrets.push(finalToken);
        const finalIdentity = { workDigest: digest(item.ref.logicalWorkId), traceDigest: digest(item.session.traceId), tokenDigest: digest(finalToken),
          attempt: item.ref.attempt, epoch: finalAttempt.epoch };
        assert.equal(finalIdentity.workDigest, report.retiredAttempt.workDigest); assert.ok(finalIdentity.epoch > report.retiredAttempt.epoch);
        report.successor.finalIdentity = finalIdentity;
        const sameFinalIdentity = (row: Row) => row.workDigest === finalIdentity.workDigest && row.traceDigest === finalIdentity.traceDigest
          && row.epoch === finalIdentity.epoch && row.attempt === finalIdentity.attempt;
        const selected = report.plans.findLast((row: Row) => row.selected && sameFinalIdentity(row));
        const acceptedSend = report.sends.findLast((row: Row) => row.kind === "accepted-receipt" && sameFinalIdentity(row));
        report.successor.controlEvidence = resourceSuccessorControlEvidence(report.brokerControls, report.originalBrokerTokenDigest,
          report.pendingUpdate.throughRevision, finalIdentity, selected, acceptedSend);
        report.successor.pendingUpdateAcknowledged = report.acknowledgements.some((row: Row) => row.accepted && row.origin === "connector"
          && sameFinalIdentity(row) && row.tokenDigest === finalIdentity.tokenDigest && row.deliveryDigest === report.successor.controlEvidence.deliveryDigest
          && row.acknowledgedRevision === report.pendingUpdate.throughRevision);
        report.successor.preparedProtocolVerified = Boolean(selected?.protocol.unique && selected.protocol.protocol === "task-updates-v1"
          && selected.protocol.initialAcceptedRevision === report.pendingUpdate.throughRevision
          && selected.protocol.initialAcknowledgedRevision === report.pendingUpdate.acknowledgedRevision && selected.protocol.instructionsPresent
          && report.successor.controlEvidence.preparedSendBound);
        assert.ok(report.successor.controlEvidence.passed && report.successor.preparedProtocolVerified, "后继缺少准确 prepared 协议或实际新代 control delivery/ACK 证据");
        if (!report.successor.pendingUpdateAcknowledged) report.limitations.push("后继没有可核对的原待 ACK 更新确认；仅完成回答不能证明未 ACK 更新移交通过。");
        if (inspector && heldPage) {
          const deadline = Date.now() + 20_000;
          let receipt: Awaited<ReturnType<typeof queryLauncherContinuityTransaction>>;
          do { receipt = await queryLauncherContinuityTransaction(paths.descriptorPath, heldPage.recovery!, heldPage.directory);
            if (receipt.physicalCleanup === "failed") break; await Bun.sleep(100);
          } while (Date.now() < deadline);
          report.cleanupHold.beforeRestoration = { physicalCleanup: receipt.physicalCleanup, executionIsolated: receipt.executionIsolated,
            cleanup: (receipt.cleanup ?? []).map(row => ({ state: row.state, attempts: row.attempts, physicalPageId: row.physicalPageId })) };
          assert.ok(receipt.physicalCleanup === "failed" && receipt.cleanup?.some(row => row.attempts === 3), "没有观察到真实三次有界目标清理失败");
          assert.ok((await cdp.send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId), "原页在后继完成后已不再存在");
        }
      }
      const done = journal(item, "completed"); assert.equal(done.state, "completed"); assert.equal(done.calls.length, 1);
      if (options.case === "old-live-fencing" && inspector) {
        const finalIdentity = report.successor.finalIdentity;
        const newAck = report.acknowledgements.findLast((row: Row) => row.accepted && row.origin === "connector" && row.workDigest === finalIdentity.workDigest
          && row.traceDigest === finalIdentity.traceDigest && row.attempt === finalIdentity.attempt && row.epoch === finalIdentity.epoch
          && row.tokenDigest === finalIdentity.tokenDigest && row.deliveryDigest === report.successor.controlEvidence.deliveryDigest);
        report.successor.revisions = resourceSuccessorRevisionEvidence(done.taskRevision, report.retiredAttempt.taskRevision, done.taskUpdates, newAck);
        report.checks = inspectOldLiveFencingEvidence({ pending: { real: report.pendingUpdate.provenance === "real-public-Responses-append-and-model-ACK",
          throughRevision: report.pendingUpdate.throughRevision, beforeAcknowledgedRevision: report.pendingUpdate.acknowledgedRevision,
          afterOldProbesAcknowledgedRevision: report.pendingUpdate.afterOldProbesAcknowledgedRevision },
          probes: report.probes.map((row: Row) => ({ boundary: row.boundary, rejected: row.rejected, obsolete: row.obsolete, presentBefore: row.originalTargetPresentBefore, presentAfter: row.originalTargetPresentAfter })),
          successor: { originalTarget: targetId, target: item.targetId, oldPresentAtCompletion: report.successor.oldTargetStillPresent, revisions: report.successor.revisions,
            state: done.state, stopped: done.stopReason !== null, sameRetiredWork: done.workDigest === report.retiredAttempt.workDigest,
            historyPreserved: done.historyRevision === report.retiredAttempt.historyRevision, epochAdvanced: done.epoch > report.retiredAttempt.epoch },
          closeFault: { controlled: report.cleanupHold.controlledFault, state: report.cleanupHold.beforeRestoration.physicalCleanup,
            attempts: Math.max(0, ...report.cleanupHold.beforeRestoration.cleanup.map((row: Row) => row.attempts)) } });
      }
      const binding = item.session.runtime.continuityBinding!;
      assert.equal((await inspectLauncherContinuityConversation(paths.descriptorPath, binding.conversation!.key, binding.lease!)).state, "ready");
      event("sample");
      if (options.case === "five-page-pressure") assert.equal(physical.size, Math.min(task, 5), "健康空闲页没有按预期保留");
    }
    if (options.case === "old-live-fencing") report.status = inspector ? (report.checks?.passed ? "passed" : "failed") : "partial";
  } catch (error) { report.status = "failed"; report.error = redact(error instanceof Error ? error.message : String(error)); }
  finally {
    restoreAck?.();
    restoreControlObservation?.();
    if (cleanupHoldInstalled && inspector && heldPage) {
      try {
        report.cleanupHold.restoration = await inspector.evaluate(`(() => { const result = globalThis[${JSON.stringify(cleanupHoldKey)}].restore('runner-finally', false); delete globalThis[${JSON.stringify(cleanupHoldKey)}]; return result; })()`);
        const cleanupDescriptor = sameLauncher();
        const response = await fetch(`${cleanupDescriptor.control.endpoint}/v1/turn/continuity-cleanup`, { method: "POST",
          headers: { authorization: `Bearer ${cleanupDescriptor.control.token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ recovery: heldPage.recovery, recoveryStoreDirectory: heldPage.directory, cleanupRequestId: `resource-cleanup-${randomUUID()}` }) });
        const receipt = await response.json() as Row; assert.ok(response.ok && receipt.executionProtocol === 1, "精确原清理事务重试失败");
        report.cleanupHold.cleanupReceipt = { physicalCleanup: receipt.physicalCleanup, cleanup: (receipt.cleanup ?? []).map((row: Row) => ({ state: row.state, attempts: row.attempts, physicalPageId: row.physicalPageId })) };
        report.cleanupTargets.push(heldPage.targetId);
      } catch (error) { report.status = "failed"; report.limitations.push(`目标页 hold 恢复或清理失败：${redact(error instanceof Error ? error.message : String(error))}`); }
    }
    for (const item of owned) {
      try {
        if (destroyed.has(item.targetId)) continue;
        const binding = item.session.runtime.continuityBinding!;
        const record = recoveryRecord(item.ref), work = record.works[item.ref.logicalWorkId]!;
        if (work.state === "completed") await releaseLauncherRetainedConversation(paths.descriptorPath, binding.conversation!.key, 15_000, binding.lease!);
        else {
          recoveryStore(item.ref).retireAttempt(item.ref.thread, { scope: record.scope, expectedVersion: record.version }, item.ref.logicalWorkId, item.ref.attempt);
          assert.ok(binding.lease?.recovery, "清理缺少精确原页面身份");
          await retireLauncherContinuityWriter(paths.descriptorPath, binding.lease.recovery, item.ref.directory);
        }
        report.cleanupTargets.push(item.targetId);
      } catch (error) { report.limitations.push(`任务 ${item.task} 精确清理失败：${redact(error instanceof Error ? error.message : String(error))}`); report.status = "failed"; }
    }
    if (cdp) {
      try {
        const deadline = Date.now() + 15_000;
        while (physical.size && Date.now() < deadline) await Bun.sleep(100);
        event("sample");
        const current = sameLauncher(); report.baselinePreserved = Object.entries(descriptor.surfaceTargets).every(([surface, target]) => current.surfaceTargets[surface] === target);
        for (const item of owned) journal(item, "after-cleanup");
        if (options.case === "five-page-pressure" && report.status !== "failed") {
          report.checks = inspectResourcePressureEvidence({ events: report.events, targets: report.pages.map((row: Row) => row.targetId), journals: report.journal, results: report.results,
            cleanupTargets: report.cleanupTargets, baselinePreserved: report.baselinePreserved });
          report.status = report.checks.passed ? "passed" : "failed";
        }
        if (physical.size || !report.baselinePreserved) { report.status = "failed"; report.limitations.push("真实页面未清理完或原有页面身份改变"); }
      } catch (error) { report.status = "failed"; report.limitations.push(`最终真实页面或 journal 核验失败：${redact(error instanceof Error ? error.message : String(error))}`); }
    }
    ChatGptBrowserWorker.prototype.run = originalWorkerRun;
    LauncherBrowserHelperClient.prototype.assertContinuityCompatible = originalHelperCompatibility;
    for (const [label, dispose] of [ ["helper", () => closeChatGptBrowserWorkers()], ["Broker", () => transport?.close()], ["CDP", () => browser?.close()], ["Inspector", () => inspector?.close()] ] as const) {
      try { await dispose(); } catch (error) { report.status = "failed"; report.limitations.push(`${label} 释放失败：${redact(error instanceof Error ? error.message : String(error))}`); }
    }
    if (report.status === "passed" && physical.size === 0) {
      try { rmSync(privateRuntime, { recursive: true, force: true }); report.privateRuntime.retained = false; }
      catch (error) { report.status = "failed"; report.limitations.push(`私有 runtime 删除失败：${redact(error instanceof Error ? error.message : String(error))}`); }
    }
    if (report.privateRuntime.retained) report.limitations.push("私有临时 runtime 保留了未完整验收状态；它包含实际控制授权，不能作为可分享证据上传。");
    if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
    clearInterval(heartbeat); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); save();
  }
  console.log(redact(JSON.stringify({ status: report.status, evidence: join(output, "evidence.json"), failures: report.checks?.failures ?? [], limitations: report.limitations, error: report.error ?? null }, null, 2)));
  if (report.status !== "passed") process.exitCode = 1;
}

async function main() {
  const options = parseResourceLiveArgs(process.argv.slice(2));
  if (options.action === "plan") { console.log(JSON.stringify(resourceLivePlan(), null, 2)); return; }
  if (options.action === "check") { const { report } = await checkResourceDev(); console.log(JSON.stringify(report, null, 2)); if (!report.readyToAttempt) process.exitCode = 1; return; }
  await runResourceLive(options as RunOptions);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
