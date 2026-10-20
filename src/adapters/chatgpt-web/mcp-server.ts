import { CONTEXT_REUSE_PROTOCOL } from "./context-reuse-types";
import { CONTEXT_PROTOCOL_VERSION, contextFailure, type ContextPreparedReply } from "./context-runtime";
import { contextTextReadReceipt, type ContextTextReadReceipt } from "./context-text-result";
export { NATIVE_WAIT_INSTRUCTIONS } from "./native-tool-wait-protocol";
import { CONTEXT_TEXT_READ_INSTRUCTIONS } from "./context-prompt";
import { createHash, randomBytes } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { VERSION } from "../../version";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";
import { BRIDGE_TOOL_NAMES, nativePublicResult, nativeToolInputSchemas, type ChatGptMcpContract, type NativeToolEntry } from "./native-tool-contract";
import { NativeOperationError, nativeOperationFailure, nativePendingResult, NATIVE_WAIT_PROTOCOL_VERSION, type NativeOperationReply } from "./native-tool-operations";
import type { TaskUpdateAckResult, UpdateDelivery } from "./task-update-protocol";
export { CHATGPT_WEB_AGENT_WAIT_POLL_MS } from "./native-tool-contract";
export type { ChatGptMcpContract } from "./native-tool-contract";

const turnTokenSchema = z.string().min(20).max(256);
const nativeTurnTokenPattern = /^turn_[A-Za-z0-9_-]{32}$/;
const compactionControlTokenPattern = /^control_[a-f0-9]{32}$/;
const nativeTurnTokenSchema = z.string().regex(nativeTurnTokenPattern,
  "Copy turn_token exactly from the current request: turn_ followed by 32 case-sensitive characters. Do not guess or reuse an earlier token.")
  .describe("Opaque capability for this request. Copy the complete turn_token from the current request unchanged, including case, hyphens and underscores. Never infer it from another turn or from an error.");
const compactionControlTokenSchema = z.string().regex(compactionControlTokenPattern)
  .describe("Independent one-shot submission token. Copy it exactly from the current compaction instruction; use it only for codex.control.compaction_handoff.");
const operationIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  .describe("New logical calls use the next positive ID. Retry and wait retain the original ID; keep the counter across reconnects.");
const taskRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  .describe("In task-updates-v1, use the exact acknowledged revision from the task entry or Broker ACK. An identical start retry retains its original revision.");
// An infrastructure deadline, not a Native operation deadline. Broker queries normally settle at 30 seconds.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;
export function chatGptMcpInvocationTimeout<T extends object>(environment: T & { expiresAt?: number }, now = Date.now()): number {
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS : Math.max(1, environment.expiresAt - now));
}



