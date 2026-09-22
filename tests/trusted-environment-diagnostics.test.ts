import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
      internal_chat_message_metadata_passthrough: {
        turn_id: turnId,
        content_item_kinds: [id === "msg_environment" ? "environments.environment_context" : "user.text"],
      },
    })),
  });
}

function createIndexedRollout(options: {
  codexHome: string;
  threadId: string;
  rolloutPath: string;
  agentPath?: string;
  parentThreadId?: string;
}): void {
  mkdirSync(options.codexHome, { recursive: true });
  const database = new Database(join(options.codexHome, "state_5.sqlite"), { create: true });
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, agent_path TEXT)");
  database.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
  database.query("INSERT INTO threads (id, rollout_path, agent_path) VALUES (?, ?, ?)")
    .run(options.threadId, options.rolloutPath, options.agentPath ?? null);
  if (options.parentThreadId) {
    database.query("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)")
      .run(options.parentThreadId, options.threadId, "open");
  }
  database.close();
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

test("a current cwd-less rollout marker recovers only from the matching native turn", () => {
  const codexHome = join(home, "rollout-marker-codex-home");
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "vscode" } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: root,
        workspace_roots: [root],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n");

  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  expect(store.resolve(request(marker), diagnostics)).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });

  for (const rejected of [
    "<environment_context><cwd/></environment_context>",
    "<environment_context><sandbox_mode>read-only</sandbox_mode></environment_context>",
    "<environment_context><permission_profile type=\"managed\"><file_system type=\"restricted\" /></permission_profile></environment_context>",
  ]) {
    expect(() => store.resolve(request(rejected), diagnostics))
      .toThrow(MissingTrustedCodexEnvironmentError);
    expect(diagnostics).toEqual({
      recovery_stage: "current_update_rejected", rollout_lookup: "not_attempted",
      thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
    });
  }

  const mixed = request(marker);
  const mixedInput = (mixed._rawBody as { input: Array<Record<string, unknown>> }).input;
  mixedInput.splice(1, 0, {
    type: "message", role: "user", id: "msg_malformed_environment",
    content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ["environments.environment_context"],
    },
  });
  expect(() => store.resolve(mixed, diagnostics)).toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toEqual({
    recovery_stage: "current_update_rejected", rollout_lookup: "not_attempted",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });

  const humanMarker = request(marker);
  const humanInput = (humanMarker._rawBody as {
    input: Array<{ internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] } }>;
  }).input;
  humanInput[0]!.internal_chat_message_metadata_passthrough!.content_item_kinds = ["user.text"];
  expect(() => store.resolve(humanMarker, diagnostics)).toThrow(MissingTrustedCodexEnvironmentError);
  expect(diagnostics).toEqual({
    recovery_stage: "current_update_rejected", rollout_lookup: "not_attempted",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("a current cwd-less rollout marker tolerates a published rollout before turn_context is complete", async () => {
  const codexHome = join(home, "delayed-rollout-marker-codex-home");
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-00-00-${threadId}.jsonl`);
  const sessionMeta = JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "cli" } }) + "\n";
  const turnContext = JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: root,
      workspace_roots: [root],
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      model: "chatgpt-web/pro",
      summary: "auto",
    },
  }) + "\n";
  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { dirname } from 'node:path';",
      "await Bun.sleep(40);",
      "mkdirSync(dirname(process.env.TEST_ROLLOUT_PATH!), { recursive: true });",
      "writeFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_SESSION_META!);",
      "await Bun.sleep(80);",
      "appendFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_TURN_CONTEXT!);",
    ].join(" ")],
    env: {
      ...process.env,
      TEST_ROLLOUT_PATH: rolloutPath,
      TEST_SESSION_META: sessionMeta,
      TEST_TURN_CONTEXT: turnContext,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 10);
  const resolving = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(request(marker), diagnostics);
  await Bun.sleep(30);
  expect(timerFired).toBe(true);
  const resolved = await resolving;
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());

  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("a current child rollout marker tolerates delayed canonical rollout publication", async () => {
  const codexHome = join(home, "delayed-child-rollout-marker-codex-home");
  const childThreadId = "01a06c66-1000-75c6-a0df-318f890ef6de";
  const childTurnId = "01a06c66-1001-75c6-a0df-318f890ef6de";
  const parentThreadId = "01a06c66-1002-75c6-a0df-318f890ef6de";
  const agentName = "/root/child";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-10-00-${childThreadId}.jsonl`);
  const rollout = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: childThreadId,
        parent_thread_id: parentThreadId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: agentName } } },
        thread_source: "subagent",
        agent_path: agentName,
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: childTurnId,
        cwd: root,
        workspace_roots: [root],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n";
  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { dirname } from 'node:path';",
      "await Bun.sleep(40);",
      "mkdirSync(dirname(process.env.TEST_ROLLOUT_PATH!), { recursive: true });",
      "writeFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_ROLLOUT_BODY!);",
    ].join(" ")],
    env: { ...process.env, TEST_ROLLOUT_PATH: rolloutPath, TEST_ROLLOUT_BODY: rollout },
    stdout: "ignore",
    stderr: "pipe",
  });
  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  const child = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: childThreadId,
      turn_id: childTurnId,
      parent_thread_id: parentThreadId,
      agent_name: agentName,
      subagent_kind: "thread_spawn",
      sandbox_mode: "danger-full-access",
      workspaces: { [root]: {} },
    }) },
    input: [
      { id: "msg_environment", text: marker, kind: "environments.environment_context" },
      { id: "msg_user", text: "private-user-prompt", kind: "user.text" },
    ].map(({ id, text, kind }) => ({
      type: "message",
      role: "user",
      id,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: childTurnId, content_item_kinds: [kind] },
    })),
  });

  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const resolved = await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(child, diagnostics);
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());
  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("an indexed root rollout marker tolerates the SQLite row appearing before the rollout file", async () => {
  const codexHome = join(home, "indexed-delayed-root-rollout-codex-home");
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-20-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  createIndexedRollout({ codexHome, threadId, rolloutPath });
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "cli" } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: root,
        workspace_roots: [root],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n";
  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { writeFileSync } from 'node:fs';",
      "await Bun.sleep(80);",
      "writeFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_ROLLOUT_BODY!);",
    ].join(" ")],
    env: { ...process.env, TEST_ROLLOUT_PATH: rolloutPath, TEST_ROLLOUT_BODY: rollout },
    stdout: "ignore",
    stderr: "pipe",
  });

  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const resolved = await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(request(marker), diagnostics);
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());

  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("an indexed child rollout marker tolerates the SQLite row appearing before the rollout file", async () => {
  const codexHome = join(home, "indexed-delayed-child-rollout-codex-home");
  const childThreadId = "01a06c66-2000-75c6-a0df-318f890ef6de";
  const childTurnId = "01a06c66-2001-75c6-a0df-318f890ef6de";
  const parentThreadId = "01a06c66-2002-75c6-a0df-318f890ef6de";
  const agentName = "/root/child";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-30-00-${childThreadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  createIndexedRollout({
    codexHome,
    threadId: childThreadId,
    rolloutPath,
    agentPath: agentName,
    parentThreadId,
  });
  const rollout = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: childThreadId,
        parent_thread_id: parentThreadId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: agentName } } },
        thread_source: "subagent",
        agent_path: agentName,
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: childTurnId,
        cwd: root,
        workspace_roots: [root],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n";
  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { writeFileSync } from 'node:fs';",
      "await Bun.sleep(80);",
      "writeFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_ROLLOUT_BODY!);",
    ].join(" ")],
    env: { ...process.env, TEST_ROLLOUT_PATH: rolloutPath, TEST_ROLLOUT_BODY: rollout },
    stdout: "ignore",
    stderr: "pipe",
  });
  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  const child = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: childThreadId,
      turn_id: childTurnId,
      parent_thread_id: parentThreadId,
      agent_name: agentName,
      subagent_kind: "thread_spawn",
      sandbox_mode: "danger-full-access",
      workspaces: { [root]: {} },
    }) },
    input: [
      { id: "msg_environment", text: marker, kind: "environments.environment_context" },
      { id: "msg_user", text: "private-user-prompt", kind: "user.text" },
    ].map(({ id, text, kind }) => ({
      type: "message",
      role: "user",
      id,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: childTurnId, content_item_kinds: [kind] },
    })),
  });

  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const resolved = await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(child, diagnostics);
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());

  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("an indexed root rollout marker tolerates the previous turn while the current turn_context is publishing", async () => {
  const codexHome = join(home, "indexed-stale-root-turn-codex-home");
  const previousTurnId = "01a06c66-3000-75c6-a0df-318f890ef6de";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-40-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  createIndexedRollout({ codexHome, threadId, rolloutPath });
  const turnContext = (currentTurnId: string) => JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: currentTurnId,
      cwd: root,
      workspace_roots: [root],
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      model: "chatgpt-web/pro",
      summary: "auto",
    },
  }) + "\n";
  writeFileSync(rolloutPath,
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "cli" } }) + "\n"
    + turnContext(previousTurnId));

  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request(marker)))
    .toThrow("Latest Codex rollout turn context does not belong to the requested turn");

  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { appendFileSync } from 'node:fs';",
      "await Bun.sleep(80);",
      "appendFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_TURN_CONTEXT!);",
    ].join(" ")],
    env: { ...process.env, TEST_ROLLOUT_PATH: rolloutPath, TEST_TURN_CONTEXT: turnContext(turnId) },
    stdout: "ignore",
    stderr: "pipe",
  });
  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const resolved = await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(request(marker), diagnostics);
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());

  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("an unindexed child rollout marker tolerates the previous turn while the current turn_context is publishing", async () => {
  const codexHome = join(home, "unindexed-stale-child-turn-codex-home");
  const childThreadId = "01a06c66-4000-75c6-a0df-318f890ef6de";
  const childTurnId = "01a06c66-4001-75c6-a0df-318f890ef6de";
  const previousChildTurnId = "01a06c66-4002-75c6-a0df-318f890ef6de";
  const parentThreadId = "01a06c66-4003-75c6-a0df-318f890ef6de";
  const agentName = "/root/child";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-50-00-${childThreadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    payload: {
      id: childThreadId,
      parent_thread_id: parentThreadId,
      source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: agentName } } },
      thread_source: "subagent",
      agent_path: agentName,
    },
  }) + "\n";
  const turnContext = (currentTurnId: string) => JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: currentTurnId,
      cwd: root,
      workspace_roots: [root],
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      model: "chatgpt-web/pro",
      summary: "auto",
    },
  }) + "\n";
  writeFileSync(rolloutPath, sessionMeta + turnContext(previousChildTurnId));

  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  const child = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: childThreadId,
      turn_id: childTurnId,
      parent_thread_id: parentThreadId,
      agent_name: agentName,
      subagent_kind: "thread_spawn",
      sandbox_mode: "danger-full-access",
      workspaces: { [root]: {} },
    }) },
    input: [
      { id: "msg_environment", text: marker, kind: "environments.environment_context" },
      { id: "msg_user", text: "private-user-prompt", kind: "user.text" },
    ].map(({ id, text, kind }) => ({
      type: "message",
      role: "user",
      id,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: childTurnId, content_item_kinds: [kind] },
    })),
  });
  const publisher = Bun.spawn({
    cmd: [process.execPath, "-e", [
      "import { appendFileSync } from 'node:fs';",
      "await Bun.sleep(80);",
      "appendFileSync(process.env.TEST_ROLLOUT_PATH!, process.env.TEST_TURN_CONTEXT!);",
    ].join(" ")],
    env: { ...process.env, TEST_ROLLOUT_PATH: rolloutPath, TEST_TURN_CONTEXT: turnContext(childTurnId) },
    stdout: "ignore",
    stderr: "pipe",
  });

  const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
  const resolved = await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(child, diagnostics);
  const exitCode = await publisher.exited;
  if (exitCode !== 0) throw new Error(await new Response(publisher.stderr).text());

  expect(resolved).toMatchObject({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(diagnostics).toEqual({
    recovery_stage: "rollout", rollout_lookup: "hit",
    thread_cache_lookup: "not_attempted", parent_cache_lookup: "not_attempted",
  });
});

test("rollout publication retry stops when the request is aborted", async () => {
  const codexHome = join(home, "aborted-rollout-marker-codex-home");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const marker = "<environment_context><current_date>2026-09-19</current_date><timezone>Asia/Shanghai</timezone></environment_context>";
  const controller = new AbortController();
  const resolving = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
    .resolveWithRolloutPublicationRetry(request(marker), {}, controller.signal);
  await Bun.sleep(10);
  controller.abort();
  await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
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
