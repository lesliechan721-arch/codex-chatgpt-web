import { NATIVE_WAIT_INSTRUCTIONS } from "./native-tool-wait-protocol";
export { NATIVE_WAIT_INSTRUCTIONS } from "./native-tool-wait-protocol";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { VERSION } from "../../version";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";
import { BRIDGE_TOOL_NAMES, nativePublicResult, nativeToolInputSchemas, type ChatGptMcpContract, type NativeToolEntry } from "./native-tool-contract";
import { NativeOperationError, nativeOperationFailure, nativePendingResult, NATIVE_WAIT_PROTOCOL_VERSION, type NativeOperationReply } from "./native-tool-operations";
export { CHATGPT_WEB_AGENT_WAIT_POLL_MS } from "./native-tool-contract";
export type { ChatGptMcpContract } from "./native-tool-contract";

const turnTokenSchema = z.string().min(20).max(256);
const operationIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  .describe("Allocate the next positive operation_id before the first call. Retry and wait reuse it. A new logical operation needs a new ID. Keep this counter across reconnects within the same capability.");
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

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
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

export async function runChatGptMcpServer(options: { brokerSocketPath: string; contract?: ChatGptMcpContract }): Promise<void> {
  const contract = options.contract ?? "native";
  const instructions = contract === "safe"
    ? "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id. Use that request_id for tools, then send the complete answer with codex_turn_complete. " + NATIVE_WAIT_INSTRUCTIONS
    : NATIVE_WAIT_INSTRUCTIONS;
  const server = new McpServer({ name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION }, { instructions });

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk2 request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const nativeCall = async (entry: NativeToolEntry | "codex_tool_wait", input: Record<string, unknown>, extra: McpRequestExtra) => {
    const { operation_id, turn_token: _turnToken, request_id: _requestId, ...nativeInput } = input;
    if (!Number.isSafeInteger(operation_id) || (operation_id as number) <= 0) {
      return asMcpResult(nativeOperationFailure("codex_tool_operation_id_required", "Allocate operation_id before the first Native call. Refresh the connector to obtain the current operation_id and codex_tool_wait schemas."));
    }
    try {
      console.error(`[chatgpt-web-mcp] ${entry} scope=${requestScopeSummary(extra)}`);
      const status = await callTurnBroker<{ nativeWaitProtocol?: number }>(options.brokerSocketPath, { method: "owner_status" }, 5_000, extra.signal);
      if (status.nativeWaitProtocol !== NATIVE_WAIT_PROTOCOL_VERSION) {
        throw new NativeOperationError("codex_tool_upgrade_required", "Update the runtime and helper, then refresh the current connector before invoking Native tools");
      }
      const reply = await callTurnBroker<NativeOperationReply>(options.brokerSocketPath, {
        method: entry === "codex_tool_wait" ? "native_operation_wait" : "native_operation_start",
        token: turnReference(contract, input), contract, nativeWaitProtocol: NATIVE_WAIT_PROTOCOL_VERSION,
        operationId: operation_id as number,
        ...(entry === "codex_tool_wait" ? {} : { entry, nativeInput }),
      }, CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, extra.signal);
      if (reply.kind === "pending" && reply.operation_id === operation_id) return asMcpResult(nativePendingResult(reply.operation_id));
      if (reply.kind === "result" && Array.isArray(reply.result?.content)) return asMcpResult(reply.result);
      throw new NativeOperationError("codex_tool_infrastructure_failure", "The Native waiting channel returned an invalid reply; preserve the original operation_id");
    } catch (error) {
      // A query owns only its waiter/activity. Neither cancellation nor a lost response owns the
      // Native operation, which remains replayable until explicit retirement or lease loss.
      if (extra.signal?.aborted) throw error;
      return asMcpResult(nativeOperationFailure(
        error instanceof NativeOperationError ? error.code : "codex_tool_infrastructure_failure",
        error instanceof NativeOperationError ? error.message : "The Native waiting channel is unavailable. Preserve the original operation_id; do not repeat the operation with a new ID.", entry,
      ));
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
      ...nativeToolInputSchemas[entry],
    }).strict();
    const inputSchema = contract === "native" && entry === "codex_tool_call"
      ? z.object({
        ...turnReferenceInput(contract),
        operation_id: operationIdSchema.optional(),
        ...nativeToolInputSchemas.codex_tool_call,
      }).strict().meta({
        anyOf: [
          {
            required: ["operation_id"],
            not: { properties: { wire_name: { const: CODEX_COMPACTION_CONTROL_WIRE_NAME } }, required: ["wire_name"] },
          },
          {
            properties: { wire_name: { const: CODEX_COMPACTION_CONTROL_WIRE_NAME } },
            required: ["wire_name"],
            not: { required: ["operation_id"] },
          },
        ],
      })
      : ordinaryInputSchema;
    server.registerTool(entry, {
      title: info.title,
      description: (contract === "safe" && entry === "codex_tool_inventory"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : (contract === "safe" ? "For a Zero Risk request connected by codex_turn_start. " : "") + info.description)
        + " Allocate operation_id before the first call; reuse it for retry/wait. Pending requires codex_tool_wait, not another execution."
        + (contract === "native" && entry === "codex_tool_call" ? " Only codex.control.compaction_handoff is exempt from operation_id." : ""),
      inputSchema,
      annotations: { readOnlyHint: info.readOnly, destructiveHint: !info.readOnly, idempotentHint: true, openWorldHint: !info.readOnly && entry !== "codex_apply_patch" },
    }, async (input: Record<string, unknown>, extra: McpRequestExtra) => {
      const args = input as Record<string, unknown>;
      if (contract === "native" && entry === "codex_tool_call" && args.wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (args.operation_id !== undefined) throw new Error("Compaction control handoff does not accept operation_id");
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

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  await server.connect(observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES));
}
