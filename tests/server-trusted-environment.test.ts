import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { defaultConfig } from "../src/config";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

const home = mkdtempSync(join(tmpdir(), "trusted-environment-http-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const permissionProfile = `<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>`;
const malformedEnvironment = `<environment_context><cwd/><filesystem><workspace_roots><root>${home}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`;
const validEnvironment = `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`;

function request(stream: boolean, environmentXml = malformedEnvironment): Request {
  const turnId = "turn_missing_environment";
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_missing_environment", turn_id: turnId,
          request_kind: "turn", sandbox: "none", workspaces: { [home]: {} },
        }),
      },
      input: [
        { id: "msg_environment", text: environmentXml },
        { id: "msg_prompt", text: "Inspect the workspace." },
      ].map(({ id, text }) => ({
        type: "message", role: "user", id,
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      })),
    }),
  });
}

async function terminalEnvironmentConflict(
  stream: boolean,
  fail: () => void,
): Promise<{ response: Response; events: AdapterEvent[] }> {
  const events: AdapterEvent[] = [];
  const response = await responseRequest(request(stream, validEnvironment), defaultConfig("browser-only"), () => ({
    name: "trusted-environment-conflict-test",
    preflight() { fail(); },
    async runTurn() { throw new Error("trusted environment conflict must reject during preflight"); },
  }), { onAdapterEvent: event => events.push(event) });
  return { response, events };
}

function parentLineageConflict(
  name: string,
  sandboxMode: string,
  workspaceRoots: string[],
): () => void {
  const statePath = join(home, `parent-${name}.json`);
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    threads: {
      thread_parent: {
        cwd: home,
        roots: [home],
        writableRoots: [home],
        sandboxPolicy: { type: "dangerFullAccess" },
        updatedAt: Date.now(),
      },
    },
  })}\n`);
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: `thread_child_${name}`,
        turn_id: `turn_child_${name}`,
        parent_thread_id: "thread_parent",
        agent_name: "/root/child",
        subagent_kind: "thread_spawn",
        sandbox_mode: sandboxMode,
        workspaces: Object.fromEntries(workspaceRoots.map(root => [root, {}])),
      }),
    },
    input: [{
      type: "message",
      role: "user",
      id: `msg_child_${name}`,
      content: [{ type: "input_text", text: "Inspect the inherited repository." }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn_child_${name}` },
    }],
  });
  const store = new ChatGptThreadEnvironmentStore(statePath, Date.now, join(home, "no-codex-rollouts"));
  return () => { store.resolve(parsed); };
}

function compactionAuthorityConflict(): () => void {
  const codexHome = join(home, "compaction-codex-home");
  const workspace = join(home, "compaction-workspace");
  const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
  const turnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
  const sourceTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T12-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  const readOnlyEntries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
  ];
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "vscode" } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: workspace,
        workspace_roots: [workspace],
        approval_policy: "never",
        sandbox_policy: { type: "read-only", network_access: true },
        permission_profile: {
          type: "managed",
          file_system: { type: "restricted", entries: readOnlyEntries },
          network: "enabled",
        },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n");

  const currentEnvironment = `<environment_context><cwd>${workspace}</cwd><filesystem><workspace_roots><root>${workspace}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem></environment_context>`;
  const sourceContent = [{ type: "input_text", text: "Continue the earlier task." }];
  const summary = "Trusted compaction checkpoint";
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        agent_name: "/root",
        sandbox_mode: "read-only",
        workspaces: { [workspace]: {} },
      }),
    },
    input: [
      {
        type: "message",
        role: "user",
        id: "msg_current_environment",
        content: [{ type: "input_text", text: currentEnvironment }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        id: "msg_source_prompt",
        content: sourceContent,
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
      },
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
    ],
  });
  rememberCompactionContinuation(
    { ...parsed, _compactionRequest: true },
    extractChatGptTurnIdentity(parsed),
    [{ turnId: sourceTurnId, content: sourceContent }],
    summary,
  );
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  return () => { store.resolve(parsed); };
}

