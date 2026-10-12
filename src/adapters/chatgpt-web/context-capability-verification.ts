import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { atomicWriteFile, getConfigDir, getContextCapabilityEvidencePath, isLegacyChatGptConnectorIdentity, loadConfigFromPath,
  legacyChatGptConnectorMigrationMessage, providerConfig, tunnelConfigForInteractionMode, type AppConfig } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME, DEV_NATIVE_LONG_WAIT_MCP_CONTRACT } from "../../native-tool-long-wait-probe";
import { startLauncherManualTurn, waitForLauncherManualSent, markLauncherManualTurnStarted,
  waitForLauncherManualTerminal, endLauncherManualTurn, type LauncherManualTurnOwner } from "../../launcher-browser-host";
import { parseRequest } from "../../responses/parser";
import { ChatGptBrowserWorker, type BrowserTurn } from "./browser-worker";
import { createContextSnapshot } from "./context-snapshot";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { CONTEXT_PROTOCOL_VERSION, type ContextVerificationHandle, type ContextVerificationReceipts } from "./context-runtime";
import { CONTEXT_TEXT_READ_FORMAT, isContextTextReadReceipt } from "./context-text-result";

export const CONTEXT_CAPABILITY_VERIFICATION_VERSION = 2;
export const CONTEXT_CAPABILITY_VERIFICATION_TIMEOUT_MS = 300_000;
export const CONTEXT_CAPABILITY_METHODS = ["list", "search", "read"] as const;
export type ContextCapabilityMethod = typeof CONTEXT_CAPABILITY_METHODS[number];
export type ContextCapabilityCredential = "ordinary" | "compaction";
export interface ContextCapabilityReceipts {
  ordinary: ContextVerificationReceipts;
  compaction: ContextVerificationReceipts;
}
export interface ContextCapabilityBinding {
  profile: "production" | "development";
  home: string;
  mode: "automatic" | "manual";
  appName: string;
  tunnelId: string;
  tunnelProfile: string;
  brokerSocketPath: string;
  runtimeCommand: string[];
  runtimeFingerprint: string;
  schemaDigest: string;
  sentConfirmationRequired: boolean;
  contextProtocol: typeof CONTEXT_PROTOCOL_VERSION;
  textReadFormat: typeof CONTEXT_TEXT_READ_FORMAT;
}
export interface ContextCapabilityEvidence {
  version: typeof CONTEXT_CAPABILITY_VERIFICATION_VERSION;
  binding: ContextCapabilityBinding;
  verifiedAt: string;
  /** Successful supported-transport returns, not model prose or a raw cloud schema document. */
  receipts: ContextCapabilityReceipts;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Validate the installed public contract only; tools/list is not evidence of cloud callability. */
export function contextCapabilitySchemaDigest(tools: readonly unknown[], mode: "automatic" | "manual"): string {
  const ordinaryKey = mode === "manual" ? "request_id" : "turn_token";
  const oppositeKey = mode === "manual" ? "turn_token" : "request_id";
  const selected = CONTEXT_CAPABILITY_METHODS.map(method => {
    const matches = tools.filter(tool => object(tool) && tool.name === `codex_context_${method}`);
    if (matches.length !== 1 || !object(matches[0])) throw new Error(`Installed MCP lacks codex_context_${method}`);
    const tool = matches[0]; const schema = tool.inputSchema;
    if (!object(schema) || !object(schema.properties) || schema.additionalProperties !== false
      || !(ordinaryKey in schema.properties) || !("compaction_token" in schema.properties)
      || oppositeKey in schema.properties || "operation_id" in schema.properties
      || !Array.isArray(schema.required) || !schema.required.includes("context_id")
      || !object(tool.annotations) || tool.annotations.readOnlyHint !== true) {
      throw new Error(`Installed MCP has an incompatible codex_context_${method} contract`);
    }
    const exclusive = schema.oneOf;
    const branch = (required: string, forbidden: string) => Array.isArray(exclusive) && exclusive.some(value =>
      object(value) && Array.isArray(value.required) && value.required.length === 1 && value.required[0] === required
      && object(value.not) && Array.isArray(value.not.required) && value.not.required.length === 1 && value.not.required[0] === forbidden);
    if (!Array.isArray(exclusive) || exclusive.length !== 2 || !branch(ordinaryKey, "compaction_token") || !branch("compaction_token", ordinaryKey)
      || schema.required.includes(ordinaryKey) || schema.required.includes("compaction_token")) {
      throw new Error(`Installed MCP lacks exclusive ordinary/compaction credentials for codex_context_${method}`);
    }
    if (typeof tool.description !== "string" || !tool.description
      || method === "read" && !tool.description.includes(CONTEXT_TEXT_READ_FORMAT)
      || tool.outputSchema !== undefined && !object(tool.outputSchema)) {
      throw new Error(`Installed MCP has an incompatible codex_context_${method} output contract; update the existing connector and run Verify runtime again`);
    }
    return { name: tool.name, inputSchema: schema, annotations: tool.annotations, description: tool.description,
      ...(method === "read" ? { textReadFormat: CONTEXT_TEXT_READ_FORMAT } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}) };
  });
  return digest(selected);
}

