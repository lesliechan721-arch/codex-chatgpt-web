import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import type { BrokerToolResult, BrokerTurnSnapshot } from "./turn-broker";

export type ChatGptMcpContract = "native" | "safe";
export type NativeToolEntry = "codex_exec" | "codex_write_stdin" | "codex_apply_patch" | "codex_view_image" | "codex_tool_inventory" | "codex_tool_call";

export class NativeToolAdmissionError extends Error {}

export const nativeToolInputSchemas = {
  codex_exec: {
    cmd: z.string().min(1).max(100_000),
    workdir: z.string().max(16_384).optional(),
    yield_time_ms: z.number().int().min(250).max(30_000).optional(),
    max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
    tty: z.boolean().optional(),
    sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
      .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
    justification: z.string().optional().describe("Approval question for a native require_escalated request; omit otherwise."),
    prefix_rule: z.array(z.string()).optional().describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
  },
  codex_write_stdin: {
    session_id: z.number().int().nonnegative(),
    chars: z.string().max(1_000_000).optional(),
    yield_time_ms: z.number().int().min(250).max(300_000).optional(),
    max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
  },
  codex_apply_patch: { patch: z.string().min(1).max(5_000_000) },
  codex_view_image: {
    path: z.string().min(1).max(16_384),
    detail: z.enum(["high", "original"]).optional(),
  },
  codex_tool_inventory: {
    query: z.string().max(500).optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(50).default(20),
    include_schema: z.boolean().default(true),
  },
  codex_tool_call: {
    wire_name: z.string().min(1).max(1_000),
    arguments: z.record(z.string(), z.unknown()).optional(),
    input: z.string().max(5_000_000).optional(),
  },
};

export type NativeResultContract = { kind: "pass-through" } | {
  kind: "inventory";
  offset: number;
  includeSchema: boolean;
  directPage: Array<Record<string, unknown>>;
  directTotal: number;
  excludedNames: string[];
  nestedLimit: number;
  discoveryTools: Array<Record<string, unknown>>;
};

export type NativeToolPlan = {
  tool: CodexTool;
  payload: { arguments?: Record<string, unknown>; input?: string };
  resultContract: NativeResultContract;
} | { result: BrokerToolResult };

/** Normalize identity without consulting a mutable tool registry or accepting the invocation. */
export function normalizeNativeToolInput(entry: NativeToolEntry, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  if (entry === "codex_tool_inventory") {
    normalized.query = typeof input.query === "string" ? input.query.trim().toLowerCase() : input.query === undefined ? "" : input.query;
    if (input.offset === undefined) normalized.offset = 0;
    if (input.limit === undefined) normalized.limit = 20;
    if (input.include_schema === undefined) normalized.include_schema = true;
  }
  if (entry === "codex_tool_call" && input.arguments === undefined) normalized.arguments = {};
  return normalized;
}

