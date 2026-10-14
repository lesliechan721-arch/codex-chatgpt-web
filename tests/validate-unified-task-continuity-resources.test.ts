import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { cleanupHoldExpression, CLEANUP_HOLD_TTL_MS, inspectOldLiveFencingEvidence, inspectRejectedResourceAppend, inspectResourcePressureEvidence, parseResourceLiveArgs, redactResourceEvidence, resourceLivePlan, validateInspectorEndpoint, type JournalEvidence, type PhysicalEvent } from "../scripts/validate-unified-task-continuity-resources";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { buildResponseJSON } from "../src/bridge";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { RESOURCE_SYNTHETIC_INSTRUCTIONS, resourceResponseObservation, summarizeResourcePreparedProtocol } from "../scripts/unified-task-continuity-resource-control";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test("public Responses runTurn rejection is HTTP 200 failed, while a preflight rejection is an HTTP error", async () => {
  const config = defaultConfig("full"); config.browserHost = "launcher";
  const request = () => new Request("http://resource-fixture.invalid/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    model: "chatgpt-web/gpt-6-sol-instant", stream: false, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "resource-envelope-fixture-thread", turn_id: "resource-envelope-fixture-turn" }) },
    input: [{ type: "message", role: "user", id: "resource-envelope-fixture-user", content: "Inert envelope fixture.",
      internal_chat_message_metadata_passthrough: { turn_id: "resource-envelope-fixture-turn" } }],
  }) });
  const rejectedAck = continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt.");
  // Only the adapter outcome is controlled. Production public parsing, routing, error
  // handling and Responses serialization determine the transport/envelope result.
  const response = await responseRequest(request(), config, () => ({ name: "local-error-fixture", async runTurn() { throw rejectedAck; } }), { rememberState: false });
  const envelope = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200); expect(response.ok).toBe(true);
  expect(envelope.status).toBe("failed");
  expect(inspectRejectedResourceAppend(response, envelope)).toMatchObject({ rejected: true, code: rejectedAck.code, representation: "failed-response" });
  const preflight = await responseRequest(request(), config, () => ({ name: "local-preflight-fixture", async preflight() { throw rejectedAck; }, async runTurn() { throw new Error("must not run"); } }), { rememberState: false });
  expect(preflight.status).toBe(409);
  expect(inspectRejectedResourceAppend(preflight, await preflight.json() as Record<string, unknown>)).toMatchObject({ rejected: true, representation: "http-error" });
});