function invalidCompactionClaim(claimCount: 0 | 2): () => void {
  const workspace = join(home, `compaction-claim-${claimCount}`);
  const threadId = claimCount === 0
    ? "01a06c66-5232-7ae1-9108-69b5f70e0671"
    : "01a06c66-6232-7ae1-9108-69b5f70e0671";
  const turnId = claimCount === 0
    ? "01a06c66-5380-75c6-a0df-318f890ef6de"
    : "01a06c66-6380-75c6-a0df-318f890ef6de";
  const sourceTurnId = claimCount === 0
    ? "01a06c66-5000-75c6-a0df-318f890ef6de"
    : "01a06c66-6000-75c6-a0df-318f890ef6de";
  const environment = `<environment_context><cwd>${workspace}</cwd><filesystem><workspace_roots><root>${workspace}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`;
  const sourceContent = [{ type: "input_text", text: "Continue the earlier task." }];
  const summary = `Trusted compaction checkpoint ${claimCount}`;
  const currentEnvironment = {
    type: "message",
    role: "user",
    ...(claimCount === 0 ? {} : { id: "msg_current_environment" }),
    content: Array.from({ length: Math.max(1, claimCount) }, () => ({ type: "input_text", text: environment })),
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        agent_name: "/root",
        sandbox_mode: "danger-full-access",
        workspaces: { [workspace]: {} },
      }),
    },
    input: [
      currentEnvironment,
      {
        type: "message",
        role: "user",
        id: "msg_source_prompt",
        content: sourceContent,
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
      },
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
    ],
  });
  rememberCompactionContinuation(
    { ...parsed, _compactionRequest: true },
    extractChatGptTurnIdentity(parsed),
    [{ turnId: sourceTurnId, content: sourceContent }],
    summary,
  );
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, join(home, "no-claim-rollouts"));
  return () => { store.resolve(parsed); };
}

function rolloutMetadataConflict(
  name: string,
  sandboxMode: string,
  workspaceRoots: string[],
): () => void {
  const codexHome = join(home, `rollout-metadata-${name}`);
  const workspace = join(home, "rollout-metadata-workspace");
  const threadId = "01a06c66-7232-7ae1-9108-69b5f70e0671";
  const turnId = "01a06c66-7380-75c6-a0df-318f890ef6de";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T13-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "vscode" } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: workspace,
        workspace_roots: [workspace],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n");
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        agent_name: "/root",
        sandbox_mode: sandboxMode,
        workspaces: Object.fromEntries(workspaceRoots.map(root => [root, {}])),
      }),
    },
    input: [{
      type: "message",
      role: "user",
      id: `msg_rollout_metadata_${name}`,
      content: [{ type: "input_text", text: "Inspect the workspace." }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  });
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  return () => { store.resolve(parsed); };
}

