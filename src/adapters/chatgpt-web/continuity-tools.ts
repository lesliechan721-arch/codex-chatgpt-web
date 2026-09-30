import { parseRequest } from "../../responses/parser";
import { namespacedToolName, type CodexParsedRequest, type CodexTool } from "../../types";
import type { ContinuityBinding } from "./continuity-binding";
import type { ChatGptTurnSession } from "./turn-execution";

/** Historical discovery may reference approved tools, but cannot define new capabilities. */
export function continuityToolRegistry(
  parsed: CodexParsedRequest,
  binding?: ContinuityBinding,
  source?: ChatGptTurnSession,
): { tools: CodexTool[]; discoveredTools: CodexTool[] } {
  const body = parsed._rawBody as { input?: unknown[]; tools?: unknown[] };
  const input = Array.isArray(body.input) ? body.input : [];
  const items = input.filter((item): item is Record<string, unknown> => Boolean(item)
    && typeof item === "object" && !Array.isArray(item));
  const parsedTools = (tools: unknown[] | undefined, input: unknown[]): CodexTool[] =>
    parseRequest({ model: parsed.modelId, tools, input }).context.tools ?? [];
  const wireName = (tool: CodexTool): string => namespacedToolName(tool.namespace, tool.name);
  const declared = parsedTools(body.tools, items.filter(item => item.type === "additional_tools"));
  const approved = new Map((binding?.discoveredTools ?? []).map(tool => [wireName(tool), tool]));
  for (const tool of parsedTools(undefined, source?.continuityToolSearchResults(parsed) ?? [])) {
    approved.set(wireName(tool), tool);
  }
  const discoveredTools = parsedTools(undefined, items.filter(item => item.type === "tool_search_output"))
    .flatMap(tool => approved.has(wireName(tool)) ? [approved.get(wireName(tool))!] : []);
  const current = new Map(declared.map(tool => [wireName(tool), tool]));
  for (const tool of discoveredTools) {
    if (!current.has(wireName(tool))) current.set(wireName(tool), tool);
  }
  return { tools: [...current.values()], discoveredTools };
}