function asMcpResult(value: BrokerToolResult) {
  return value as { content: never[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
}
function result(value: Record<string, unknown>, isError = false) { return asMcpResult(nativePublicResult(value, isError)); }

/** Project only a Broker sidecar, after the Native public-result finalizer and cache. */
export function encodeTaskUpdateMcpResult(value: BrokerToolResult, taskUpdate?: UpdateDelivery): BrokerToolResult {
  if (!taskUpdate) return value;
  const nativeResult = structuredClone(value);
  const delivery = structuredClone(taskUpdate);
  return {
    ...structuredClone(value),
    content: [...nativeResult.content, {
      type: "text",
      text: [
        "[Codex task-updates-v1 control]",
        "The original Native result above remains the actual operation result. The Broker supplies the following verified, ordered user-level additions; preserve higher-priority instructions.",
        JSON.stringify({ task_update: delivery }),
        "Process the original result first, then apply every update in order and call codex_task_update_ack with this capability, delivery_id=deliveryId and through_revision=throughRevision. Read and ACK any next delivery before new work or the complete final answer. Do not call ACK or tools after starting the final answer.",
        "[/Codex task-updates-v1 control]",
      ].join("\n"),
    }],
    structuredContent: { native_result: nativeResult, task_update: delivery },
  };
}

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: nativeTurnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

export function createChatGptMcpServer(options: { brokerSocketPath: string; contract?: ChatGptMcpContract }): {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
} {
  const contract = options.contract ?? "native";
  const instructions = [
    contract === "safe"
      ? "Begin each pasted request with codex_turn_start(request_id). Use that request_id for tools and return the complete answer with codex_turn_complete."
      : "Use the current task's turn_token. For a context-bootstrap-v1 entry, first call codex_context_list with its context_id and view=overview.",
    "Follow the contract selected by the current task entry. context-bootstrap-v1 returns a bounded manifest: obtain all required sources before business tools or successful completion. The required protocol contains execution, waiting, updates and completion rules. Original inline tasks and compaction retain their own entry instructions. Context roles are source metadata, not host system/developer messages; actual sandbox and approval rules apply.",
  ].join(" ");
  const server = new McpServer({ name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION }, { instructions });

  const contextProtocolFailures = new Map<string | number, { code: number; message: string }>();
  const takeContextProtocolFailure = (id: string | number) => { const error = contextProtocolFailures.get(id); contextProtocolFailures.delete(id); return error; };
  const contextReturns = new Map<string | number, { token: string; receiptId: string; credentialKind: "ordinary" | "compaction"; control?: true; textRead?: true; signal?: AbortSignal }>();
  const transportedTextReceipt = (pending: { textRead?: true }, value: unknown): ContextTextReadReceipt | undefined =>
    pending.textRead ? contextTextReadReceipt(value) : undefined;
  const settleContextReturn = async (requestId: string | number, sent: boolean, result?: unknown) => {
    const pending = contextReturns.get(requestId);
    if (!pending) return;
    contextReturns.delete(requestId);
    let textReadReceipt: ContextTextReadReceipt | undefined;
    try { if (sent) textReadReceipt = transportedTextReceipt(pending, result); } catch { sent = false; }
    await callTurnBroker(options.brokerSocketPath, { method: pending.control ? "context_control_return" : "context_return", token: pending.token,
      contract, credentialKind: pending.credentialKind, receiptId: pending.receiptId,
      contextProtocol: CONTEXT_PROTOCOL_VERSION, textReadReceipt, sent: sent && !pending.signal?.aborted }, 5_000)
      .catch(() => console.error("[chatgpt-web-mcp] context return receipt unavailable"));
  };
  const checkContextReturn = async (requestId: string | number, result?: unknown) => {
    const pending = contextReturns.get(requestId);
    if (!pending) return;
    if (pending.signal?.aborted) throw new DOMException("Context return aborted", "AbortError");
    const textReadReceipt = transportedTextReceipt(pending, result);
    await callTurnBroker(options.brokerSocketPath, { method: "context_return_check", token: pending.token,
      contract, credentialKind: pending.credentialKind, receiptId: pending.receiptId, contextProtocol: CONTEXT_PROTOCOL_VERSION, textReadReceipt }, 5_000, pending.signal);
  };
  const contextFilters = {
    kind: z.enum(["message_text", "tool_arguments", "tool_result", "image"]).optional(),
    tool_name: z.string().max(256).optional(), namespace: z.string().max(256).nullable().optional(),
    call_id: z.string().max(256).optional(),
    source_range: z.object({ start: z.number().int().min(1), end_exclusive: z.number().int().min(2) }).strict().optional(),
  };
  for (const method of ["list", "read", "search"] as const) {
    const ordinaryKey = contract === "safe" ? "request_id" : "turn_token";
    const operationInput = method === "list" ? { ...contextFilters, view: z.enum(["overview", "entries"]), required_only: z.boolean().optional(), cursor: z.string().max(4096).optional() }
      : method === "read" ? { read_ref: z.string().min(1).max(256), cursor: z.string().max(4096).optional() }
      : { ...contextFilters, query: z.string().min(1).max(512), read_ref: z.string().min(1).max(256).optional(), cursor: z.string().max(4096).optional() };
    const inputSchema = z.object({
      [ordinaryKey]: turnTokenSchema.optional(), compaction_token: turnTokenSchema.optional(),
      context_id: z.string().min(1).max(256), ...operationInput,
    }).strict().refine(input => (typeof (input as Record<string, unknown>)[ordinaryKey] === "string") !== (typeof input.compaction_token === "string"), "Exactly one context credential is required")
      .meta({ oneOf: [{ required: [ordinaryKey], not: { required: ["compaction_token"] } }, { required: ["compaction_token"], not: { required: [ordinaryKey] } }] });
    server.registerTool(`codex_context_${method}`, {
      title: `Read existing Codex context: ${method}`,
      description: "Read fixed sources already supplied to this task. No operation_id. Use exactly the current mode credential or the independent compaction_token, plus context_id. Listing and previews are not full source reads; reading never executes an old tool or acknowledges task updates."
        + (method === "read" ? ` ${CONTEXT_TEXT_READ_INSTRUCTIONS}` : method === "list" ? " required_only=true lists the selected required sources; follow the returned cursor for more entries." : ""),
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input, extra) => {
      const { compaction_token, turn_token, request_id, ...contextArgs } = input as Record<string, unknown>;
      const token = (compaction_token ?? turn_token ?? request_id) as string;
      const credentialKind = compaction_token ? "compaction" as const : "ordinary" as const;
      try {
        const reply = await callTurnBroker<ContextPreparedReply>(options.brokerSocketPath, {
          method: "context_query", token, contract, credentialKind, contextProtocol: CONTEXT_PROTOCOL_VERSION, contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: CONTEXT_REUSE_PROTOCOL,
          contextMethod: method, contextArgs: contextArgs as never,
        }, CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, extra.signal);
        if (!reply || typeof reply.receiptId !== "string" || !Array.isArray(reply.result?.content)) throw new Error("Invalid context response");
        const textRead = method === "read" && !reply.result.isError && !reply.result.content.some(block => (block as { type?: unknown })?.type === "image");
        contextReturns.set(extra.requestId, { token, receiptId: reply.receiptId, credentialKind, ...(textRead ? { textRead: true } : {}), signal: extra.signal });
        if (extra.signal.aborted) { await settleContextReturn(extra.requestId, false); throw new DOMException("Context read aborted", "AbortError"); }
        return asMcpResult(reply.result);
      } catch (error) {
        if (extra.signal.aborted) throw error;
        if (error instanceof NativeOperationError && error.code === "CONTEXT_NAVIGATION_STOPPED") {
          const refusal = { code: ErrorCode.InvalidRequest, message: "CONTEXT_NAVIGATION_STOPPED: this scope no longer authorizes source queries; its original completion path remains available" };
          contextProtocolFailures.set(extra.requestId, refusal);
          throw new McpError(refusal.code, refusal.message);
        }
        return asMcpResult(contextFailure(error instanceof NativeOperationError ? error.code : "CONTEXT_UNAVAILABLE",
          error instanceof NativeOperationError ? error.message.slice(0, 1600) : "Context access is unavailable; do not repeat a business operation to replace missing evidence"));
      }
    });
  }

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk4 request",
        description: "Connect the pasted request_id. A short startup returns context_bootstrap with required sources and the next read. If read_state=waiting, complete the original manual Sent confirmation before reading; do not poll reads. A repeated start retains the same manifest and current coverage.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
          context_bootstrap: z.record(z.string(), z.unknown()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean; contextBootstrapReceipt?: string }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
          contextProtocol: CONTEXT_PROTOCOL_VERSION,
          contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: CONTEXT_REUSE_PROTOCOL,
        }, 5_000, extra.signal);
        const { contextBootstrapReceipt, ...modelResponse } = response;
        if (contextBootstrapReceipt) contextReturns.set(extra.requestId, { token: request_id, receiptId: contextBootstrapReceipt, credentialKind: "ordinary", signal: extra.signal });
        return result(modelResponse);
      },
    );
  }

  const nativeCall = async (entry: NativeToolEntry | "codex_tool_wait", input: Record<string, unknown>, extra: McpRequestExtra) => {
    const { operation_id, task_revision, turn_token: _turnToken, request_id: _requestId, ...nativeInput } = input;
    if (!Number.isSafeInteger(operation_id) || (operation_id as number) <= 0) {
      return asMcpResult(nativeOperationFailure("codex_tool_operation_id_required", "Allocate operation_id before the first Native call. Refresh the connector to obtain the current operation_id and codex_tool_wait schemas."));
    }
    try {
      console.error(`[chatgpt-web-mcp] ${entry} scope=${requestScopeSummary(extra)}`);
      const status = await callTurnBroker<{ nativeWaitProtocol?: number }>(options.brokerSocketPath, { method: "owner_status" }, 5_000, extra.signal);
      if (status.nativeWaitProtocol !== NATIVE_WAIT_PROTOCOL_VERSION) {
        throw new NativeOperationError("codex_tool_upgrade_required", "Update the runtime and helper, then refresh the current connector before invoking Native tools");
      }
      const reply = await callTurnBroker<NativeOperationReply & { contextControlReceipt?: string }>(options.brokerSocketPath, {
        method: entry === "codex_tool_wait" ? "native_operation_wait" : "native_operation_start",
        token: turnReference(contract, input), contract, nativeWaitProtocol: NATIVE_WAIT_PROTOCOL_VERSION,
        operationId: operation_id as number,
        ...(entry === "codex_tool_wait" ? {} : {
          entry, nativeInput, taskRevision: task_revision as number | undefined, taskUpdateProtocol: 1,
        }),
      }, CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, extra.signal);
      if (reply.contextControlReceipt) contextReturns.set(extra.requestId, { token: turnReference(contract, input),
        receiptId: reply.contextControlReceipt, credentialKind: "ordinary", control: true, signal: extra.signal });
      if (reply.kind === "pending" && reply.operation_id === operation_id) return asMcpResult(encodeTaskUpdateMcpResult(nativePendingResult(reply.operation_id), reply.taskUpdate));
      if (reply.kind === "result" && Array.isArray(reply.result?.content)) return asMcpResult(encodeTaskUpdateMcpResult(reply.result, reply.taskUpdate));
      throw new NativeOperationError("codex_tool_infrastructure_failure", "The Native waiting channel returned an invalid reply; preserve the original operation_id");
    } catch (error) {
      // A query owns only its waiter/activity. Neither cancellation nor a lost response owns the
      // Native operation, which remains replayable until explicit retirement or lease loss.
      if (extra.signal?.aborted) throw error;
      return asMcpResult(encodeTaskUpdateMcpResult(nativeOperationFailure(
        error instanceof NativeOperationError ? error.code : "codex_tool_infrastructure_failure",
        error instanceof NativeOperationError ? error.message : "The Native waiting channel is unavailable. Preserve the original operation_id; do not repeat the operation with a new ID.", entry,
        error instanceof NativeOperationError ? error.retirementDiagnostics : undefined,
      ), error instanceof NativeOperationError ? error.taskUpdate : undefined));
    }
  };

  const descriptions: Record<NativeToolEntry, { title: string; description: string; readOnly: boolean }> = {
    codex_exec: { title: "Run a native Codex command", description: "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.", readOnly: false },
    codex_write_stdin: { title: "Continue a native Codex command session", description: "Write characters to, or poll, a session_id returned by codex_exec.", readOnly: false },
    codex_apply_patch: { title: "Apply a native Codex patch", description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.", readOnly: false },
    codex_view_image: { title: "View an image through native Codex", description: "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.", readOnly: true },
    codex_tool_inventory: { title: "Discover tools from the current Codex harness", description: "List tools available to the current Codex turn, including configured MCP and app tools.", readOnly: true },
    codex_tool_call: { title: "Call any tool from the current Codex harness", description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.", readOnly: false },
  };
  for (const entry of Object.keys(nativeToolInputSchemas) as NativeToolEntry[]) {
    const info = descriptions[entry];
    const ordinaryInputSchema = z.object({
      ...turnReferenceInput(contract),
      operation_id: operationIdSchema,
      task_revision: taskRevisionSchema.optional(),
      ...nativeToolInputSchemas[entry],
    }).strict();
    const inputSchema = contract === "native" && entry === "codex_tool_call"
      ? z.object({
        turn_token: z.union([nativeTurnTokenSchema, compactionControlTokenSchema], {
          error: "Copy turn_token exactly from the current request. For compaction handoff, copy its independent control_ token unchanged.",
        }),
        operation_id: operationIdSchema.optional(),
        task_revision: taskRevisionSchema.optional(),
        ...nativeToolInputSchemas.codex_tool_call,
      }).strict().refine(input => (input.wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME
        ? compactionControlTokenPattern : nativeTurnTokenPattern).test(input.turn_token), {
        path: ["turn_token"],
        message: "Copy turn_token exactly from the current request. Use the independent control_ token only for codex.control.compaction_handoff.",
      }).meta({
        anyOf: [
          {
            properties: { turn_token: { pattern: nativeTurnTokenPattern.source } },
            required: ["operation_id"],
            not: { properties: { wire_name: { const: CODEX_COMPACTION_CONTROL_WIRE_NAME } }, required: ["wire_name"] },
          },
          {
            properties: { wire_name: { const: CODEX_COMPACTION_CONTROL_WIRE_NAME },
              turn_token: { pattern: compactionControlTokenPattern.source } },
            required: ["wire_name"],
            not: { anyOf: [{ required: ["operation_id"] }, { required: ["task_revision"] }] },
          },
        ],
      })
      : ordinaryInputSchema;
    server.registerTool(entry, {
      title: info.title,
      description: (contract === "safe" && entry === "codex_tool_inventory"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : (contract === "safe" ? "For a Zero Risk request connected by codex_turn_start. " : "") + info.description)
        + " New work needs a new operation_id; recovery keeps its ID, arguments and revision. Pending uses codex_tool_wait."
        + " With task-updates-v1 pass the acknowledged task_revision from task startup or Broker ACK. Follow the task protocol."
        + (contract === "native" && entry === "codex_tool_call" ? " Only codex.control.compaction_handoff is exempt from operation_id and task_revision." : ""),
      inputSchema,
      annotations: { readOnlyHint: info.readOnly, destructiveHint: !info.readOnly, idempotentHint: true, openWorldHint: !info.readOnly && entry !== "codex_apply_patch" },
    }, async (input: Record<string, unknown>, extra: McpRequestExtra) => {
      const args = input as Record<string, unknown>;
      if (contract === "native" && entry === "codex_tool_call" && args.wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (args.operation_id !== undefined) throw new Error("Compaction control handoff does not accept operation_id");
        if (args.task_revision !== undefined) throw new Error("Compaction control handoff does not accept task_revision");
        if (args.input !== undefined) throw new Error("Compaction control handoff does not accept freeform input");
        const control = args.arguments as Record<string, unknown> | undefined;
        if (typeof control?.handoff_id !== "string" || !control.handoff_id || typeof control.summary !== "string") {
          throw new Error("Compaction control handoff requires handoff_id and summary");
        }
        await callTurnBroker(options.brokerSocketPath, { method: "submit_compaction_handoff", token: turnReference(contract, args), handoffId: control.handoff_id, summary: control.summary }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return nativeCall(entry, args, extra);
    });
  }

  server.registerTool("codex_tool_wait", {
    title: "Wait for an existing native Codex operation",
    description: "Read the public result of the same operation_id. This queries the Broker directly and never creates or re-dispatches a Native call. Pending is not completion; continue waiting with the same ID.",
    inputSchema: z.object({ ...turnReferenceInput(contract), operation_id: operationIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => nativeCall("codex_tool_wait", input, extra));

  server.registerTool("codex_task_update_ack", {
    title: "Acknowledge delivered Codex task additions",
    description: "After reading a Broker task_update, acknowledge its exact deliveryId and throughRevision. This control query never dispatches Native work, has no operation_id, and cannot create or modify user instructions. Read any next delivery in its reply and ACK it before new work. After final output starts, a late ACK is ignored and does not reopen tool work.",
    inputSchema: z.object({
      ...turnReferenceInput(contract),
      delivery_id: z.string().min(1).max(256),
      through_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    console.error(`[chatgpt-web-mcp] codex_task_update_ack scope=${requestScopeSummary(extra)}`);
    const capability = turnReference(contract, input);
    const activityId = `activity_${randomBytes(24).toString("base64url")}`;
    try {
      const response = await callTurnBroker<TaskUpdateAckResult>(options.brokerSocketPath, {
        method: "task_update_ack", token: capability, contract, activityId,
        taskUpdateProtocol: 1, deliveryId: input.delivery_id, throughRevision: input.through_revision,
      }, 5_000, extra.signal);
      const { taskUpdate, ...acknowledgement } = response;
      return asMcpResult(encodeTaskUpdateMcpResult(nativePublicResult(acknowledgement), taskUpdate));
    } finally {
      // A query owns only its control activity. Cleanup outlives cancellation and cannot cancel
      // the physical capability or acknowledge an update on the model's behalf.
      await callTurnBroker(options.brokerSocketPath, { method: "activity_complete", token: capability, activityId })
        .catch(() => console.error("[chatgpt-web-mcp] task update activity cleanup unavailable"));
    }
  });

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
          task_revision: taskRevisionSchema.optional()
            .describe("The exact acknowledged task revision for this complete answer. Omission is allowed only when both acknowledged and accepted revisions are 0; it never upgrades an answer to a later revision."),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer, task_revision }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        try {
          const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
            method: "safe_complete",
            token: request_id,
            finalAnswer: final_answer, taskRevision: task_revision, taskUpdateProtocol: 1,
          }, null, extra.signal);
          return result(response);
        } catch (error) {
          if (extra.signal.aborted) throw error;
          if (!(error instanceof NativeOperationError)) throw error;
          return asMcpResult(encodeTaskUpdateMcpResult(nativeOperationFailure(error.code, error.message), error.taskUpdate));
        }
      },
    );
  }

  return {
    connect: transport => server.connect(observeMcpToolCalls(transport, BRIDGE_TOOL_NAMES, undefined, settleContextReturn, checkContextReturn, takeContextProtocolFailure)),
    close: () => server.close(),
  };
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string; contract?: ChatGptMcpContract }): Promise<void> {
  await createChatGptMcpServer(options).connect(new StdioServerTransport());
}
