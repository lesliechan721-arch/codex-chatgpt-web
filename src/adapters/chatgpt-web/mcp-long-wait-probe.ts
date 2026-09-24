import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { DEV_NATIVE_LONG_WAIT_WAIT_MS } from "../../native-tool-long-wait-probe";
import { VERSION } from "../../version";
import { observeMcpToolCalls } from "./mcp-observation";
import { callTurnBroker, type BrokerToolResult, type BrokerTurnSnapshot } from "./turn-broker";

const PROBE_TOOL_NAMES = new Set(["codex_exec", "codex_tool_wait"]);
const turnTokenSchema = z.string().min(20).max(256);
const operationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

interface McpRequestExtra {
  signal?: AbortSignal;
}

interface ClaimedProbeTurn {
  bindingId: string;
  activityId: string;
  environment: BrokerTurnSnapshot;
}

interface ProbeBrokerResponse {
  kind: "pending" | "result";
  operation_id: number;
  next_tool?: "codex_tool_wait";
  result?: BrokerToolResult;
}

function pendingResult(operationId: number) {
  const value = {
    kind: "codex_native_pending",
    operation_id: operationId,
    next_tool: "codex_tool_wait",
  } as const;
  return {
    content: [{
      type: "text" as const,
      text: `DEV Native operation ${operationId} is still pending. Call codex_tool_wait with the same operation_id.`,
    }],
    structuredContent: value,
  };
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function requestFingerprint(input: {
  cmd: string;
  workdir?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  tty?: boolean;
  sandbox_permissions?: "use_default" | "require_escalated";
  justification?: string;
  prefix_rule?: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({ entry: "codex_exec", ...input })).digest("hex");
}

export async function runDevNativeLongWaitProbeMcpServer(options: {
  brokerSocketPath: string;
}): Promise<void> {
  const server = new McpServer(
    { name: "codex-native-long-wait-probe", version: VERSION },
    {
      instructions: [
        "This connector is a DEV-only transport probe.",
        "For each new codex_exec logical operation, allocate the next positive integer operation_id before the first call.",
        "If codex_exec returns pending, call codex_tool_wait with the same operation_id until the simulated Native result is returned.",
        "A retry of the same logical codex_exec call must reuse its operation_id; a new logical call must use a new operation_id.",
      ].join(" "),
    },
  );

  const settleActivity = async (turnToken: string, activityId: string): Promise<void> => {
    await callTurnBroker(options.brokerSocketPath, {
      method: "activity_complete",
      token: turnToken,
      activityId,
    }, 5_000);
  };

  const withClaimedTurn = async <T>(
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedProbeTurn) => Promise<T>,
  ): Promise<T> => {
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    let claimed: ClaimedProbeTurn;
    try {
      claimed = await callTurnBroker(options.brokerSocketPath, {
        method: "claim",
        token: turnToken,
        activityId,
        contract: "native",
      }, 5_000, extra.signal);
    } catch (error) {
      await settleActivity(turnToken, activityId).catch(() => {});
      throw error;
    }
    try {
      return await action(claimed);
    } finally {
      await settleActivity(turnToken, activityId);
    }
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run the DEV Native long-wait probe",
      description: [
        "DEV-only technical-validation entry that has the future codex_exec operation_id shape.",
        "The command text is an inert probe label; this connector never executes it as a shell command.",
        "Allocate operation_id before the first call. Reuse it only for a retry of the same logical call.",
        "A call that exceeds the 30-second result window returns pending and must continue through codex_tool_wait.",
      ].join(" "),
      inputSchema: {
        turn_token: turnTokenSchema,
        operation_id: operationIdSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional(),
        justification: z.string().optional(),
        prefix_rule: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(input.turn_token, extra, async claimed => {
      const {
        turn_token: _turnToken,
        operation_id,
        cmd,
        workdir,
        yield_time_ms,
        max_output_tokens,
        tty,
        sandbox_permissions,
        justification,
        prefix_rule,
      } = input;
      const fingerprint = requestFingerprint({
        cmd,
        ...(workdir !== undefined ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        ...(tty !== undefined ? { tty } : {}),
        ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
        ...(justification !== undefined ? { justification } : {}),
        ...(prefix_rule !== undefined ? { prefix_rule } : {}),
      });
      const response = await callTurnBroker<ProbeBrokerResponse>(options.brokerSocketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: operation_id,
        fingerprint,
        waitMs: DEV_NATIVE_LONG_WAIT_WAIT_MS,
      }, DEV_NATIVE_LONG_WAIT_WAIT_MS + 5_000, extra.signal);
      if (response.kind === "pending") return pendingResult(operation_id);
      if (!response.result) throw new Error("DEV long-wait probe result is missing");
      return asMcpResult(response.result);
    }),
  );

  server.registerTool(
    "codex_tool_wait",
    {
      title: "Wait for a DEV Native operation",
      description: "Query an operation already created by codex_exec. This tool never creates or re-dispatches the simulated Native call.",
      inputSchema: {
        turn_token: turnTokenSchema,
        operation_id: operationIdSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, operation_id }, extra) => withClaimedTurn(turn_token, extra, async claimed => {
      const response = await callTurnBroker<ProbeBrokerResponse>(options.brokerSocketPath, {
        method: "dev_long_wait_probe_wait",
        bindingId: claimed.bindingId,
        operationId: operation_id,
        waitMs: DEV_NATIVE_LONG_WAIT_WAIT_MS,
      }, DEV_NATIVE_LONG_WAIT_WAIT_MS + 5_000, extra.signal);
      if (response.kind === "pending") return pendingResult(operation_id);
      if (!response.result) throw new Error("DEV long-wait probe result is missing");
      return asMcpResult(response.result);
    }),
  );

  await server.connect(observeMcpToolCalls(new StdioServerTransport(), PROBE_TOOL_NAMES));
}
