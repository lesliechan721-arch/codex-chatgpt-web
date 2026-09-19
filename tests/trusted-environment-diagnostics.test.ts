import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MissingTrustedCodexEnvironmentError,
  TrustedCodexEnvironmentValidationError,
  trustedEnvironmentRequestDetails,
  trustedEnvironmentRequestFingerprint,
} from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore, trustedEnvironmentFailureDetails, type ChatGptEnvironmentResolutionDiagnostics } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";

const home = mkdtempSync(join(tmpdir(), "environment-diagnostics-"));
const root = resolve(home, "private-workspace");
const threadId = "01a06c66-0000-75c6-a0df-318f890ef6de";
const turnId = "01a06c66-0001-75c6-a0df-318f890ef6de";
const environment = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
afterAll(() => rmSync(home, { recursive: true, force: true }));

function request(xml?: string, metadata: Record<string, unknown> = {}) {
  return parseRequest({
    model: "gpt-5.6-sol", stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn", thread_id: threadId, turn_id: turnId,
      sandbox: "none", workspaces: { [root]: {} }, ...metadata,
    }) },
    input: [
      ...(xml === undefined ? [] : [{ id: "msg_environment", text: xml }]),
      { id: "msg_user", text: "private-user-prompt" },
    ].map(({ id, text }) => ({
      type: "message", role: "user", id,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    })),
  });
}

test("trusted environment diagnostics distinguish missing authority and conflicting authority", () => {
  expect(trustedEnvironmentFailureDetails(new MissingTrustedCodexEnvironmentError("cwd")))
    .toEqual({ errorType: "MissingTrustedCodexEnvironmentError", reason: "missing_cwd" });
  expect(trustedEnvironmentFailureDetails(new TrustedCodexEnvironmentValidationError(
    "ChatGPT web cwd must contain absolute paths",
  ))).toEqual({ errorType: "TrustedCodexEnvironmentValidationError", reason: "relative_cwd" });
  expect(trustedEnvironmentFailureDetails(new TrustedCodexEnvironmentValidationError(
    "Compaction continuation environment conflicts with its current Codex rollout",
  ))).toEqual({
    errorType: "TrustedCodexEnvironmentValidationError",
    reason: "compaction_authority_conflict",
  });
});

test("trusted environment diagnostics classify rollout metadata conflicts by owner and field", () => {
  const cases = [
    ["ChatGPT Web thread sandbox metadata conflicts with its Codex rollout", "rollout_thread_sandbox_conflict"],
    ["ChatGPT Web thread workspace metadata does not contain its Codex rollout cwd", "rollout_thread_cwd_conflict"],
    ["ChatGPT Web thread workspace metadata conflicts with its Codex rollout roots", "rollout_thread_roots_conflict"],
    ["ChatGPT Web subagent sandbox metadata conflicts with its Codex rollout", "rollout_subagent_sandbox_conflict"],
    ["ChatGPT Web subagent workspace metadata does not contain its Codex rollout cwd", "rollout_subagent_cwd_conflict"],
    ["ChatGPT Web subagent workspace metadata conflicts with its Codex rollout roots", "rollout_subagent_roots_conflict"],
  ] as const;
  for (const [message, reason] of cases) {
    expect(trustedEnvironmentFailureDetails(new TrustedCodexEnvironmentValidationError(message))).toEqual({
      errorType: "TrustedCodexEnvironmentValidationError",
      reason,
    });
  }
});

test("trusted environment diagnostics classify native and historical validation failures", () => {
  const cases = [
    ["Codex thread metadata contains an invalid native identifier", "invalid_native_identifier"],
    ["Codex environment history repeats a message id", "duplicate_historical_message_id"],
    ["Codex rollout does not authenticate the historical environment messages", "historical_environment_unrecorded"],
    ["Historical environment message differs from its native Codex record", "historical_environment_content_mismatch"],
  ] as const;
  for (const [message, reason] of cases) {
    expect(trustedEnvironmentFailureDetails(new TrustedCodexEnvironmentValidationError(message))).toEqual({
      errorType: "TrustedCodexEnvironmentValidationError",
      reason,
    });
  }
});

