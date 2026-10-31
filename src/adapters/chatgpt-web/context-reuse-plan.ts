import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { contextRuleSources } from "./context-rule-sources";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { appendFixedContextRecords, deterministicContextJson, type ContextSnapshot } from "./context-snapshot";
import { CONTEXT_REUSE_MAX_UNITS, CONTEXT_REUSE_PROTOCOL,
  type ContextReuseBaseline, type ContextReusePlan, type ContextReuseUnit } from "./context-reuse-types";
import { boundedContextReuse } from "./context-reuse-lifecycle";

const digest = (value: unknown): string => createHash("sha256").update(deterministicContextJson(value)).digest("hex");
type Prepared = NonNullable<CompiledChatGptWebPrompt["bootstrapContent"]>;
interface UnitDraft extends ContextReuseUnit {
  text: string;
  encoding: "utf-8" | "deterministic-json";
  path?: ["system" | "messages", number];
  reused: boolean;
}

/** Body-free metadata is bounded before admitting units to the page baseline. */
export function prepareContextReuse(input: {
  canonical: CodexParsedRequest; candidate: CodexParsedRequest; prepared: Prepared;
  snapshot: ContextSnapshot; planId: string; baseline?: ContextReuseBaseline; maxStorageBytes: number;
  referenceNamespace?: string;
}) {
  const rules = contextRuleSources(input.canonical, input.candidate);
  const baseline = new Map(input.baseline?.units.map(unit => [unit.unit_id, unit]));
  const drafts: UnitDraft[] = [];
  const missCounts: Record<string, number> = {};
  const miss = (reason: string, count = 1): void => { missCounts[reason] = (missCounts[reason] ?? 0) + count; };
  for (const item of rules.misses) miss(item.reason, item.count ?? 1);
  const add = (identity: string, kind: string, role: string, scope: string, text: string,
    encoding: UnitDraft["encoding"], sourceDigest?: string, path?: UnitDraft["path"]): void => {
    // Identity survives applicability changes; the complete fingerprint must still match.
    const unit: ContextReuseUnit = { unit_id: `unit_${digest({ identity })}`,
      fingerprint: digest({ identity, kind, role, scope, text, encoding, ...(sourceDigest ? { sourceDigest } : {}) }),
      kind, role, scope, utf8_bytes: Buffer.byteLength(text) };
    if (drafts.length >= CONTEXT_REUSE_MAX_UNITS) {
      miss("cache_capacity"); return;
    }
    const old = baseline.get(unit.unit_id);
    const reused = !!old && old.fingerprint === unit.fingerprint && old.kind === kind && old.role === role && old.scope === scope;
    if (!reused) miss(!input.baseline ? "no_baseline" : !old ? "unit_not_in_baseline"
      : old.scope !== scope ? "scope_changed" : old.role !== role ? "role_changed"
      : old.kind !== kind ? "kind_changed" : "content_changed");
    drafts.push({ ...unit, text, encoding, ...(path ? { path } : {}), reused });
  };
  for (const unit of input.prepared.protocolUnits) add(unit.identity, unit.kind, unit.role, unit.scope, unit.text, "utf-8");
  // A full protocol must never be silently omitted due to the baseline capacity.
  if (drafts.length !== input.prepared.protocolUnits.length) return undefined;
  const identities = new Map<string, string>();
  for (const rule of rules.units) {
    let path: UnitDraft["path"];
    if ("system_index" in rule.position) path = ["system", rule.position.system_index];
    else {
      const index = input.prepared.messageSourceIndices.indexOf(rule.position.message_index);
      if (index < 0) { miss("prepared_source_unavailable"); continue; }
      path = ["messages", index];
    }
    const value = input.prepared.payload[path[0]][path[1]];
    if (value === undefined) { miss("prepared_source_unavailable"); continue; }
    const before = drafts.length;
    add(rule.identity, rule.kind, rule.role, rule.scope, deterministicContextJson(value), "deterministic-json", rule.sourceDigest, path);
    if (drafts.length > before) identities.set(rule.identity, drafts.at(-1)!.unit_id);
  }
  const currentSnapshots = () => rules.snapshots.filter(snapshot => snapshot.identities.every(identity =>
    drafts.some(unit => unit.unit_id === identities.get(identity))))
    .map(snapshot => ({ domain: snapshot.scope, state: snapshot.state,
      unit_ids: snapshot.identities.map(identity => identities.get(identity)!) }));
  const appendUnits = () => appendFixedContextRecords(input.snapshot, drafts.map(unit => ({ text: unit.text, encoding: unit.encoding,
    origin: "context_reuse_unit" as const, originalRole: unit.role })),
    { contextId: input.snapshot.context_id, maxStorageBytes: input.maxStorageBytes, referenceNamespace: input.referenceNamespace });
  let snapshots = currentSnapshots();
  let snapshot = appendUnits();
  let targets = snapshot.targets.slice(input.snapshot.targets.length);
  const makePlan = (inline: boolean): ContextReusePlan => {
    const reused = drafts.filter(unit => unit.reused);
    return { protocol: CONTEXT_REUSE_PROTOCOL, payload_format: "context-bootstrap-payload-v3", mode: reused.length ? "incremental" : "full",
      ...(reused.length ? { dependency: { baseline_id: input.baseline!.baseline_id, page_identity: input.baseline!.page_identity,
        predecessor: input.baseline!.predecessor, units: reused.map(({ unit_id, fingerprint }) => ({ unit_id, fingerprint })) } } : {}),
      units: drafts.map(({ text: _text, encoding: _encoding, path: _path, reused: reuse, ...unit }, index) => ({ ...unit,
        target_id: targets[index]!.target_id, delivery: reuse ? "reuse" : inline ? "inline" : "required" })), snapshots };
  };
  const boundedMetadata = (): boolean => {
    const units = drafts.map(({ text: _text, encoding: _encoding, path: _path, reused: _reused, ...unit }) => unit);
    // Scope evidence contains these exact current IDs. Published baseline/page IDs
    // are SHA-256 hex; recovery work IDs allow at most 256 ASCII characters.
    const evidence = { plan_id: input.planId, context_id: snapshot.context_id, units, snapshots };
    const futureBaseline = { baseline_id: "0".repeat(64), page_identity: "0".repeat(64), predecessor: "0".repeat(256), units, snapshots };
    return boundedContextReuse(makePlan(false)) && boundedContextReuse(makePlan(true))
      && boundedContextReuse(evidence) && boundedContextReuse(futureBaseline);
  };
  while (!boundedMetadata()) {
    const reused = drafts.findLast(unit => unit.reused);
    if (reused) {
      // Keep the unit in the next baseline, but deliver its body again instead of
      // growing the fixed dependency list beyond the complete-plan limit.
      reused.reused = false; miss("cache_capacity"); continue;
    }
    // Producer replacement rules precede ordinary rule sources, so evict those
    // ordinary sources first. Their exact values remain in the current payload.
    const evicted = drafts.findLastIndex(unit => !!unit.path);
    if (evicted < 0) return undefined; // The caller safely delivers the full v1 protocol/payload.
    drafts.splice(evicted, 1); miss("cache_capacity");
    snapshots = currentSnapshots(); snapshot = appendUnits();
    targets = snapshot.targets.slice(input.snapshot.targets.length);
  }
  const reusedUnits = drafts.filter(unit => unit.reused);
  const currentUnits = drafts.filter(unit => !unit.reused);
  const mode: ContextReusePlan["mode"] = reusedUnits.length ? "incremental" : "full";
  const payload = structuredClone(input.prepared.payload);
  for (const unit of drafts) if (unit.path) payload[unit.path[0]][unit.path[1]] = null as never;
  const references = drafts.map((unit, index) => ({ unit_id: unit.unit_id, fingerprint: unit.fingerprint, kind: unit.kind,
    role: unit.role, scope: unit.scope, utf8_bytes: unit.utf8_bytes, encoding: unit.encoding, source_completeness: "complete",
    target_id: targets[index]!.target_id, read_ref: targets[index]!.read_ref,
    delivery: unit.reused ? "reuse" : "current" }));
  const ruleReplacements = snapshots.flatMap(snapshot => {
    const previous = input.baseline?.snapshots.find(old => old.domain === snapshot.domain);
    const changedVersion = snapshot.unit_ids.some(id => {
      const current = drafts.find(unit => unit.unit_id === id);
      return current && baseline.get(id)?.fingerprint !== current.fingerprint;
    });
    return !previous || deterministicContextJson(previous) !== deterministicContextJson(snapshot) || changedVersion
      ? [{ ...snapshot, replaces: previous?.unit_ids ?? [] }] : [];
  });
  const makePayload = (inline: boolean, sourceMap: unknown) => ({ format: "context-bootstrap-payload-v3", mode,
    ...(reusedUnits.length ? { baseline: { baseline_id: input.baseline!.baseline_id,
      page_identity: input.baseline!.page_identity, predecessor: input.baseline!.predecessor } } : {}),
    payload, positions: drafts.flatMap(unit => unit.path ? [{ path: unit.path, unit_id: unit.unit_id }] : []),
    protocol_order: drafts.filter(unit => unit.kind === "protocol").map(unit => unit.unit_id),
    references, ...(inline ? { inline_units: currentUnits.map(unit => ({ unit_id: unit.unit_id, body: unit.text })) } : {}),
    output_control: { instructions: input.prepared.outputControl, verbosity: input.candidate.options.verbosity ?? null,
      output_format: input.candidate.options.outputFormat ?? null },
    rule_replacements: ruleReplacements, source_map: sourceMap });
  return { snapshot, makePlan, makePayload, diagnostics: {
    eligibleUnits: drafts.length, reusedUnits: reusedUnits.length,
    redeliveredUnits: currentUnits.length,
    reusedBodyBytes: reusedUnits.reduce((sum, unit) => sum + unit.utf8_bytes, 0),
    referenceBytes: Buffer.byteLength(deterministicContextJson(references)), missReasons: missCounts,
    byKind: Object.fromEntries([...new Set(drafts.map(unit => unit.kind))].map(kind => [kind, {
      reused: reusedUnits.filter(unit => unit.kind === kind).length,
      redelivered: currentUnits.filter(unit => unit.kind === kind).length,
    }])),
  } };
}
