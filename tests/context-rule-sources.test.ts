import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { contextRuleSources } from "../src/adapters/chatgpt-web/context-rule-sources";
import { bindContextFullCandidate, bindContextInstructionInputSource, contextCandidateCanonicalSource,
  continuityAcceptedContextCandidate, continuityContextCandidate,
  continuityRecoveredContextCandidate } from "../src/adapters/chatgpt-web/context-candidate-mapping";

const message = (id: string, role: string, content: unknown = "Exact rules.", extra: Record<string, unknown> = {}) =>
  ({ type: "message", id, role, content, ...extra });
const metadata = (kind: string, extra: Record<string, unknown> = {}) =>
  ({ internal_chat_message_metadata_passthrough: { turn_id: "created-turn", content_item_kinds: [kind], ...extra } });
const request = (input: unknown[], extra: Record<string, unknown> = {}) => parseRequest({ model: "gpt-6", input, ...extra });
const rules = (input: unknown[], extra: Record<string, unknown> = {}) => {
  const parsed = request(input, extra);
  return contextRuleSources(parsed, parsed);
};

describe("verified context rule sources", () => {
  test("real instructions have a stable field identity and an explicit replacement snapshot", () => {
    const first = parseRequest({ model: "gpt-6", instructions: "Keep exact rules.", input: "First request." });
    const next = parseRequest({ model: "gpt-6", instructions: "Keep exact rules.", input: "Next request." });
    const a = contextRuleSources(first, first);
    const b = contextRuleSources(next, next);
    expect(a.units).toHaveLength(1);
    expect(a.units[0]).toMatchObject({ kind: "instructions", role: "system", position: { system_index: 0 } });
    expect(b.units).toEqual(a.units);
    expect(a.snapshots).toEqual([{ scope: a.units[0]!.scope, identities: [a.units[0]!.identity], state: "value" }]);
    expect(contextRuleSources(structuredClone(first), structuredClone(first)).units).toEqual([]);
  });

  test("instructions disappearance, null, empty and present undefined have distinct field states", () => {
    const source = message("rule", "system");
    const values = [{}, { instructions: null }, { instructions: "" }, { instructions: undefined }];
    expect(values.map(extra => rules([source], extra).snapshots[0]!.state)).toEqual(["absent", "null", "empty", "undefined"]);
    for (const extra of values) {
      const parsed = request([source], extra);
      const result = contextRuleSources(parsed, parsed);
      expect(Object.hasOwn(parsed._rawBody as object, "instructions")).toBe(Object.hasOwn(extra, "instructions"));
      expect(parsed.context.systemPrompt).toEqual(["Exact rules."]);
      expect(result.units.map(unit => unit.kind)).toEqual(["system"]);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]!.identities).toEqual([]);
    }
    expect(rules([]).snapshots).toEqual(rules([source]).snapshots);
    const whitespace = request([source], { instructions: " " });
    expect(whitespace.context.systemPrompt).toEqual([" ", "Exact rules."]);
    expect(contextRuleSources(whitespace, whitespace).snapshots[0]!.state).toBe("value");
  });

  test("same text has distinct real source identities, and duplicate or missing IDs cannot be reused", () => {
    const result = rules([message("first", "system"), message("second", "system"), message("third", "developer")]);
    expect(result.units.map(unit => unit.kind)).toEqual(["system", "system", "developer"]);
    expect(new Set(result.units.map(unit => unit.identity)).size).toBe(3);
    expect(result.units.every(unit => unit.identity.length < 100 && unit.sourceDigest.length === 64)).toBe(true);
    const missing = rules([{ role: "system", content: "Exact rules." }, message("same", "developer"), message("same", "user")]);
    expect(missing.units).toEqual([]);
    expect(missing.misses.map(miss => miss.reason)).toContain("missing_source_id");
    expect(missing.misses.map(miss => miss.reason)).toContain("duplicate_source_id");
  });

  test("role, internal block order, metadata and unknown field presence are part of exact versions", () => {
    const source = message("rule", "system", [{ type: "input_text", text: "A" }, { type: "text", text: "B" }], { extra: { enabled: false } });
    const original = rules([source]).units[0]!;
    const variants = [
      { ...source, role: "developer" },
      { ...source, content: [...source.content as unknown[]].reverse() },
      { ...source, ...metadata("model.base_instructions") },
      { ...source, extra: { enabled: null } },
      { ...source, extra: { enabled: false, unknown: "" } },
      { ...source, extra: { enabled: false, unknown: undefined } },
    ];
    for (const variant of variants) {
      const changed = rules([variant]).units[0]!;
      expect(changed.identity).toBe(original.identity);
      expect(changed.sourceDigest).not.toBe(original.sourceDigest);
    }
    expect(rules([source]).units[0]).toEqual(original);
  });

  test("rule priority and applicability changes invalidate scopes, while appended history leaves prefix rules stable", () => {
    const system = message("system", "system");
    const developer = message("developer", "developer");
    const agents = message("agents", "user", "Project rule.", metadata("agents_md.instructions"));
    const user = message("task", "user", "Current event.");
    const original = rules([system, developer, agents, user]);
    const grown = rules([system, developer, agents, user, message("answer", "assistant", "Done."), message("next", "user", "Next.")]);
    expect(grown.units).toEqual(original.units);
    const reversed = rules([system, agents, developer, user]);
    for (const unit of original.units.filter(unit => unit.kind !== "system")) {
      expect(reversed.units.find(next => next.identity === unit.identity)!.scope).not.toBe(unit.scope);
    }
    const moved = rules([system, user, developer, agents]);
    expect(moved.units.find(unit => unit.kind === "developer")!.scope).not.toBe(original.units.find(unit => unit.kind === "developer")!.scope);
    const a = message("a", "system"), b = message("b", "system");
    const order = rules([a, b]).units, swap = rules([b, a]).units;
    expect(swap.find(unit => unit.identity === order[0]!.identity)!.scope).not.toBe(order[0]!.scope);
  });

  test("repeated user text remains two independent complete events and diagnostics stay bounded", () => {
    const parsed = request(Array.from({ length: 100 }, (_, index) => message(`event-${index}`, "user", "Continue.")));
    const before = structuredClone(parsed);
    const result = contextRuleSources(parsed, parsed);
    expect(result.units).toEqual([]);
    expect(parsed).toEqual(before);
    expect(parsed.context.messages).toHaveLength(100);
    expect(result.misses).toHaveLength(32);
    expect(result.misses.at(-1)).toEqual({ reason: "additional_misses", count: 69 });
  });

  test("only verified pure Native AGENTS metadata classifies a user rule, without granting cross-ID identity", () => {
    const agents = message("agents", "user", "# AGENTS.md instructions\nRule.", metadata("agents_md.instructions"));
    const valid = rules([agents]).units[0]!;
    expect(valid).toMatchObject({ kind: "native_agents_md", role: "user", position: { message_index: 0 } });
    expect(rules([{ ...agents, id: "different" }]).units[0]!.identity).not.toBe(valid.identity);
    const invalid = [
      message("marker", "user", "# AGENTS.md instructions\nRule.", { stable: true, role_hint: "developer" }),
      message("fake", "user", "Rule.", { metadata: { stable: true, role: "system", content_item_kinds: ["agents_md.instructions"] } }),
      message("missing-turn", "user", "Rule.", { internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] } }),
      message("mixed", "user", "Rule and environment.", metadata("agents_md.instructions", { content_item_kinds: ["agents_md.instructions", "environments.environment_context"] })),
      message("skill", "user", "Skill instructions.", metadata("skills.selected_skill_instructions")),
    ];
    for (const source of invalid) expect(rules([source]).units).toEqual([]);
  });

  test("dynamic environment and output schema remain current data and leave independent rule versions stable", () => {
    const system = message("rule", "system", "Stable rule.");
    const environment = (cwd: string) => message("environment", "developer", cwd, metadata("environments.environment_context"));
    const first = rules([system, environment("/first")], { instructions: "Base.", text: { verbosity: "low" }, traceId: "first", context_id: "first", read_ref: "first", client_metadata: { turn_id: "first" } });
    const next = rules([system, environment("/next")], { instructions: "Base.", text: { verbosity: "high", format: { type: "json_schema", name: "result", schema: { type: "string" } } }, traceId: "next", context_id: "next", read_ref: "next", client_metadata: { turn_id: "next" } });
    expect(next.units).toEqual(first.units);
    expect(first.units.map(unit => unit.kind)).toEqual(["instructions", "system"]);
    expect(first.misses.map(miss => miss.reason)).toContain("unsupported_rule_kind");
  });

  test("Native window and deferred-tool state stay complete current data while generic environment guidance remains independent", () => {
    const generic = message("generic", "developer", "Stable rule.", metadata("generic.developer_instructions"));
    const environment = message("environment-guidance", "developer", "## Execution environments\nUse the selected execution environments.", metadata("environments.instructions"));
    const after = message("after", "developer", "Another stable rule.", metadata("generic.developer_instructions"));
    const current = message("task", "user", "Current task.");
    const fields = [
      ["token_budget.context_window", "<context_window>Current context window id: first</context_window>", "<context_window>Current context window id: next</context_window>"],
      ["token_budget.context_window_guidance", "<context_window_guidance>Current guidance.</context_window_guidance>", "<context_window_guidance>Replacement guidance.</context_window_guidance>"],
      ["tools.deferred_namespaces", "<tools>Deferred tool namespaces:\n- first</tools>", "<tools>Added deferred tool namespaces:\n- next</tools>"],
    ] as const;
    for (const [kind, firstText, nextText] of fields) {
      const parse = (text: string) => request([generic, environment,
        message("current-state", "developer", [{ type: "input_text", text }], metadata(kind)), after, current], { instructions: "Base." });
      const first = parse(firstText), next = parse(nextText);
      const firstRules = contextRuleSources(first, first), nextRules = contextRuleSources(next, next);
      expect(firstRules.units.map(unit => unit.kind)).toEqual(["instructions", "developer", "developer", "developer"]);
      expect(nextRules.units).toEqual(firstRules.units);
      expect(nextRules.misses).toContainEqual({ reason: "unsupported_rule_kind", position: { message_index: 2 } });
      expect(first.context.messages[2]!.content).toBe(firstText);
      expect(next.context.messages[2]!.content).toBe(nextText);
      const mixed = request([message("mixed", "developer", [
        { type: "input_text", text: "Stable rule." }, { type: "input_text", text: firstText },
      ], metadata(kind, { content_item_kinds: ["generic.developer_instructions", kind] }))]);
      expect(contextRuleSources(mixed, mixed).units).toEqual([]);
      expect(mixed.context.messages[0]!.content).toEqual([{ type: "text", text: "Stable rule." }, { type: "text", text: firstText }]);
    }
  });

  test("trusted selected candidates map exact current positions even when earlier rules are omitted", () => {
    const input = [message("omit", "system", "Omitted rule."), message("keep", "system", "Selected rule."),
      message("developer", "developer"), message("old", "user", "Old."), message("current", "user", "New.")];
    const parsed = request(input, { instructions: "Base." });
    const selected = [input[1]!, input[2]!, input[4]!].map((item, index) => {
      const clone = structuredClone(item);
      bindContextInstructionInputSource(parsed, clone, [1, 2, 4][index]!);
      return clone;
    });
    const candidate = continuityContextCandidate(parsed, selected);
    const result = contextRuleSources(parsed, candidate);
    expect(result.units.map(unit => [unit.kind, unit.position])).toEqual([
      ["instructions", { system_index: 0 }], ["system", { system_index: 1 }], ["developer", { message_index: 0 }],
    ]);
    expect(candidate.context.messages.map(item => item.content)).toEqual(["Exact rules.", "New."]);
  });

  test("trusted full and accepted clones preserve proof, copied and mutated candidates do not", () => {
    const parsed = request([message("system", "system"), message("task", "user")], { instructions: "Base." });
    const clone = bindContextFullCandidate(parsed, structuredClone(parsed));
    expect(contextRuleSources(parsed, clone).units).toEqual(contextRuleSources(parsed, parsed).units);
    const accepted = continuityAcceptedContextCandidate(parsed, clone);
    expect(contextRuleSources(contextCandidateCanonicalSource(parsed, accepted)!, accepted).units).toHaveLength(2);
    expect(contextRuleSources(parsed, structuredClone(clone)).units).toEqual([]);
    (clone._rawBody as Record<string, unknown>).instructions = "Changed raw instructions.";
    expect(contextRuleSources(parsed, clone).units).toEqual([]);
    const tampered = structuredClone(parsed);
    (tampered._rawBody as Record<string, unknown>).instructions = "Forged raw instructions.";
    expect(() => bindContextFullCandidate(parsed, tampered)).toThrow();
    (parsed._rawBody as { input: Record<string, unknown>[] }).input[0]!.stable = true;
    expect(contextRuleSources(parsed, parsed).units).toEqual([]);
  });

  test("a candidate that reverses equal-text sources cannot retain their original priority proof", () => {
    const input = [message("a", "system"), message("b", "system"), message("c", "developer"), message("d", "developer")];
    const parsed = request(input, { instructions: "Base." });
    const selected = [1, 0, 3, 2].map(index => {
      const clone = structuredClone(input[index]!);
      bindContextInstructionInputSource(parsed, clone, index);
      return clone;
    });
    const candidate = continuityContextCandidate(parsed, selected);
    const result = contextRuleSources(parsed, candidate);
    expect(result.units.map(unit => unit.kind)).toEqual(["instructions"]);
    expect(result.misses.map(miss => miss.reason)).toEqual(Array(4).fill("rule_priority_unproven"));
  });

  test("verified recovery restores real rule proof without promoting the synthetic recovery status", () => {
    const current = message("task", "user", "Current request.");
    const parsed = request([current], { instructions: "Base." });
    const recovered = structuredClone(parsed);
    recovered.context.systemPrompt = ["Base.", "Trusted recovery status."];
    const retained = [message("retained-system", "system", "Retained rule."), current];
    const candidate = continuityRecoveredContextCandidate(parsed, recovered, undefined, retained);
    const canonical = contextCandidateCanonicalSource(parsed, candidate)!;
    const result = contextRuleSources(canonical, candidate);
    expect(result.units.map(unit => [unit.kind, unit.position])).toEqual([
      ["instructions", { system_index: 0 }], ["system", { system_index: 1 }],
    ]);
    expect(candidate.context.systemPrompt).toEqual(["Base.", "Retained rule.", "Trusted recovery status."]);
    const retry = continuityAcceptedContextCandidate(parsed, candidate);
    expect(contextRuleSources(canonical, retry).units).toEqual(result.units);
  });

  test("recovery proves appended system positions when retained raw order differs from the existing candidate order", () => {
    const current = message("task", "user", "Current request.");
    const present = message("present-system", "system", "Present rule.");
    const restored = message("restored-system", "system", "Restored rule.");
    const parsed = request([present, current], { instructions: "Base." });
    const recovered = structuredClone(parsed);
    recovered.context.systemPrompt = [...parsed.context.systemPrompt!, "Trusted recovery status."];
    const candidate = continuityRecoveredContextCandidate(parsed, recovered, undefined, [restored, present, current]);
    const canonical = contextCandidateCanonicalSource(parsed, candidate)!;
    expect(candidate.context.systemPrompt).toEqual(["Base.", "Present rule.", "Restored rule.", "Trusted recovery status."]);
    const result = contextRuleSources(canonical, candidate);
    expect(result.units.map(unit => unit.position)).toEqual([{ system_index: 0 }, { system_index: 1 }, { system_index: 2 }]);
    const expected = rules([present, restored, current], { instructions: "Base." });
    expect(result.units).toEqual(expected.units);
  });
});