test("trusted environment diagnostics preserve safe IO codes but never private exception content", () => {
  const error = Object.assign(new Error("private path /users/secret and api-key-private-value"), { code: "EACCES" });
  expect(trustedEnvironmentFailureDetails(error)).toEqual({
    errorType: "Error", reason: "unclassified_environment_error", errorCode: "EACCES",
  });
  error.name = "private-error-name";
  error.code = "private-error-code";
  expect(trustedEnvironmentFailureDetails(error)).toEqual({ errorType: "UnknownError", reason: "unclassified_environment_error" });
  expect(trustedEnvironmentFailureDetails(new Error("constructor")))
    .toEqual({ errorType: "Error", reason: "unclassified_environment_error" });
});

test("request diagnostics distinguish missing envelopes, malformed cwd and cwd-less roots without contents", () => {
  expect(trustedEnvironmentRequestDetails(request())).toMatchObject({
    has_raw_environment_context: false, has_current_environment_context: false,
    request_kind: "turn", rollout_identity_available: true,
    cwd_count: 0, cwd_value_count: 0, workspace_roots_count: 0, root_count: 0,
  });
  const malformed = environment.replace(`<cwd>${root}</cwd>`, "<cwd/>");
  expect(trustedEnvironmentRequestDetails(request(malformed))).toMatchObject({
    has_raw_environment_context: true, has_current_environment_context: true,
    cwd_count: 1, cwd_value_count: 0, workspace_roots_count: 1, root_count: 1,
    environment_messages_with_id: 1, environment_messages_with_turn_id: 1,
  });
  expect(trustedEnvironmentRequestDetails(request(environment.replace(`<cwd>${root}</cwd>`, ""))))
    .toMatchObject({ has_raw_environment_context: true, cwd_count: 0, root_count: 1 });

  const details = trustedEnvironmentRequestDetails(request(environment, { request_kind: "private-api-key" }));
  expect(details.request_kind).toBe("unknown");
  expect(details.rollout_identity_available).toBe(false);
  const logged = JSON.stringify(details);
  for (const value of [root, "private-api-key", "private-user-prompt", threadId, turnId, "msg_environment"]) {
    expect(logged).not.toContain(value);
  }
});

test("request fingerprint is stable from bounded structure and never serializes message content", () => {
  const first = request(environment);
  const second = structuredClone(first);
  const secondBody = second._rawBody as { input: Array<Record<string, unknown>> };
  const content = secondBody.input[1]!.content as Array<Record<string, unknown>>;
  content[0]!.text = "x".repeat(2_000_000);
  secondBody.input[1]!.unused = secondBody;

  expect(trustedEnvironmentRequestFingerprint(second)).toBe(trustedEnvironmentRequestFingerprint(first));
  expect(trustedEnvironmentRequestDetails(second)).toMatchObject({
    input_items: 2, environment_messages: 1, cwd_count: 1, root_count: 1,
  });
});

test("a rejected current update reports that recovery was blocked even with a valid cache", () => {
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, home);
  store.resolve(request(environment));
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  expect(() => store.resolve(request(environment.replace(`<cwd>${root}</cwd>`, "<cwd/>")), diagnostics))
    .toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toEqual({
    recovery_stage: "current_update_rejected", rollout_lookup: "not_attempted",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("environment-less requests distinguish rollout misses from unavailable metadata and cache hits", () => {
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, home);
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  expect(() => store.resolve(request(), diagnostics)).toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toMatchObject({ recovery_stage: "thread_cache", rollout_lookup: "miss", thread_cache_lookup: "miss" });
  expect(() => store.resolve(request(undefined, { request_kind: undefined }), diagnostics))
    .toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toMatchObject({ rollout_lookup: "identity_unavailable", thread_cache_lookup: "miss" });
  store.resolve(request(environment));
  expect(store.resolve(request(), diagnostics).cwd).toBe(root);
  expect(diagnostics).toMatchObject({ rollout_lookup: "miss", thread_cache_lookup: "hit" });
});

test("unproven historical XML reports its cache block instead of looking like a current update", () => {
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, home);
  store.resolve(request(environment));
  const historical = request(environment);
  const input = (historical._rawBody as { input: Array<{ internal_chat_message_metadata_passthrough: { turn_id: string } }> }).input;
  input[0]!.internal_chat_message_metadata_passthrough.turn_id = "01a06c66-0002-75c6-a0df-318f890ef6de";
  expect(trustedEnvironmentRequestDetails(historical)).toMatchObject({
    has_raw_environment_context: true, has_current_environment_context: false,
  });
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  expect(() => store.resolve(historical, diagnostics)).toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toMatchObject({
    recovery_stage: "raw_context_rejected", rollout_lookup: "miss", thread_cache_lookup: "not_attempted",
  });
});