const schemaCache = new Map<string, { expiresAt: number; value?: string; pending?: Promise<string> }>();
const SCHEMA_CACHE_MS = 5_000;
function schemaCacheKey(config: AppConfig): string {
  const files = config.runtimeCommand.filter(value => existsSync(value));
  const entry = config.runtimeCommand[1];
  if (entry?.endsWith(".ts")) files.push(...["mcp-server.ts", "mcp-observation.ts", "context-text-result.ts", "context-runtime.ts",
    "context-navigator.ts", "context-capability-verification.ts", "turn-broker.ts"].map(file => join(dirname(resolve(entry)), "adapters", "chatgpt-web", file)));
  const fingerprint = files.map(path => {
    try { const stat = statSync(path); return [resolve(path), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { return [resolve(path), "missing"]; }
  });
  return digest({ command: config.runtimeCommand, mode: config.browserInteractionMode, probe: config.devNativeToolLongWaitProbe,
    purpose: config.purpose ?? null, appName: config.appName, fingerprint });
}
async function queryInstalledContextCapabilitySchemaDigest(config: AppConfig): Promise<string> {
  const contract = config.browserInteractionMode === "manual" ? "safe"
    : config.purpose === "dev-harness" && config.devNativeToolLongWaitProbe === true && config.appName === DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME
      ? DEV_NATIVE_LONG_WAIT_MCP_CONTRACT : "native";
  if (!config.runtimeCommand[0]) throw new Error("Installed runtime command is missing");
  const client = new Client({ name: "codex-context-capability-verifier", version: "1" });
  const transport = new StdioClientTransport({ command: config.runtimeCommand[0],
    args: [...config.runtimeCommand.slice(1), "mcp", "--contract", contract, "--broker-socket", config.brokerSocketPath], stderr: "pipe" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    return contextCapabilitySchemaDigest((await client.listTools({}, { timeout: 10_000 })).tools, config.browserInteractionMode);
  } finally { await client.close(); }
}
export async function installedContextCapabilitySchemaDigest(config: AppConfig): Promise<string> {
  const key = schemaCacheKey(config); const cached = schemaCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.value) return cached.value;
    if (cached.pending) return cached.pending;
  }
  const entry: { expiresAt: number; value?: string; pending?: Promise<string> } = { expiresAt: Date.now() + SCHEMA_CACHE_MS };
  entry.pending = queryInstalledContextCapabilitySchemaDigest(config).then(value => {
    entry.value = value; entry.pending = undefined; entry.expiresAt = Date.now() + SCHEMA_CACHE_MS; return value;
  }, error => { schemaCache.delete(key); throw error; });
  schemaCache.set(key, entry);
  return entry.pending;
}

export function contextCapabilityBinding(config: AppConfig, schemaDigest: string, home = getConfigDir()): ContextCapabilityBinding {
  if (config.mode !== "full") throw new Error("Context capability verification requires Full mode");
  const appName = config.browserInteractionMode === "manual" ? config.manualAppName : config.automaticAppName;
  if (isLegacyChatGptConnectorIdentity(appName)) throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  const tunnel = tunnelConfigForInteractionMode(config);
  if (!tunnel) throw new Error("Context capability verification requires the selected mode's tunnel");
  if (!/^[a-f0-9]{64}$/.test(schemaDigest)) throw new Error("Context capability schema digest is invalid");
  return { profile: config.purpose === "dev-harness" ? "development" : "production", home: resolve(home), mode: config.browserInteractionMode,
    appName, tunnelId: tunnel.tunnelId, tunnelProfile: digest({ binary: tunnel.binaryPath, runtimeKeyFile: resolve(tunnel.runtimeKeyFile),
      directory: resolve(tunnel.profileDir), name: tunnel.profileName, alias: tunnel.alias }),
    brokerSocketPath: config.brokerSocketPath, runtimeCommand: [...config.runtimeCommand], runtimeFingerprint: schemaCacheKey(config), schemaDigest,
    sentConfirmationRequired: config.browserInteractionMode === "manual" && config.zeroRiskRequireSentConfirmation,
    contextProtocol: CONTEXT_PROTOCOL_VERSION, textReadFormat: CONTEXT_TEXT_READ_FORMAT };
}

export function contextCapabilityReceiptsComplete(value: unknown): value is ContextCapabilityReceipts {
  return object(value) && Object.keys(value).every(key => ["ordinary", "compaction"].includes(key))
    && ["ordinary", "compaction"].every(kind => object(value[kind])
    && Object.keys(value[kind]).every(key => ["list", "search", "read", "text_read"].includes(key))
    && CONTEXT_CAPABILITY_METHODS.every(method => (value[kind] as JsonObject)[method] === true)
    && isContextTextReadReceipt((value[kind] as JsonObject).text_read));
}
function readEvidenceStore(home: string): Partial<Record<"automatic" | "manual", ContextCapabilityEvidence>> {
  try {
    const store = JSON.parse(readFileSync(getContextCapabilityEvidencePath(home), "utf8"));
    return object(store) && store.version === CONTEXT_CAPABILITY_VERIFICATION_VERSION && object(store.modes) ? store.modes : {};
  } catch { return {}; }
}
export function invalidateContextCapabilityEvidence(config: AppConfig, home = getConfigDir()): void {
  const modes = readEvidenceStore(home); delete modes[config.browserInteractionMode];
  atomicWriteFile(getContextCapabilityEvidencePath(home), `${JSON.stringify({ version: CONTEXT_CAPABILITY_VERIFICATION_VERSION, modes }, null, 2)}\n`, { durable: true });
}
export function saveContextCapabilityEvidence(config: AppConfig, schemaDigest: string, receipts: ContextCapabilityReceipts, home = getConfigDir()): ContextCapabilityEvidence {
  if (!contextCapabilityReceiptsComplete(receipts)) throw new Error("All six successful context transport receipts are required");
  const evidence: ContextCapabilityEvidence = { version: CONTEXT_CAPABILITY_VERIFICATION_VERSION,
    binding: contextCapabilityBinding(config, schemaDigest, home), verifiedAt: new Date().toISOString(), receipts: structuredClone(receipts) };
  const modes = readEvidenceStore(home); modes[config.browserInteractionMode] = evidence;
  atomicWriteFile(getContextCapabilityEvidencePath(home), `${JSON.stringify({ version: CONTEXT_CAPABILITY_VERIFICATION_VERSION, modes }, null, 2)}\n`, { durable: true });
  return evidence;
}
export function readContextCapabilityEvidence(config: AppConfig, schemaDigest: string, home = getConfigDir()): ContextCapabilityEvidence | undefined {
  const binding = contextCapabilityBinding(config, schemaDigest, home); const evidence = readEvidenceStore(home)[binding.mode];
  if (!evidence || evidence.version !== CONTEXT_CAPABILITY_VERIFICATION_VERSION || !contextCapabilityReceiptsComplete(evidence.receipts)
    || typeof evidence.verifiedAt !== "string" || !Number.isFinite(Date.parse(evidence.verifiedAt)) || canonical(evidence.binding) !== canonical(binding)) return undefined;
  return evidence;
}
/** Call before projecting context or admitting compaction. Ordinary inline sends do not depend on this gate. */
export async function assertContextCapabilityVerified(config: AppConfig, options: { home?: string; schemaDigest?: string } = {}): Promise<ContextCapabilityEvidence> {
  const schemaDigest = options.schemaDigest ?? await installedContextCapabilitySchemaDigest(config);
  const evidence = readContextCapabilityEvidence(config, schemaDigest, options.home);
  if (!evidence) throw new Error("Context navigation is not verified for this profile, mode, plugin and tunnel. Run Verify runtime and complete its six read-only MCP calls, including both context-text-read-v2 transport returns, before using projected context or compaction. Update or reconnect the existing Codex Native5, Codex Native5 DEV, Codex Zero Risk4, or custom non-retired connector when its cached contract is old, then verify again. If the client cannot update that contract, context navigation remains unavailable.");
  return evidence;
}

function providerRuntimeProfile(provider: CodexProviderConfig): { config: AppConfig; home: string } {
  const web = provider.chatgptWeb; const statePath = web?.threadEnvironmentStatePath;
  if (provider.adapter !== "chatgpt-web" || !statePath) throw new Error("Context capability verification requires the installed runtime profile");
  const resolvedState = resolve(statePath);
  // Accept only the shipped production and isolated DEV layouts, never an arbitrary path ancestor.
  const candidates = [dirname(dirname(resolvedState)), dirname(dirname(dirname(resolvedState)))];
  let profile: { config: AppConfig; home: string } | undefined;
  for (const home of candidates) {
    if (!existsSync(join(home, "config.json"))) continue;
    const config = loadConfigFromPath(join(home, "config.json"));
    const knownState = [join(home, "runtime", "thread-environments.json"),
      ...(config.purpose === "dev-harness" ? [join(home, "runtime", "dev-chat", "thread-environments.json")] : [])];
    if (!knownState.includes(resolvedState)) continue;
    // A canonical socket also binds the state directory to the same profile home.
    if (config.brokerSocketPath.endsWith("turn-broker.sock") && dirname(config.brokerSocketPath) !== join(home, "runtime")) continue;
    profile = { config, home }; break;
  }
  if (!profile) throw new Error("Context capability state path does not match a supported runtime profile");
  const { config, home } = profile;
  const expected = providerConfig(config).chatgptWeb!;
  if (config.mode !== "full" || web.localToolsEnabled !== true || web.appName !== expected.appName
    || (web.browserInteractionMode ?? "automatic") !== expected.browserInteractionMode
    || web.brokerSocketPath !== expected.brokerSocketPath) {
    throw new Error("Context capability profile does not match the active provider");
  }
  return { config, home };
}
/** Synchronous read after schema validation. Missing or stale schema cache does not authorize use. */
export function readProviderContextCapabilityEvidence(provider: CodexProviderConfig, schemaDigest?: string): ContextCapabilityEvidence | undefined {
  const { config, home } = providerRuntimeProfile(provider);
  const cached = schemaCache.get(schemaCacheKey(config));
  const current = schemaDigest ?? (cached && cached.expiresAt > Date.now() ? cached.value : undefined);
  return current ? readContextCapabilityEvidence(config, current, home) : undefined;
}
export async function assertProviderContextCapabilityVerified(provider: CodexProviderConfig): Promise<ContextCapabilityEvidence> {
  const { config, home } = providerRuntimeProfile(provider);
  return assertContextCapabilityVerified(config, { home });
}

const FIXED_VERIFICATION_SOURCE = "Read-only capability verification. The fixed marker is context-verification-alpha.";
export const contextCapabilityManualControl = { start: startLauncherManualTurn, waitSent: waitForLauncherManualSent,
  started: markLauncherManualTurnStarted, waitTerminal: waitForLauncherManualTerminal, end: endLauncherManualTurn };
export interface ContextCapabilityVerificationOptions {
  home?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Private factory dependencies used by local tests; no request or user-result fields are accepted. */
  broker?: TurnBrokerOwner;
  automaticRun?: (turn: BrowserTurn) => Promise<string>;
  manualControl?: typeof contextCapabilityManualControl;
}
function assertVerificationBroker(broker: TurnBrokerOwner): asserts broker is TurnBrokerOwner & Required<Pick<TurnBrokerOwner,
  "armContextVerification" | "markContextVerificationDelivered" | "contextVerificationStatus" | "revokeContextVerification">> {
  if (!broker.armContextVerification || !broker.markContextVerificationDelivered || !broker.contextVerificationStatus || !broker.revokeContextVerification) {
    throw new Error("The runtime lacks read-only context verification; update and restart it");
  }
}
function verificationPrompt(config: AppConfig, turnToken: string, pair: ContextVerificationHandle, normalReadRef: string, compactionReadRef: string): string {
  const key = config.browserInteractionMode === "manual" ? "request_id" : "turn_token";
  const lines = ["This is an explicit read-only runtime capability check. It contains no Codex task data.",
    "Use the selected connector for exactly the six context calls below, in order. Each call must succeed. Do not use inventory, business tools, waits, completion or compaction submission. Do not reproduce credentials in your final answer.",
    "Successful text reads use context-text-read-v2: content[0] is metadata JSON; content[1], identified by body_content_index=1, is the sole exact body. structuredContent contains metadata only. Do not join both text blocks or parse, trim, or unescape the body. These receipts verify result shape and supported transport only; they do not prove that a model used the body."];
  if (config.browserInteractionMode === "manual") lines.push(`First call codex_turn_start with ${JSON.stringify({ request_id: turnToken })}. Keep the original manual start and Sent rules.`);
  for (const [credential, contextId, readRef] of [[{ [key]: turnToken }, pair.normalContextId, normalReadRef],
    [{ compaction_token: pair.compactionToken }, pair.compactionContextId, compactionReadRef]] as const) {
    lines.push(`Call codex_context_list with ${JSON.stringify({ ...credential, context_id: contextId, view: "entries" })}.`,
      `Call codex_context_search with ${JSON.stringify({ ...credential, context_id: contextId, query: "context-verification-alpha" })}.`,
      `Call codex_context_read with ${JSON.stringify({ ...credential, context_id: contextId, read_ref: readRef })}.`);
  }
  lines.push("After all six calls succeed, reply only: Read-only verification completed. Your written reply is not verification evidence.");
  return lines.join("\n");
}
function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new DOMException("Verification aborted", "AbortError")); return; }
    const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Verification aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolveDelay(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Explicit setup transaction. It proves six successful calls, not the platform's raw cached schema. */
export async function runContextCapabilityVerification(config: AppConfig, options: ContextCapabilityVerificationOptions = {}): Promise<ContextCapabilityEvidence> {
  const home = options.home ?? getConfigDir();
  // A retry clears the selected mode's former result before any new surface is exposed.
  invalidateContextCapabilityEvidence(config, home);
  const schemaDigest = await installedContextCapabilitySchemaDigest(config);
  const binding = contextCapabilityBinding(config, schemaDigest, home);
  const manual = config.browserInteractionMode === "manual";
  if (manual && (config.browserHost !== "launcher" || !config.browserHostDescriptorPath)) throw new Error("Zero Risk capability verification requires its manual Launcher surface");
  const timeoutMs = Math.min(CONTEXT_CAPABILITY_VERIFICATION_TIMEOUT_MS, options.timeoutMs ?? CONTEXT_CAPABILITY_VERIFICATION_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid bounded verification timeout");
  const controller = new AbortController();
  const parentAbort = () => controller.abort(options.abortSignal?.reason ?? new DOMException("Verification aborted", "AbortError"));
  if (options.abortSignal?.aborted) parentAbort(); else options.abortSignal?.addEventListener("abort", parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Read-only context verification timed out before all six successful transport receipts")), timeoutMs);
  let ownedBroker: TurnBroker | undefined; let broker = options.broker; let token: string | undefined; let pair: ContextVerificationHandle | undefined;
  let worker: ChatGptBrowserWorker | undefined; let execution: Promise<unknown> | undefined;
  const traceId = `context_verify_${randomBytes(16).toString("hex")}`;
  const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
  const manualControl = options.manualControl ?? contextCapabilityManualControl;
  let manualStarted = false; let succeeded = false;
  try {
    if (!broker) {
      try { await callTurnBroker(config.brokerSocketPath, { method: "owner_status" }); }
      catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        ownedBroker = TurnBroker.forSocket(config.brokerSocketPath); await ownedBroker.listen();
      }
      const remote = new RemoteTurnBroker(config.brokerSocketPath); await remote.assertCompatible(); broker = remote;
    }
    assertVerificationBroker(broker);
    if (controller.signal.aborted) throw controller.signal.reason;
    const environment = { authorityMode: "delegated" as const, threadId: traceId, turnId: traceId, tools: [] };
    const surfaceNonce = randomBytes(32).toString("base64url");
    token = manual ? await broker.registerSafe(environment, surfaceNonce, timeoutMs, traceId,
      { requireSentConfirmation: config.zeroRiskRequireSentConfirmation }) : await broker.register(environment, timeoutMs, traceId);
    const request = parseRequest({ model: "verification", input: [{ role: "user", content: FIXED_VERIFICATION_SOURCE }] });
    const normal = createContextSnapshot(request); const compaction = createContextSnapshot(request);
    const planId = `verification_plan_${randomBytes(16).toString("hex")}`;
    pair = await broker.armContextVerification(token, { normal: { snapshot: normal, planId,
      manifestDigest: digest({ source: FIXED_VERIFICATION_SOURCE, contextId: normal.context_id }),
      deliveryByTarget: Object.fromEntries(normal.targets.map(target => [target.target_id, { delivery: "mcp", required: false }])) },
      compactionSnapshot: compaction, expiresAt: Date.now() + timeoutMs });
    const prompt = verificationPrompt(config, token, pair, normal.targets.find(target => target.read_ref)!.read_ref!, compaction.targets.find(target => target.read_ref)!.read_ref!);
    const pairToken = pair.pairToken;
    const waitReceipts = async (): Promise<ContextCapabilityReceipts> => {
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const status = await broker!.contextVerificationStatus!(pairToken);
        if (!status || status.normalContextId !== normal.context_id || status.compactionContextId !== compaction.context_id) throw new Error("Read-only verification scope was retired or changed");
        const receipts = { ordinary: status.ordinary, compaction: status.compaction };
        if (status.completed && contextCapabilityReceiptsComplete(receipts)) return receipts;
        await abortableDelay(controller.signal, 100);
      }
    };
    if (manual) {
      const descriptor = config.browserHostDescriptorPath!;
      if (controller.signal.aborted) throw controller.signal.reason;
      await manualControl.start(descriptor, { ...owner, prompt, sentConfirmationRequired: config.zeroRiskRequireSentConfirmation }); manualStarted = true;
      execution = (async () => {
        if (config.zeroRiskRequireSentConfirmation) {
          await manualControl.waitSent(descriptor, owner, { abortSignal: controller.signal });
          await broker!.confirmSafeTurnSent(token!, surfaceNonce);
          await broker!.markContextVerificationDelivered!(pairToken);
        }
        await broker!.waitForSafeStart(token!, controller.signal);
        if (!config.zeroRiskRequireSentConfirmation) await broker!.markContextVerificationDelivered!(pairToken);
        await manualControl.started(descriptor, owner);
        return waitReceipts();
      })();
      const terminal = manualControl.waitTerminal(descriptor, owner, { abortSignal: controller.signal }).then(() => {
        throw new Error("The user cancelled or failed the read-only capability check");
      });
      const receipts = await Promise.race([execution as Promise<ContextCapabilityReceipts>, terminal]);
      // Reloading the real config below prevents a concurrent setup from binding old calls to a new plugin.
      const finalConfig = existsSync(join(home, "config.json")) ? loadConfigFromPath(join(home, "config.json")) : config;
      if (canonical(binding) !== canonical(contextCapabilityBinding(finalConfig, await installedContextCapabilitySchemaDigest(finalConfig), home))) throw new Error("Verification configuration changed; run Verify runtime again");
      const evidence = saveContextCapabilityEvidence(finalConfig, schemaDigest, receipts, home); succeeded = true; return evidence;
    }
    const provider = providerConfig(config); worker = options.automaticRun ? undefined : ChatGptBrowserWorker.forProvider(provider);
    const run = options.automaticRun ?? (turn => worker!.run(turn));
    execution = run({ traceId, modelId: provider.defaultModel!, reasoning: config.solAvailable ? "high" : "medium",
      capabilities: { localToolsEnabled: true, solAvailable: config.solAvailable, extraHighAvailable: config.extraHighAvailable === true, proAvailable: config.proAvailable },
      nativeConnector: true, retainConversation: false, conversationKey: digest(traceId), abortSignal: controller.signal,
      prepare: async () => ({ text: prompt, images: [], release() {} }), onTextDelta() {},
      onSubmitted: () => broker!.markContextVerificationDelivered!(pairToken) });
    // Model output is ignored. A completed browser turn with missing calls is a failure.
    const receipts = await Promise.race([waitReceipts(), execution.then(async () => {
      // MCP's settled receipt can follow the web's final render by one scheduling turn.
      await abortableDelay(controller.signal, 200);
      const status = await broker!.contextVerificationStatus!(pairToken);
      const receipts = status && { ordinary: status.ordinary, compaction: status.compaction };
      if (!status?.completed || !contextCapabilityReceiptsComplete(receipts)) throw new Error("ChatGPT finished without all six successful context transport receipts");
      return receipts;
    })]);
    const finalConfig = existsSync(join(home, "config.json")) ? loadConfigFromPath(join(home, "config.json")) : config;
    if (canonical(binding) !== canonical(contextCapabilityBinding(finalConfig, await installedContextCapabilitySchemaDigest(finalConfig), home))) throw new Error("Verification configuration changed; run Verify runtime again");
    const evidence = saveContextCapabilityEvidence(finalConfig, schemaDigest, receipts, home); succeeded = true; return evidence;
  } finally {
    clearTimeout(timer); options.abortSignal?.removeEventListener("abort", parentAbort);
    controller.abort(new DOMException("Verification scope closed", "AbortError"));
    if (pair) await Promise.resolve(broker?.revokeContextVerification?.(pair.pairToken)).catch(() => {});
    else if (token) await Promise.resolve(broker?.revoke(token)).catch(() => {});
    if (manualStarted) await manualControl.end(config.browserHostDescriptorPath!, { ...owner, status: succeeded ? "completed" : "failed" }).catch(() => {});
    if (worker) await worker.close().catch(() => {});
    await execution?.catch(() => {});
    await ownedBroker?.close();
  }
}