/** Called synchronously by the Broker, once per identity, against its current registry. */
export function planNativeTool(
  entry: NativeToolEntry,
  input: Record<string, unknown>,
  bound: BrokerTurnSnapshot,
  contract: ChatGptMcpContract,
): NativeToolPlan {
  const invoke = (tool: CodexTool, payload: { arguments?: Record<string, unknown>; input?: string }): NativeToolPlan => ({
    tool, payload, resultContract: { kind: "pass-through" },
  });
  const nested = (name: string, freeform: boolean, payload: { arguments?: Record<string, unknown>; input?: string }): NativeToolPlan => {
    const gateway = execGateway(bound);
    if (!gateway) throw new NativeToolAdmissionError(`This Codex turn did not advertise ${name} or the native exec gateway`);
    return invoke(gateway, { input: execGatewayProgram(name, freeform, payload, bound.tools.map(wireName)) });
  };
  const parsed = z.object(nativeToolInputSchemas[entry]).strict().safeParse(input);
  if (!parsed.success) throw new NativeToolAdmissionError("The bridge entry does not accept these arguments");
  try {
    switch (entry) {
      case "codex_exec": {
        const { cmd, workdir, yield_time_ms, max_output_tokens, tty, ...permissions } = z.object(nativeToolInputSchemas.codex_exec).parse(input);
        const execArgs = { cmd, ...(workdir ? { workdir } : {}), ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}), ...(tty !== undefined ? { tty } : {}), ...permissions };
        const shellArgs = { command: cmd, ...(workdir ? { workdir } : {}), ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}), ...permissions };
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        if (tool) {
          for (const key of Object.keys(permissions)) {
            const properties = tool.parameters.properties;
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new NativeToolAdmissionError(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          return invoke(tool, { arguments: tool.name === "exec_command" ? execArgs : shellArgs });
        }
        const gateway = execGateway(bound);
        if (!gateway) throw new NativeToolAdmissionError("This Codex turn did not advertise a native command tool or the native exec gateway");
        return invoke(gateway, { input: execCommandGatewayProgram(execArgs, shellArgs) });
      }
      case "codex_write_stdin": {
        const args = z.object(nativeToolInputSchemas.codex_write_stdin).parse(input);
        const tool = exactTool(bound, "write_stdin");
        return tool ? invoke(tool, { arguments: args }) : nested("write_stdin", false, { arguments: args });
      }
      case "codex_apply_patch": {
        const { patch } = z.object(nativeToolInputSchemas.codex_apply_patch).parse(input);
        const tool = exactTool(bound, "apply_patch");
        return tool ? invoke(tool, tool.freeform ? { input: patch } : { arguments: { input: patch } }) : nested("apply_patch", true, { input: patch });
      }
      case "codex_view_image": {
        const args = z.object(nativeToolInputSchemas.codex_view_image).parse(input);
        const tool = exactTool(bound, "view_image");
        return tool ? invoke(tool, { arguments: args }) : nested("view_image", false, { arguments: args });
      }
      case "codex_tool_inventory": {
        const { query, offset, limit, include_schema } = z.object(nativeToolInputSchemas.codex_tool_inventory).parse(input);
        const needle = query?.trim().toLowerCase();
        const visibleTools = safeVisibleTools(bound, contract);
        const matches = visibleTools.filter(tool => !needle || [wireName(tool), tool.name, tool.namespace ?? "", tool.description].join("\n").toLowerCase().includes(needle));
        const descriptor = (tool: CodexTool) => ({
          wire_name: wireName(tool), name: tool.name, namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        });
        const directPage = matches.slice(offset, offset + limit).map(descriptor);
        const resultContract: NativeResultContract = {
          kind: "inventory", offset, includeSchema: include_schema, directPage, directTotal: matches.length,
          excludedNames: bound.tools.map(wireName), nestedLimit: Math.max(0, limit - directPage.length),
          discoveryTools: needle ? visibleTools.filter(tool => tool.toolSearch).map(descriptor) : [],
        };
        const gateway = execGateway(bound);
        if (!gateway) return { result: finishNativeToolResult(resultContract, nativePublicResult({ tools: [], total: 0 })) };
        return {
          tool: gateway,
          payload: { input: gatewayToolCatalogProgram({ query, offset: Math.max(0, offset - matches.length), limit: resultContract.nestedLimit, excludedNames: resultContract.excludedNames }) },
          resultContract,
        };
      }
      case "codex_tool_call": {
        const { wire_name, arguments: args, input: freeformInput } = z.object(nativeToolInputSchemas.codex_tool_call).parse(input);
        if (wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME || /(^|__)codex_tool_wait$/.test(wire_name)) {
          throw new NativeToolAdmissionError("Bridge control tools cannot be called through the Native gateway");
        }
        const tool = safeVisibleTools(bound, contract).find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound);
          if (!gateway || bound.tools.some(candidate => wireName(candidate) === wire_name) || !gatewayToolNameIsValid(wire_name)) {
            throw new NativeToolAdmissionError("The requested Codex tool is not available in this turn");
          }
          if (freeformInput !== undefined && args && Object.keys(args).length > 0) throw new NativeToolAdmissionError("Codex nested tools accept either arguments or freeform input, not both");
          if (isGatewayAgentWaitTool(wire_name) && freeformInput !== undefined) throw new NativeToolAdmissionError(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          assertGatewayToolArguments(wire_name, args ?? {});
          return nested(wire_name, freeformInput !== undefined, freeformInput !== undefined ? { input: freeformInput } : { arguments: args ?? {} });
        }
        if (tool.freeform) {
          if (freeformInput === undefined) throw new NativeToolAdmissionError(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new NativeToolAdmissionError(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(tool, { input: tool === execGateway(bound) ? transportBoundRawExecProgram(freeformInput, wireName(tool)) : freeformInput });
        }
        if (freeformInput !== undefined) throw new NativeToolAdmissionError(`Function Codex tool ${wire_name} does not accept freeform input`);
        assertBrowserToolArguments(tool, args ?? {});
        return invoke(tool, { arguments: args ?? {} });
      }
    }
  } catch (error) {
    // These helpers are pure admission checks. Never cache unexpected implementation failures.
    if (error instanceof Error && error.constructor === Error) throw new NativeToolAdmissionError(error.message);
    throw error;
  }
}