test("actual prepared prompt keeps the business restriction and current public control protocol separate", () => {
  const privateToken = "turn_" + "P".repeat(32);
  const compiled = compileChatGptWebPrompt({ modelId: CHATGPT_WEB_MODEL_ID, stream: false, options: {},
    context: { systemPrompt: [RESOURCE_SYNTHETIC_INSTRUCTIONS], messages: [{ role: "user", content: "Complete the inert receipt task once.", timestamp: 1 }] } },
  { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, privateToken,
  { taskUpdateProtocol: 1, taskUpdateInitialState: { acceptedRevision: 3, acknowledgedRevision: 2 } });
  const summary = summarizeResourcePreparedProtocol(compiled.text);
  expect(summary).toMatchObject({ unique: true, protocol: "task-updates-v1", initialAcknowledgedRevision: 2,
    acceptedRevisionPresent: true, initialAcceptedRevision: 3, instructionsPresent: true, modelReadConfirmed: false });
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain(privateToken); expect(serialized).not.toContain("Complete the inert receipt task once.");
  expect(compiled.text).toContain("only permitted business operation");
  for (const name of ["codex_tool_inventory", "codex_tool_wait", "codex_task_update_ack"]) expect(compiled.text).toContain(name);
  expect(compiled.text).toContain("Never repeat it or access user files, URLs or shell commands");
  expect(compiled.text).toContain("exact acknowledged task_revision");
  expect(compiled.text).toContain("Never guess a delivery, revision or capability");
  expect(compiled.text).not.toContain("Only the inert receipt tool is permitted");
  const duplicated = summarizeResourcePreparedProtocol(compiled.text + '\n<codex_task_update_protocol_json>{"protocol":"task-updates-v1","task_revision":0}</codex_task_update_protocol_json>');
  expect(duplicated.unique).toBe(false); expect(duplicated.initialAcknowledgedRevision).toBeNull();
  expect(summarizeResourcePreparedProtocol("<codex_task_update_protocol_json>not-json</codex_task_update_protocol_json>").unique).toBe(false);
  const missing = summarizeResourcePreparedProtocol("<codex_task_update_protocol_json>{\"protocol\":\"task-updates-v1\",\"task_revision\":2}</codex_task_update_protocol_json>");
  expect(missing.acceptedRevisionPresent).toBe(false); expect(missing.initialAcceptedRevision).toBeNull();
});

test("public failed Responses observations retain serialized body digest and actual retryable absence/true/false without retrying ACK rejection", async () => {
  const config = defaultConfig("full");
  const encoded = JSON.stringify({ model: "chatgpt-web/gpt-6-sol-instant", stream: false, input: [{ role: "user", content: "Synthetic control observation." }] });
  const response = await responseRequest(new Request("http://resource-control.invalid/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: encoded }),
    config, () => ({ name: "local-ACK-fence", async runTurn() { throw new ChatGptWebAdapterError("The pending update requires an actual ACK.",
      { code: "task_update_unacknowledged", status: 409, errorType: "invalid_request_error", retryable: false }); } }), { rememberState: false });
  const envelope = await response.json() as Record<string, any>;
  expect(response.status).toBe(200); expect(envelope.status).toBe("failed");
  expect(resourceResponseObservation(encoded, response, envelope)).toMatchObject({ httpStatus: 200, status: "failed", code: "task_update_unacknowledged",
    retryablePresent: true, retryable: false, retryableType: "boolean" });
  const absent = { ...envelope }; delete absent.retryable;
  expect(resourceResponseObservation(encoded, response, absent)).toMatchObject({ retryablePresent: false, retryable: null, retryableType: "absent" });
  const actual = resourceResponseObservation(encoded, response, { ...envelope, retryable: true });
  expect(actual.retryable).toBe(true); expect(actual.bodyDigest).toBe(resourceResponseObservation(encoded, response, envelope).bodyDigest);
  expect(actual.bodyDigest).not.toBe(resourceResponseObservation(encoded + " ", response, envelope).bodyDigest);
  const privateValue = "turn_" + "S".repeat(32);
  const invalid = resourceResponseObservation(encoded, response, { ...envelope, retryable: { token: privateValue } });
  expect(invalid.retryableType).toBe("object"); expect(invalid.retryable).toBeNull(); expect(JSON.stringify(invalid)).not.toContain(privateValue);
});

test("old append rejection cannot accept completion, new business, final output, unknown or incomplete status", () => {
  const response = { ok: true, status: 200 };
  const rejectedAck = continuityError("continuity_source_unproven");
  const failed = buildResponseJSON([{ type: "text_delta", text: "Inert progress.", phase: "commentary" },
    { type: "error", message: rejectedAck.message, status: rejectedAck.status, errorType: rejectedAck.errorType, code: rejectedAck.code }], "chatgpt-web/gpt-6-sol-instant");
  expect(inspectRejectedResourceAppend(response, failed).rejected).toBe(true);
  const completed = buildResponseJSON([{ type: "done", stopReason: "stop", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  expect(inspectRejectedResourceAppend(response, completed).rejected).toBe(false);
  for (const envelope of [
    { ...failed, status: "completed" }, { ...failed, end_turn: true }, { ...failed, status: "incomplete" },
    { ...failed, status: "in_progress" }, { ...failed, error: null }, { ...failed, error: { code: "" } }, { ...failed, output: undefined },
    { ...failed, output: [{ type: "function_call" }] }, { ...failed, output: [{ type: "custom_tool_call" }] },
    { ...failed, output: [{ type: "tool_search_call" }] }, { ...failed, output: [{ type: "compaction" }] },
    { ...failed, output: [{ type: "message", phase: "final_answer" }] },
  ]) expect(inspectRejectedResourceAppend(response, envelope).rejected).toBe(false);
  expect(inspectRejectedResourceAppend({ ok: false, status: 503 }, { ...failed, status: "completed" }).rejected).toBe(false);
  expect(inspectRejectedResourceAppend({ ok: true, status: 202 }, failed).rejected).toBe(false);
});

test("production failed Responses with unphased assistant text cannot prove old append rejection", () => {
  const rejectedAck = continuityError("continuity_source_unproven");
  const error = { type: "error" as const, message: rejectedAck.message, status: rejectedAck.status,
    errorType: rejectedAck.errorType, code: rejectedAck.code };
  const failed = buildResponseJSON([{ type: "text_delta", text: "Old body output." }, error], "chatgpt-web/gpt-6-sol-instant");
  expect(failed.status).toBe("failed");
  expect(failed.output).toMatchObject([{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Old body output." }] }]);
  const output = failed.output as Record<string, unknown>[];
  expect(output[0]).not.toHaveProperty("phase");
  for (const response of [{ ok: true, status: 200 }, { ok: false, status: 409 }]) {
    expect(inspectRejectedResourceAppend(response, failed).rejected).toBe(false);
    for (const phase of ["unknown", "analysis", null]) {
      expect(inspectRejectedResourceAppend(response, { ...failed, output: [{ ...output[0], phase }] }).rejected).toBe(false);
    }
    const commentary = buildResponseJSON([{ type: "text_delta", text: "Inert progress.", phase: "commentary" }, error], "chatgpt-web/gpt-6-sol-instant");
    expect(inspectRejectedResourceAppend(response, commentary).rejected).toBe(true);
    expect(inspectRejectedResourceAppend(response, buildResponseJSON([error], "chatgpt-web/gpt-6-sol-instant")).rejected).toBe(true);
  }
});

test("evidence and errors remove exact opaque authorizations plus uncollected capability prefixes", () => {
  const sendAuthorization = "ab".repeat(24), control = "private-control-token", delivery = "delivery_" + "D".repeat(32);
  const value = JSON.stringify({ error: `authorization=${sendAuthorization}; bearer=${control}; delivery=${delivery}; binding_${"B".repeat(32)}`, state: "completed", digest: "ff".repeat(32) });
  const redacted = redactResourceEvidence(value, [sendAuthorization, control, delivery, ""]);
  for (const secret of [sendAuthorization, control, delivery, "binding_" + "B".repeat(32)]) expect(redacted).not.toContain(secret);
  expect(JSON.parse(redacted).state).toBe("completed");
  expect(JSON.parse(redacted).digest).toBe("ff".repeat(32));
});

test("default/check/plan cannot start live sends, and explicit run has strict bounded cases", () => {
  expect(parseResourceLiveArgs([])).toEqual({ action: "check" });
  expect(parseResourceLiveArgs(["--check-only"])).toEqual({ action: "check" });
  expect(parseResourceLiveArgs(["plan"])).toEqual({ action: "plan" });
  expect(() => parseResourceLiveArgs(["--case=five-page-pressure"])).toThrow("run");
  const valid = ["run", "--case=five-page-pressure", "--mode=automatic", "--model=chatgpt-web/gpt-6-sol-instant"];
  expect(parseResourceLiveArgs(valid).action).toBe("run");
  expect(() => parseResourceLiveArgs([...valid, "--case=old-live-fencing"])).toThrow("run");
  expect(() => parseResourceLiveArgs([...valid, "--close-original=true"])).toThrow("run");
  expect(() => parseResourceLiveArgs(valid.map(value => value === "--mode=automatic" ? "--mode=zero-risk" : value))).toThrow("Send/Sent");
  expect(() => parseResourceLiveArgs(valid.map(value => value.startsWith("--model=") ? "--model=chatgpt-web-continuity/gpt-6-sol-instant" : value))).toThrow("旧模式");
  expect(() => parseResourceLiveArgs(["plan", "--model=x"])).toThrow("不接受参数");
  expect(() => parseResourceLiveArgs([...valid, "--launcher-inspector=http://127.0.0.1:9239"])).toThrow("仅适用于");
  expect(parseResourceLiveArgs([...valid.map(value => value === "--case=five-page-pressure" ? "--case=old-live-fencing" : value), "--launcher-inspector=http://127.0.0.1:9239"]).action).toBe("run");
});

function evidence() {
  const targets = Array.from({ length: 6 }, (_, index) => `native-target-${index + 1}`);
  const events: PhysicalEvent[] = [{ sequence: 0, kind: "baseline", physicalCount: 0 }];
  for (let task = 1; task <= 5; task++) events.push({ sequence: task, task, kind: "created", targetId: targets[task - 1], physicalCount: task });
  events.push({ sequence: 6, task: 6, kind: "destroyed", targetId: targets[0], physicalCount: 4 },
    { sequence: 7, task: 6, kind: "created", targetId: targets[5], physicalCount: 5 });
  for (let index = 1; index < 6; index++) events.push({ sequence: index + 7, kind: "destroyed", targetId: targets[index], physicalCount: 5 - index });
  const row = (task: number, label: string): JournalEvidence => ({ task, label, workDigest: `work-${task}`, epoch: 0, historyRevision: 0,
    taskRevision: 0, state: "completed", stopReason: null, terminalDigest: `answer-${task}`, terminalReceiptDigest: `receipt-${task}`,
    attempts: [{ attempt: 0, epoch: 0, stage: "completed", writerRetired: true }], calls: [{ callId: `call-${task}`, state: "settled", firstResultDigest: `result-${task}` }] });
  const journals = Array.from({ length: 6 }, (_, index) => [row(index + 1, "completed"), row(index + 1, "after-cleanup")]).flat();
  return { targets, events, journals, results: Array.from({ length: 6 }, (_, index) => ({ task: index + 1, callId: `call-${index + 1}`, firstResultDigest: `result-${index + 1}` })), cleanupTargets: targets.slice(1), baselinePreserved: true };
}

test("capacity oracle requires exact destruction before sixth creation, five retained pages and only owned cleanup", () => {
  expect(inspectResourcePressureEvidence(evidence()).passed).toBe(true);
  const missing = evidence(); missing.events = missing.events.filter(event => event.targetId !== missing.targets[0] || event.kind !== "destroyed");
  expect(inspectResourcePressureEvidence(missing).passed).toBe(false);
  const late = evidence(); late.events[6]!.sequence = 8;
  expect(inspectResourcePressureEvidence(late).passed).toBe(false);
  const overflow = evidence(); overflow.events[7]!.physicalCount = 6;
  expect(inspectResourcePressureEvidence(overflow).passed).toBe(false);
  const notFull = evidence(); notFull.events[5]!.physicalCount = 4;
  expect(inspectResourcePressureEvidence(notFull).passed).toBe(false);
  const external = evidence(); external.cleanupTargets[0] = "unowned-target";
  expect(inspectResourcePressureEvidence(external).passed).toBe(false);
  const originalChanged = evidence(); originalChanged.baselinePreserved = false;
  expect(inspectResourcePressureEvidence(originalChanged).passed).toBe(false);
});

test("capacity oracle retains completed journal, stop, revisions, attempt and real first-result facts", () => {
  for (const mutate of [
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.terminalDigest = "reset"; },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.state = "active"; },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.stopReason = "page-close"; },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.taskRevision++; },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.attempts.push({ attempt: 1, epoch: 1, stage: "prepared", writerRetired: false }); },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.calls[0]!.firstResultDigest = "different"; },
    (value: ReturnType<typeof evidence>) => { value.results.push(value.results[0]!); },
    (value: ReturnType<typeof evidence>) => { value.journals[1]!.calls.push({ callId: "reexecuted", state: "settled", firstResultDigest: "extra" }); },
  ]) {
    const value = evidence(); mutate(value); expect(inspectResourcePressureEvidence(value).passed).toBe(false);
  }
});

test("plan states real sends and outstanding physical/manual boundaries", () => {
  const plan = resourceLivePlan();
  expect(plan.casesDetails["five-page-pressure"].expectedInitialModelSends).toBe(6);
  expect(plan.casesDetails["five-page-pressure"].expectedResponsesRequests).toBe(12);
  expect(plan.casesDetails["old-live-fencing"].boundary).toContain("partial");
  expect(plan.casesDetails["user-close-stop"].boundary).toContain("human");
  expect(plan.gaps.join(" ")).toContain("Zero Risk");
});

test("main inspector endpoints cannot use non-loopback hosts, credentials, paths or redirected sockets", () => {
  expect(validateInspectorEndpoint("http://127.0.0.1:9239").port).toBe("9239");
  for (const endpoint of ["http://localhost:9239", "http://0.0.0.0:9239", "https://127.0.0.1:9239", "http://127.0.0.1", "http://secret@127.0.0.1:9239", "http://127.0.0.1:9239/api", "http://127.0.0.1:9239?token=secret"])
    expect(() => validateInspectorEndpoint(endpoint)).toThrow();
});

function holdFixture() {
  let ownClosed = 0, otherClosed = 0, timer: (() => void) | undefined;
  const ownClose = function () { ownClosed++; };
  const owned = { close: ownClose, isDestroyed: () => false, getOrCreateDevToolsTargetId: () => "own-native-target" };
  const other = { close: () => { otherClosed++; } };
  const instance = { pid: 123, instanceId: "current-instance", startIdentity: "verified-start" };
  const descriptor = { pid: 123, profile: "development", launcherInstance: instance, surfaceTargets: { ownSurface: "own-native-target" } };
  const context: Record<string, any> = { process: { pid: 123 }, require: (name: string) => name === "node:fs" ? { readFileSync: () => JSON.stringify(descriptor) }
    : { webContents: { fromDevToolsTargetId: (target: string) => target === "own-native-target" ? owned : undefined, getAllWebContents: () => [owned, other] } },
    setTimeout: (callback: () => void) => { timer = callback; return { unref() {} }; }, clearTimeout() {} };
  const expression = cleanupHoldExpression({ key: "testHold", descriptorPath: "/fixture/descriptor", pid: 123, instance, surfaceId: "ownSurface", targetId: "own-native-target" });
  return { expression, context, owned, other, ownClose, instance, descriptor, get ownClosed() { return ownClosed; }, get otherClosed() { return otherClosed; }, expire: () => timer!() };
}

test("local safety check: hold throws on only the exact target, restores its method at fixed TTL and physically closes once", () => {
  const fixture = holdFixture();
  const installed = runInNewContext(fixture.expression, fixture.context);
  expect(installed.ttlMs).toBe(CLEANUP_HOLD_TTL_MS);
  expect(() => fixture.owned.close()).toThrow("controlled-unified-resource");
  fixture.other.close(); expect(fixture.otherClosed).toBe(1); expect(fixture.ownClosed).toBe(0);
  fixture.expire(); expect(fixture.owned.close).toBe(fixture.ownClose); expect(fixture.ownClosed).toBe(1);
  expect(fixture.context.testHold.restoreReason).toBe("fixed-TTL");
  fixture.expire(); expect(fixture.ownClosed).toBe(1);
});

test("local safety check: mismatched identity or newer close owner cannot be overwritten", () => {
  const mismatch = holdFixture(); mismatch.descriptor.profile = "production";
  expect(() => runInNewContext(mismatch.expression, mismatch.context)).toThrow("exact DEV identity mismatch");
  expect(mismatch.owned.close).toBe(mismatch.ownClose); expect(mismatch.context.testHold).toBeUndefined();
  const replaced = holdFixture(); runInNewContext(replaced.expression, replaced.context);
  const newer = () => {}; replaced.owned.close = newer;
  replaced.expire(); expect(replaced.owned.close).toBe(newer); expect(replaced.ownClosed).toBe(0);
  expect(replaced.context.testHold.restoreReason).toBe("target-close-owner-changed");
});

test("old-live oracle requires real pending ACK, exact successor revision/ACK, physical overlap and actual bounded cleanup fault", () => {
  const valid = () => ({ pending: { real: true, throughRevision: 1, beforeAcknowledgedRevision: 0, afterOldProbesAcknowledgedRevision: 0 },
    probes: ["tool", "ACK", "final"].map(boundary => ({ boundary, rejected: true, obsolete: true, presentBefore: true, presentAfter: true })),
    successor: { originalTarget: "native-old", target: "native-new", oldPresentAtCompletion: true,
      revisions: { logicalWorkAcceptedTaskRevision: 2 as number | null, retiredLogicalWorkAcceptedTaskRevision: 2 as number | null,
        connectorAcceptedRevision: 1 as number | null, connectorAcknowledgedRevision: 1 as number | null,
        protocolAcceptedRevision: 1 as number | null, protocolAcknowledgedRevision: 1 as number | null },
      state: "completed", stopped: false, sameRetiredWork: true, historyPreserved: true, epochAdvanced: true },
    closeFault: { controlled: true, attempts: 3, state: "failed" } });
  expect(inspectOldLiveFencingEvidence(valid()).passed).toBe(true);
  for (const mutate of [
    (value: ReturnType<typeof valid>) => { value.pending.real = false; },
    (value: ReturnType<typeof valid>) => { value.pending.afterOldProbesAcknowledgedRevision = 1; },
    (value: ReturnType<typeof valid>) => { value.probes[1]!.obsolete = false; },
    (value: ReturnType<typeof valid>) => { value.successor.oldPresentAtCompletion = false; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.connectorAcknowledgedRevision = null; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.connectorAcceptedRevision = 2; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.protocolAcknowledgedRevision = 0; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.protocolAcceptedRevision = null; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.logicalWorkAcceptedTaskRevision = 1; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.logicalWorkAcceptedTaskRevision = null; },
    (value: ReturnType<typeof valid>) => { value.successor.revisions.retiredLogicalWorkAcceptedTaskRevision = null; },
    (value: ReturnType<typeof valid>) => { value.successor.stopped = true; },
    (value: ReturnType<typeof valid>) => { value.closeFault.attempts = 4; },
  ]) { const value = valid(); mutate(value); expect(inspectOldLiveFencingEvidence(value).passed).toBe(false); }
});