function invalidNativeIdentifierHttpFixture(stream: boolean): { request: Request; codexHome: string } {
  const codexHome = join(home, "invalid-native-codex-home");
  const body = {
    model: "chatgpt-web/high",
    stream,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: "01a06c66-8232-7ae1-9108-69b5f70e0671",
        turn_id: "turn-not-native",
        agent_name: "/root",
        sandbox_mode: "danger-full-access",
        workspaces: { [home]: {} },
      }),
    },
    input: [{
      type: "message",
      role: "user",
      id: "msg_invalid_native_identifier",
      content: [{ type: "input_text", text: "Inspect the workspace." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-not-native" },
    }],
  };
  return {
    codexHome,
    request: new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

function historicalEnvironmentHttpFixture(
  kind: "mismatch" | "unrecorded",
  stream: boolean,
): { request: Request; codexHome: string } {
  const codexHome = join(home, `historical-${kind}-codex-home`);
  const workspace = join(home, `historical-${kind}-workspace`);
  const historicalWorkspace = join(home, `historical-${kind}-previous-workspace`);
  const threadId = kind === "mismatch"
    ? "01a06c66-9232-7ae1-9108-69b5f70e0671"
    : "01a06c66-a232-7ae1-9108-69b5f70e0671";
  const parentThreadId = kind === "mismatch"
    ? "01a06c66-9032-7ae1-9108-69b5f70e0671"
    : "01a06c66-a032-7ae1-9108-69b5f70e0671";
  const agentName = `/root/historical_${kind}`;
  const turnId = kind === "mismatch"
    ? "01a06c66-9380-75c6-a0df-318f890ef6de"
    : "01a06c66-a380-75c6-a0df-318f890ef6de";
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "19",
    `rollout-2026-09-19T14-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  const historicalEnvironment = `<environment_context><cwd>${historicalWorkspace}</cwd><filesystem><workspace_roots><root>${historicalWorkspace}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`;
  const nativeHistorical = {
    type: "message",
    role: "user",
    id: "msg_historical_environment",
    content: [{ type: "input_text", text: historicalEnvironment }],
  };
  writeFileSync(rolloutPath, [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: threadId,
        parent_thread_id: parentThreadId,
        cwd: workspace,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: agentName,
            },
          },
        },
        thread_source: "subagent",
        agent_path: agentName,
      },
    }),
    JSON.stringify({ type: "response_item", payload: nativeHistorical }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: workspace,
        workspace_roots: [workspace],
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "chatgpt-web/pro",
        summary: "auto",
      },
    }),
  ].join("\n") + "\n");

  const requestedHistorical = structuredClone(nativeHistorical);
  if (kind === "mismatch") {
    requestedHistorical.content = [{
      type: "input_text",
      text: historicalEnvironment.replace("</environment_context>", "<current_date>2026-09-19</current_date></environment_context>"),
    }];
  } else {
    requestedHistorical.id = "msg_unrecorded_environment";
  }
  const body = {
    model: "chatgpt-web/high",
    stream,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        parent_thread_id: parentThreadId,
        agent_name: agentName,
        subagent_kind: "thread_spawn",
        sandbox_mode: "danger-full-access",
        workspaces: { [workspace]: {} },
      }),
    },
    input: [
      requestedHistorical,
      {
        type: "message",
        role: "user",
        id: "msg_historical_prompt",
        content: [{ type: "input_text", text: "Earlier instruction." }],
      },
      {
        type: "message",
        role: "user",
        id: "msg_current_prompt",
        content: [{ type: "input_text", text: "Inspect the workspace." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  return {
    codexHome,
    request: new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

const invalidEnvironmentCases = [
  {
    name: "relative cwd",
    message: "ChatGPT web cwd must contain absolute paths",
    xml: `<environment_context><cwd>relative/workspace</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`,
  },
  {
    name: "relative workspace roots",
    message: "ChatGPT web workspace_roots must contain absolute paths",
    xml: `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>relative/workspace</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`,
  },
  {
    name: "conflicting cwd",
    message: "ChatGPT web turn has conflicting trusted Codex cwd values",
    xml: `<environment_context><cwd>${home}</cwd><cwd>${join(home, "other")}</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`,
  },
  {
    name: "cwd outside roots",
    message: "ChatGPT web cwd is outside the trusted Codex workspace roots",
    xml: `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>${join(home, "other")}</root></workspace_roots>${permissionProfile}</filesystem></environment_context>`,
  },
  {
    name: "missing sandbox mode",
    message: "ChatGPT web turn requires one explicit trusted Codex sandbox mode",
    xml: `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots></filesystem></environment_context>`,
  },
] as const;

for (const stream of [true, false]) {
  test(`missing trusted cwd is HTTP 400 before any heartbeat (stream=${stream})`, async () => {
    const events: AdapterEvent[] = [];
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await responseRequest(request(stream), defaultConfig("full"), provider => (
        createChatGptWebAdapter({
          ...provider,
          chatgptWeb: {
            ...provider.chatgptWeb,
            threadEnvironmentStatePath: join(home, "environments.json"),
          },
        })
      ), { onAdapterEvent: event => events.push(event) });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: {
        message: "ChatGPT web turn is missing cwd in trusted Codex environment context",
        type: "invalid_request_error",
        code: "missing_trusted_codex_environment",
      } });
      expect(events).toEqual([expect.objectContaining({
        type: "error", status: 400, errorType: "invalid_request_error",
        code: "missing_trusted_codex_environment", retryable: false,
      })]);
      expect(warnings).toHaveBeenCalledTimes(1);
      const warning = JSON.stringify(warnings.mock.calls);
      expect(warning).not.toContain(home);
      expect(warning).toContain("recovery_stage=current_update_rejected");
      expect(warning).toContain("cwd_count=1, cwd_value_count=0");
      expect(warning).toMatch(/request_fingerprint=[a-f0-9]{12}/);
    } finally {
      warnings.mockRestore();
    }
  });

  for (const invalid of invalidEnvironmentCases) {
    test(`${invalid.name} is terminal HTTP 400 (stream=${stream})`, async () => {
      const events: AdapterEvent[] = [];
      const warnings = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await responseRequest(request(stream, invalid.xml), defaultConfig("full"), provider => (
          createChatGptWebAdapter({
            ...provider,
            chatgptWeb: {
              ...provider.chatgptWeb,
              threadEnvironmentStatePath: join(home, "environments.json"),
            },
          })
        ), { onAdapterEvent: event => events.push(event) });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: {
          message: invalid.message,
          type: "invalid_request_error",
          code: "invalid_trusted_codex_environment",
        } });
        expect(events).toEqual([expect.objectContaining({
          type: "error", status: 400, errorType: "invalid_request_error",
          code: "invalid_trusted_codex_environment", retryable: false,
        })]);
      } finally {
        warnings.mockRestore();
      }
    });
  }
}

const trustedConflictCases = [
  {
    name: "compaction continuation with no current native claim",
    message: "Compaction continuation requires one current native environment claim",
    failure: () => invalidCompactionClaim(0),
  },
  {
    name: "compaction continuation with multiple current native claims",
    message: "Compaction continuation requires one current native environment claim",
    failure: () => invalidCompactionClaim(2),
  },
  {
    name: "compaction rollout authority conflict",
    message: "Compaction continuation environment conflicts with its current Codex rollout",
    failure: compactionAuthorityConflict,
  },
  {
    name: "rollout sandbox metadata conflict",
    message: "ChatGPT Web thread sandbox metadata conflicts with its Codex rollout",
    failure: () => rolloutMetadataConflict("sandbox", "read-only", [join(home, "rollout-metadata-workspace")]),
  },
  {
    name: "rollout workspace cwd metadata conflict",
    message: "ChatGPT Web thread workspace metadata does not contain its Codex rollout cwd",
    failure: () => rolloutMetadataConflict(
      "cwd",
      "danger-full-access",
      [join(home, "rollout-metadata-outside")],
    ),
  },
  {
    name: "rollout workspace roots metadata conflict",
    message: "ChatGPT Web thread workspace metadata conflicts with its Codex rollout roots",
    failure: () => rolloutMetadataConflict(
      "roots",
      "danger-full-access",
      [join(home, "rollout-metadata-workspace"), join(home, "rollout-metadata-outside")],
    ),
  },
  {
    name: "parent sandbox conflict",
    message: "ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread",
    failure: () => parentLineageConflict("sandbox", "read-only", [home]),
  },
  {
    name: "parent cwd conflict",
    message: "ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd",
    failure: () => parentLineageConflict("cwd", "danger-full-access", [join(home, "child-only")]),
  },
  {
    name: "parent roots conflict",
    message: "ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots",
    failure: () => parentLineageConflict(
      "roots",
      "danger-full-access",
      [home, join(home, "..", "outside-parent-roots")],
    ),
  },
] as const;

for (const stream of [true, false]) for (const conflict of trustedConflictCases) {
  test(`${conflict.name} is terminal HTTP 400 (stream=${stream})`, async () => {
    const { response, events } = await terminalEnvironmentConflict(stream, conflict.failure());
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: {
      message: conflict.message,
      type: "invalid_request_error",
      code: "invalid_trusted_codex_environment",
    } });
    expect(events).toEqual([expect.objectContaining({
      type: "error",
      status: 400,
      errorType: "invalid_request_error",
      code: "invalid_trusted_codex_environment",
      retryable: false,
    })]);
  });
}

const realAdapterConflictCases = [
  {
    name: "invalid native turn identifier",
    message: "Codex thread metadata contains an invalid native identifier",
    reason: "invalid_native_identifier",
    fixture: invalidNativeIdentifierHttpFixture,
  },
  {
    name: "historical environment content mismatch",
    message: "Historical environment message differs from its native Codex record",
    reason: "historical_environment_content_mismatch",
    fixture: (stream: boolean) => historicalEnvironmentHttpFixture("mismatch", stream),
  },
  {
    name: "unrecorded historical environment message",
    message: "Codex rollout does not authenticate the historical environment messages",
    reason: "historical_environment_unrecorded",
    fixture: (stream: boolean) => historicalEnvironmentHttpFixture("unrecorded", stream),
  },
] as const;

for (const stream of [true, false]) for (const conflict of realAdapterConflictCases) {
  test(`${conflict.name} is rejected by the real adapter with HTTP 400 (stream=${stream})`, async () => {
    const fixture = conflict.fixture(stream);
    const events: AdapterEvent[] = [];
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await responseRequest(fixture.request, defaultConfig("full"), provider => (
        createChatGptWebAdapter({
          ...provider,
          chatgptWeb: {
            ...provider.chatgptWeb,
            threadEnvironmentStatePath: join(fixture.codexHome, "thread-environments.json"),
          },
        }, { codexHome: fixture.codexHome })
      ), { onAdapterEvent: event => events.push(event) });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: {
        message: conflict.message,
        type: "invalid_request_error",
        code: "invalid_trusted_codex_environment",
      } });
      expect(events).toEqual([expect.objectContaining({
        type: "error",
        status: 400,
        errorType: "invalid_request_error",
        code: "invalid_trusted_codex_environment",
        retryable: false,
      })]);
      expect(JSON.stringify(warnings.mock.calls)).toContain(`reason=${conflict.reason}`);
    } finally {
      warnings.mockRestore();
    }
  });
}

test("invalid strict schema does not persist trusted environment or seed later cache authority", async () => {
  const codexHome = join(home, "invalid-schema-codex-home");
  const statePath = join(home, "invalid-schema-thread-environments.json");
  const existingStatePath = join(home, "invalid-schema-existing-thread-environments.json");
  const existingState = `${JSON.stringify({ version: 1, threads: {} }, null, 2)}\n`;
  const threadId = "01a06c66-7232-7ae1-9108-69b5f70e0671";
  const turnId = "01a06c66-7380-75c6-a0df-318f890ef6de";
  const nextTurnId = "01a06c66-7480-75c6-a0df-318f890ef6de";
  const buildRequest = (currentTurnId: string, includeEnvironment: boolean, invalidSchema: boolean) => new Request(
    "http://127.0.0.1/v1/responses",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: false,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "turn", thread_id: threadId, turn_id: currentTurnId,
            sandbox: "none", workspaces: { [home]: {} },
          }),
        },
        ...(invalidSchema ? {
          text: {
            format: {
              type: "json_schema", name: "invalid", strict: true,
              schema: { type: "not-a-json-schema-type" },
            },
          },
        } : {}),
        input: [
          ...(includeEnvironment ? [{ id: "msg_environment", text: validEnvironment }] : []),
          { id: "msg_prompt", text: "Inspect the workspace." },
        ].map(({ id, text }) => ({
          type: "message", role: "user", id,
          content: [{ type: "input_text", text }],
          internal_chat_message_metadata_passthrough: { turn_id: currentTurnId },
        })),
      }),
    },
  );
  const adapterFactory = (threadEnvironmentStatePath: string) => (
    provider: Parameters<typeof createChatGptWebAdapter>[0],
  ) => createChatGptWebAdapter({
    ...provider,
    chatgptWeb: { ...provider.chatgptWeb, threadEnvironmentStatePath },
  }, { codexHome });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = await responseRequest(
      buildRequest(turnId, true, true),
      defaultConfig("full"),
      adapterFactory(statePath),
    );
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ error: { code: "invalid_output_schema" } });
    expect(existsSync(statePath)).toBe(false);

    writeFileSync(existingStatePath, existingState);
    const update = await responseRequest(
      buildRequest(turnId, true, true),
      defaultConfig("full"),
      adapterFactory(existingStatePath),
    );
    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject({ error: { code: "invalid_output_schema" } });
    expect(readFileSync(existingStatePath, "utf8")).toBe(existingState);

    const followUp = await responseRequest(
      buildRequest(nextTurnId, false, false),
      defaultConfig("full"),
      adapterFactory(statePath),
    );
    expect(followUp.status).toBe(400);
    expect(await followUp.json()).toMatchObject({ error: { code: "missing_trusted_codex_environment" } });
    expect(existsSync(statePath)).toBe(false);
  } finally {
    warnings.mockRestore();
  }
});

test("stream preflight preserves the first output event and normal completion", async () => {
  const response = await responseRequest(request(true), defaultConfig("browser-only"), () => ({
    name: "first-event-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "First output" });
      emit({ type: "done", stopReason: "stop" });
    },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain('"delta":"First output"');
  expect(text).toContain("event: response.completed");
});

test("stream response does not wait for the first adapter event", async () => {
  let release!: () => void;
  const adapterReady = new Promise<void>(resolve => { release = resolve; });
  const responsePromise = responseRequest(request(true), defaultConfig("browser-only"), () => ({
    name: "delayed-first-event-test",
    async runTurn(_parsed, _incoming, emit) {
      await adapterReady;
      emit({ type: "done", stopReason: "stop" });
    },
  }));

  const result = await Promise.race([
    responsePromise.then(() => "response" as const),
    Bun.sleep(50).then(() => "blocked" as const),
  ]);
  release();
  expect(result).toBe("response");
  expect((await responsePromise).headers.get("content-type")).toContain("text/event-stream");
});

test("an unrelated adapter failure is not converted to a missing-environment HTTP 400", async () => {
  const response = await responseRequest(request(true), defaultConfig("browser-only"), () => ({
    name: "unrelated-error-test",
    async runTurn() { throw new Error("Upstream connection failed"); },
  }));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("event: response.failed");
  expect(text).toContain('"code":"upstream_server_error"');
});