/** A fixed, Broker-owned finalizer. It never executes model-provided code. */
export function finishNativeToolResult(contract: NativeResultContract, response: BrokerToolResult): BrokerToolResult {
  if (contract.kind === "pass-through") return structuredClone(response);
  const catalog = gatewayToolCatalogPage(response, new Set(contract.excludedNames));
  if (catalog.tools.length > contract.nestedLimit || catalog.tools.length > catalog.total) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const nestedPage = catalog.tools.map(tool => ({
    wire_name: tool.name, name: tool.name, namespace: null, description: gatewayToolDescription(tool), kind: "gateway",
    ...(contract.includeSchema ? { parameters: {
      type: "object", additionalProperties: true,
      description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
    } } : {}),
  }));
  const page = [...contract.directPage, ...nestedPage];
  const total = contract.directTotal + catalog.total;
  return nativePublicResult({
    tools: page, total, next_offset: contract.offset + page.length < total ? contract.offset + page.length : null,
    ...(total === 0 && contract.discoveryTools.length > 0 ? { discovery_tools: contract.discoveryTools } : {}),
  });
}

export function nativePublicResult(value: Record<string, unknown>, isError = false): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_tool_wait",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: Pick<BrokerTurnSnapshot, "tools">, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name) && !/(^|__)codex_tool_wait$/.test(name);
}

function safeVisibleTools(environment: Pick<BrokerTurnSnapshot, "tools">, contract: ChatGptMcpContract): CodexTool[] {
  const visible = environment.tools.filter(tool => !/(^|__)codex_tool_wait$/.test(wireName(tool)));
  if (contract === "native") return visible;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return visible.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  // The cloned native schema must not advertise a default that contradicts our required interval.
  delete timeout.default;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function execGateway(environment: Pick<BrokerTurnSnapshot, "tools">): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visibleName = name => {",
    "  return typeof name === \"string\" && /^[A-Za-z0-9_$]+$/.test(name) && !/(^|__)codex_tool_wait$/.test(name) && !excludedNames.has(name);",
    "};",
    "const matches = ALL_TOOLS",
    "  .filter(tool => visibleName(tool?.name))",
    "  .map(tool => ({ name: tool.name, description: typeof tool.description === \"string\" ? tool.description : \"\" }))",
    "  .filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error("Native nested tool inventory failed");
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error("The requested Codex nested tool is not available in this turn");
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    "if (excludedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not callable through the structured gateway\");",
    "if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const nestedTool = tools[nestedToolName];",
    "if (typeof nestedTool !== \"function\") throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. The model still owns its JavaScript; only the tool registry it receives is a
 * transparent proxy whose native wait functions validate their transport-bound argument before dispatch.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set(Reflect.ownKeys(source));",
    "  if (typeof ALL_TOOLS !== \"undefined\" && Array.isArray(ALL_TOOLS)) {",
    "    for (const tool of ALL_TOOLS) if (typeof tool?.name === \"string\") registryNames.add(tool.name);",
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    "    if (typeof name === \"string\" && /(^|__)codex_tool_wait$/.test(name)) {",
    "      exposed = () => { throw new Error(\"codex_tool_wait is a bridge query, not a Native gateway tool\"); };",
    "    } else if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}
