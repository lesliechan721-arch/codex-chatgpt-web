import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, networkInterfaces, platform, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const ATTESTATION_SCHEMA = "codex-chatgpt-web/delegated-server-attestation/v1";
const API_KEY_ENV = "CODEX_WEB_REMOTE_ACCEPTANCE_KEY";

interface ServerAttestation {
  schema: typeof ATTESTATION_SCHEMA;
  challenge: string;
  createdAt: string;
  serverHostId: string;
  containerId: string;
  authorityMode: "delegated";
  codexCliPresent: false;
  clientCodexStatePresent: false;
  unexpectedMounts: string[];
  mountDestinations: string[];
}

interface RolloutRecord {
  type?: string;
  payload?: Record<string, unknown>;
}

interface SessionEvidence {
  path: string;
  entries: RolloutRecord[];
  meta?: RolloutRecord;
  context?: RolloutRecord;
  completion?: RolloutRecord;
  depth: number;
}

interface CapturedRequest {
  body: Record<string, unknown>;
  responseText?: Promise<string>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compact(value: string): string {
  return value.length <= 8_000 ? value : value.slice(-8_000);
}

function hostId(): string {
  let identity = "";
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    if (!existsSync(path)) continue;
    identity = readFileSync(path, "utf8").trim();
    if (identity) break;
  }
  if (!identity) {
    const macs = Object.values(networkInterfaces())
      .flatMap(entries => entries ?? [])
      .filter(entry => !entry.internal && entry.mac && entry.mac !== "00:00:00:00:00:00")
      .map(entry => entry.mac)
      .sort();
    identity = [platform(), hostname(), ...macs].join("|");
  }
  return createHash("sha256").update(`delegated-acceptance:${identity}`).digest("hex");
}

function runChecked(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${compact(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout;
}

function serverAttestation(): void {
  const challenge = requiredEnv("CODEX_WEB_REMOTE_ACCEPTANCE_CHALLENGE");
  const composeFile = resolve(process.env.CODEX_SERVER_COMPOSE_FILE ?? "deploy/server/compose.yaml");
  const envFile = process.env.CODEX_SERVER_ENV_FILE
    ? resolve(process.env.CODEX_SERVER_ENV_FILE)
    : resolve("deploy/server/.env");
  const composeArgs = ["compose"];
  if (existsSync(envFile)) composeArgs.push("--env-file", envFile);
  composeArgs.push("-f", composeFile);

  const ids = runChecked("docker", [...composeArgs, "ps", "-q", "desktop"])
    .split("\n")
    .map(value => value.trim())
    .filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected one running desktop container, found ${ids.length}`);
  const containerId = ids[0]!;
  const inspected = JSON.parse(runChecked("docker", ["inspect", containerId])) as Array<Record<string, unknown>>;
  const container = inspected[0];
  if (!container) throw new Error("docker inspect returned no container");
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const mountDestinations = mounts
    .flatMap(mount => typeof object(mount)?.Destination === "string" ? [object(mount)!.Destination as string] : [])
    .sort();
  const allowedMounts = new Set([
    "/home/codex",
    "/run/secrets/keyring_password",
    "/run/secrets/vnc_password",
  ]);
  const unexpectedMounts = mountDestinations.filter(destination => !allowedMounts.has(destination));
  if (unexpectedMounts.length > 0) {
    throw new Error(`Server container has unexpected mounts: ${unexpectedMounts.join(", ")}`);
  }

  runChecked("docker", [
    "exec",
    containerId,
    "sh",
    "-lc",
    [
      "set -eu",
      'test "${CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE:-}" = delegated',
      "! command -v codex >/dev/null 2>&1",
      "test ! -d /home/codex/.codex/sessions",
      "test ! -e /home/codex/.codex/state_5.sqlite",
    ].join("; "),
  ]);

  const attestation: ServerAttestation = {
    schema: ATTESTATION_SCHEMA,
    challenge,
    createdAt: new Date().toISOString(),
    serverHostId: hostId(),
    containerId: containerId.slice(0, 12),
    authorityMode: "delegated",
    codexCliPresent: false,
    clientCodexStatePresent: false,
    unexpectedMounts,
    mountDestinations,
  };
  process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
}

function rolloutFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...rolloutFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}

function records(path: string): RolloutRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as RolloutRecord);
}

function subagentDepth(meta: RolloutRecord | undefined): number {
  const source = object(meta?.payload?.source);
  const subagent = object(source?.subagent);
  const spawn = object(subagent?.thread_spawn);
  return typeof spawn?.depth === "number" ? spawn.depth : 0;
}

function sessionEvidence(path: string): SessionEvidence {
  const entries = records(path);
  const meta = entries.find(entry => entry.type === "session_meta");
  const context = entries.find(entry => entry.type === "turn_context");
  const completion = entries.find(entry => entry.type === "event_msg"
    && object(entry.payload)?.type === "task_complete");
  return { path, entries, meta, context, completion, depth: subagentDepth(meta) };
}

function lastTaskCompletion(session: SessionEvidence): Record<string, unknown> | undefined {
  const entry = session.entries.findLast(record => record.type === "event_msg"
    && object(record.payload)?.type === "task_complete");
  return object(entry?.payload);
}

function sessionId(session: SessionEvidence): string {
  const id = session.meta?.payload?.id;
  if (typeof id !== "string" || !id) throw new Error(`Rollout has no native thread id: ${session.path}`);
  return id;
}

function responseItems(session: SessionEvidence): Record<string, unknown>[] {
  return session.entries
    .filter(entry => entry.type === "response_item")
    .flatMap(entry => object(entry.payload) ? [entry.payload!] : []);
}

function execEvidence(session: SessionEvidence, needle: string): { call: Record<string, unknown>; output: Record<string, unknown> } {
  const items = responseItems(session);
  const call = items.find(item => item.type === "function_call"
    && item.name === "exec_command"
    && JSON.stringify(item.arguments).includes(needle));
  if (!call) throw new Error(`No exec_command attempted ${needle} in ${session.path}`);
  const callId = call.call_id;
  const output = items.find(item => item.type === "function_call_output" && item.call_id === callId);
  if (!output) throw new Error(`exec_command ${needle} has no native tool result`);
  return { call, output };
}

function assertDenied(output: Record<string, unknown>, label: string): void {
  const wire = JSON.stringify(output);
  if (!/(Process exited with code [1-9]|exit[_ ]code[^0-9]*[1-9]|Permission denied|Operation not permitted|sandbox)/i.test(wire)) {
    throw new Error(`${label} did not contain a native sandbox rejection: ${compact(wire)}`);
  }
}

function metadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const clientMetadata = object(body.client_metadata);
  const raw = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof raw !== "string") return undefined;
  try {
    return object(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function containsPath(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function assertNotWritableByProfile(session: SessionEvidence, target: string, label: string): void {
  const payload = object(session.context?.payload);
  const sandbox = object(payload?.sandbox_policy);
  const profile = object(payload?.permission_profile);
  const fileSystem = object(profile?.file_system);
  if (sandbox?.type !== "workspace-write"
    || profile?.type !== "managed"
    || fileSystem?.type !== "restricted"
    || !Array.isArray(fileSystem.entries)) {
    throw new Error(`${label} does not expose a managed workspace-write permission profile`);
  }
  const roots = Array.isArray(payload?.workspace_roots)
    ? payload!.workspace_roots.filter((value): value is string => typeof value === "string")
    : typeof payload?.cwd === "string" ? [payload.cwd] : [];
  for (const value of fileSystem.entries) {
    const entry = object(value);
    const path = object(entry?.path);
    if (entry?.access !== "write" || !path) continue;
    if (path.type === "path") {
      if (typeof path.path !== "string" || !isAbsolute(path.path)) {
        throw new Error(`${label} contains an unprovable writable path entry`);
      }
      if (containsPath(path.path, target)) {
        throw new Error(`${label} target is inside native writable root ${path.path}`);
      }
      continue;
    }
    if (path.type === "special") {
      const kind = object(path.value)?.kind;
      if (kind === "tmpdir") {
        if (containsPath(tmpdir(), target)) throw new Error(`${label} target is writable through tmpdir`);
        continue;
      }
      if (kind === "slash_tmp") {
        if (containsPath("/tmp", target) || containsPath("/private/tmp", target)) {
          throw new Error(`${label} target is writable through slash_tmp`);
        }
        continue;
      }
      if (kind === "project_roots") {
        if (roots.some(root => containsPath(root, target))) {
          throw new Error(`${label} target is writable through project_roots`);
        }
        continue;
      }
      throw new Error(`${label} contains an unrecognized writable special path: ${String(kind)}`);
    }
    throw new Error(`${label} contains an unprovable writable profile entry`);
  }
}

function callId(entry: { call: Record<string, unknown> }): string {
  const value = entry.call.call_id;
  if (typeof value !== "string" || !value) throw new Error("Native tool call has no call_id");
  return value;
}

function capturedHasCallId(entry: CapturedRequest, id: string): boolean {
  return JSON.stringify(entry.body.input ?? []).includes(id);
}

async function capturedCompletedMetadata(entry: CapturedRequest): Promise<Record<string, unknown> | undefined> {
  if (!entry.responseText) return undefined;
  const wire = await entry.responseText;
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    const event = object(JSON.parse(payload));
    if (event?.type !== "response.completed") continue;
    return object(object(event.response)?.metadata);
  }
  try {
    return object(object(JSON.parse(wire))?.metadata);
  } catch {
    return undefined;
  }
}

function assertApprovalDenied(output: Record<string, unknown>, label: string): void {
  const wire = JSON.stringify(output);
  if (!/(approval|approve|denied|declined|rejected|not permitted|not allowed)/i.test(wire)) {
    throw new Error(`${label} did not contain a native approval rejection: ${compact(wire)}`);
  }
}

async function runClientAcceptance(): Promise<void> {
  const challenge = requiredEnv("CODEX_WEB_REMOTE_ACCEPTANCE_CHALLENGE");
  const remoteBaseUrl = new URL(requiredEnv("CODEX_WEB_REMOTE_BASE_URL"));
  if (remoteBaseUrl.protocol !== "https:") throw new Error("CODEX_WEB_REMOTE_BASE_URL must use HTTPS");
  if (["localhost", "127.0.0.1", "::1"].includes(remoteBaseUrl.hostname)) {
    throw new Error("Remote delegated acceptance must not target a loopback server");
  }
  const apiKey = requiredEnv("CODEX_WEB_REMOTE_API_KEY");
  const attestationPath = resolve(requiredEnv("CODEX_WEB_REMOTE_SERVER_ATTESTATION"));
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as ServerAttestation;
  assert.equal(attestation.schema, ATTESTATION_SCHEMA, "server attestation schema");
  assert.equal(attestation.challenge, challenge, "server attestation challenge");
  assert.equal(attestation.authorityMode, "delegated", "server delegated authority");
  assert.equal(attestation.codexCliPresent, false, "server must not contain Codex CLI");
  assert.equal(attestation.clientCodexStatePresent, false, "server must not contain client Codex state");
  assert.deepEqual(attestation.unexpectedMounts, [], "server must not mount client workspace or Codex state");
  assert.notEqual(attestation.serverHostId, hostId(), "Codex client and Server must be different hosts");

  const codexArg = process.argv[3];
  const codex = resolve(codexArg ?? Bun.which("codex") ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
  if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);
  const catalogSource = expandHome(
    process.env.CODEX_WEB_REMOTE_MODEL_CATALOG ?? join(homedir(), ".codex", "api-key-models.json"),
  );
  if (!existsSync(catalogSource)) throw new Error(`Remote model catalog is missing: ${catalogSource}`);
  JSON.parse(readFileSync(catalogSource, "utf8"));
  const rootModel = process.env.CODEX_WEB_REMOTE_ROOT_MODEL?.trim() || "chatgpt-web/medium";
  const childModel = process.env.CODEX_WEB_REMOTE_CHILD_MODEL?.trim() || "chatgpt-web/high";

  const root = mkdtempSync(join(tmpdir(), "cgw-remote-delegated-"));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  mkdirSync(workspace);
  mkdirSync(codexHome);
  const proofSuffix = createHash("sha256").update(`${challenge}:${process.pid}`).digest("hex").slice(0, 16);
  const outsideTarget = join(homedir(), `.cgw-remote-delegated-denied-${proofSuffix}.txt`);
  const approvalTarget = join(homedir(), `.cgw-remote-delegated-approval-${proofSuffix}.txt`);
  if (existsSync(outsideTarget) || existsSync(approvalTarget)) {
    throw new Error("Remote delegated acceptance proof target already exists");
  }
  const childValue = `CLIENT_CHILD_${createHash("sha256").update(challenge).digest("hex").slice(0, 16)}`;
  const parentValue = `CLIENT_PARENT_${createHash("sha256").update(`${challenge}:parent`).digest("hex").slice(0, 16)}`;
  writeFileSync(join(workspace, "child-proof.txt"), `${childValue}\n`);
  writeFileSync(join(workspace, "parent-proof.txt"), `${parentValue}\n`);
  const catalogPath = join(root, "models.json");
  writeFileSync(catalogPath, readFileSync(catalogSource));

  const captured: CapturedRequest[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const target = new URL(remoteBaseUrl);
      const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, "");
      target.pathname = `${remoteBaseUrl.pathname.replace(/\/$/, "")}${suffix}`;
      target.search = incoming.search;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
      if (incoming.pathname.endsWith("/responses") && bytes) {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (object(parsed)) captured.push({ body: parsed });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(target, {
        method: request.method,
        headers,
        ...(bytes ? { body: bytes } : {}),
        redirect: "manual",
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });

  writeFileSync(join(codexHome, "config.toml"), [
    `model = ${JSON.stringify(rootModel)}`,
    'model_provider = "delegated_remote_acceptance"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'approval_policy = "never"',
    "",
    "[model_providers.delegated_remote_acceptance]",
    'name = "Delegated remote acceptance"',
    `base_url = ${JSON.stringify(`http://127.0.0.1:${proxy.port}/v1`)}`,
    `env_key = ${JSON.stringify(API_KEY_ENV)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
    "[agents]",
    "max_depth = 2",
    "",
    "[features]",
    "multi_agent = true",
    "multi_agent_v2 = false",
    "",
  ].join("\n"));

  async function runCodex(
    label: string,
    sandbox: "read-only" | "workspace-write",
    prompt: string,
    approvalPolicy: "never" | "on-request" = "never",
  ): Promise<SessionEvidence[]> {
    const before = new Set(rolloutFiles(join(codexHome, "sessions")));
    const child = Bun.spawn([
      codex,
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--config",
      `approval_policy=${JSON.stringify(approvalPolicy)}`,
      "--sandbox",
      sandbox,
      "--model",
      rootModel,
      "--cd",
      workspace,
      prompt,
    ], {
      cwd: workspace,
      env: { ...process.env, CODEX_HOME: codexHome, [API_KEY_ENV]: apiKey },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 8 * 60_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    if (timedOut) throw new Error(`${label} timed out after 8 minutes`);
    if (exitCode !== 0) {
      throw new Error(`${label} failed (${exitCode})\nstdout:\n${compact(stdout)}\nstderr:\n${compact(stderr)}`);
    }
    const added = rolloutFiles(join(codexHome, "sessions")).filter(path => !before.has(path));
    if (added.length === 0) throw new Error(`${label} produced no native Codex rollout`);
    return added.map(sessionEvidence);
  }

  try {
    const captureStart = captured.length;
    const subagentSessions = await runCodex("remote delegated child", "workspace-write", [
      "This is a delegated-authority acceptance test. Use the native agent tools.",
      "Do not run pwd or read child-proof.txt in the parent.",
      `Spawn exactly one child with model ${childModel}, reasoning_effort high, and no forked history.`,
      "Tell the child to use exec_command with cmd exactly `pwd && cat child-proof.txt`, then return the cwd and file value.",
      "Wait for that exact child. After it finishes, the parent must use exec_command with cmd exactly `cat parent-proof.txt`.",
      "Return REMOTE_DELEGATED_CHILD_OK only after both native tool results are available.",
    ].join(" "));
    const rootSession = subagentSessions.find(session => session.depth === 0);
    const childSession = subagentSessions.find(session => session.depth === 1);
    if (!rootSession || !childSession) throw new Error("Remote delegated run did not produce root and depth-1 child rollouts");
    const rootId = sessionId(rootSession);
    const childId = sessionId(childSession);
    assert.notEqual(rootId, childId, "parent and child native thread ids");
    assert.equal(object(rootSession.context?.payload)?.cwd, workspace, "parent native cwd");
    assert.equal(object(childSession.context?.payload)?.cwd, workspace, "child native cwd");
    assert.equal(object(childSession.context?.payload)?.model, childModel, "child model");

    const childExec = execEvidence(childSession, "pwd && cat child-proof.txt");
    const childOutput = JSON.stringify(childExec.output);
    assert.ok(childOutput.includes(workspace), "child pwd must be the client workspace");
    assert.ok(childOutput.includes(childValue), "child read must come from the client workspace");
    const parentExec = execEvidence(rootSession, "cat parent-proof.txt");
    assert.ok(JSON.stringify(parentExec.output).includes(parentValue), "parent native tool result");

    const rootRequests = captured.slice(captureStart).filter(entry => metadata(entry.body)?.thread_id === rootId);
    const childRequests = captured.slice(captureStart).filter(entry => metadata(entry.body)?.thread_id === childId);
    if (rootRequests.length === 0) throw new Error("No captured Responses request matched the native parent thread");
    if (childRequests.length === 0) throw new Error("No captured Responses request matched the native child thread");
    const firstChild = childRequests[0]!.body;
    assert.equal(metadata(firstChild)?.parent_thread_id, rootId, "native child parent thread id");
    assert.ok(!JSON.stringify(firstChild.input ?? []).includes("<environment_context>"),
      "child first Responses request must be environment-less");
    const parentCallId = callId(parentExec);
    const childCallId = callId(childExec);
    // The bearer token is intentionally not exposed to Codex or this client-side harness. Prove
    // the real integration boundary by showing each native tool result returns only on the native
    // thread that originated its browser-side delegated call. The broker lifecycle regression
    // separately proves an issued token cannot update its bound thread/turn identity.
    assert.ok(rootRequests.some(entry => capturedHasCallId(entry, parentCallId)),
      "parent tool result must continue only on the parent origin thread");
    assert.ok(childRequests.some(entry => capturedHasCallId(entry, childCallId)),
      "child tool result must continue only on the child origin thread");
    assert.ok(!rootRequests.some(entry => capturedHasCallId(entry, childCallId)),
      "child native call_id must not be rebound to the parent thread");
    assert.ok(!childRequests.some(entry => capturedHasCallId(entry, parentCallId)),
      "parent native call_id must not be rebound to the child thread");

    const readOnlyTarget = join(workspace, "read-only-denied.txt");
    const readOnlySessions = await runCodex("read-only sandbox", "read-only", [
      "This is a sandbox acceptance test. You must attempt the command even if it will fail.",
      "Use exec_command exactly once with cmd `printf READ_ONLY_ESCAPE > read-only-denied.txt`.",
      "Do not use any other filesystem-writing tool. Report the native result.",
    ].join(" "));
    const readOnlyRoot = readOnlySessions.find(session => session.depth === 0);
    if (!readOnlyRoot) throw new Error("Read-only run produced no root rollout");
    assertDenied(execEvidence(readOnlyRoot, "read-only-denied.txt").output, "read-only write");
    assert.equal(existsSync(readOnlyTarget), false, "read-only sandbox must reject workspace writes");

    const insideTarget = join(workspace, "workspace-write-ok.txt");
    assertNotWritableByProfile(rootSession, outsideTarget, "workspace-write preflight");
    const workspaceSessions = await runCodex("workspace-write sandbox", "workspace-write", [
      "This is a sandbox acceptance test. Attempt both commands with exec_command, in this order.",
      "First use cmd exactly `printf WORKSPACE_WRITE_OK > workspace-write-ok.txt`.",
      `Then use cmd exactly \`printf WORKSPACE_ESCAPE > ${shellQuote(outsideTarget)}\`; attempt it even if it will fail.`,
      "Do not use another filesystem-writing tool. Report both native results.",
    ].join(" "));
    const workspaceRoot = workspaceSessions.find(session => session.depth === 0);
    if (!workspaceRoot) throw new Error("Workspace-write run produced no root rollout");
    assertNotWritableByProfile(workspaceRoot, outsideTarget, "workspace-write execution");
    execEvidence(workspaceRoot, "workspace-write-ok.txt");
    assert.equal(readFileSync(insideTarget, "utf8"), "WORKSPACE_WRITE_OK", "workspace-write must allow cwd writes");
    assertDenied(execEvidence(workspaceRoot, outsideTarget).output, "workspace-write escape");
    assert.equal(existsSync(outsideTarget), false, "workspace-write sandbox must reject writes outside cwd");

    assertNotWritableByProfile(workspaceRoot, approvalTarget, "approval-required preflight");
    const approvalSessions = await runCodex("approval-required sandbox", "workspace-write", [
      "This is an approval acceptance test. You must attempt exactly one exec_command even if it is rejected.",
      `Use cmd exactly \`printf APPROVAL_REQUIRED > ${shellQuote(approvalTarget)}\`.`,
      "Set sandbox_permissions to require_escalated and justification exactly `delegated remote acceptance approval probe`.",
      "Do not retry and do not use another filesystem-writing tool. Report the native result.",
    ].join(" "), "on-request");
    const approvalRoot = approvalSessions.find(session => session.depth === 0);
    if (!approvalRoot) throw new Error("Approval-required run produced no root rollout");
    assertNotWritableByProfile(approvalRoot, approvalTarget, "approval-required execution");
    assertApprovalDenied(execEvidence(approvalRoot, "APPROVAL_REQUIRED").output, "approval-required write");
    assert.equal(existsSync(approvalTarget), false, "unapproved escalated write must not execute");

    process.stdout.write(
      `REMOTE_DELEGATED_ACCEPTANCE_OK parent=${rootId} child=${childId} `
        + `origin_isolation=call_id approval=denied server=${attestation.containerId}\n`,
    );
  } finally {
    await proxy.stop(true);
    rmSync(outsideTarget, { force: true });
    rmSync(approvalTarget, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function runZeroRiskAcceptance(): Promise<void> {
  const challenge = requiredEnv("CODEX_WEB_REMOTE_ACCEPTANCE_CHALLENGE");
  const remoteBaseUrl = new URL(requiredEnv("CODEX_WEB_REMOTE_BASE_URL"));
  if (remoteBaseUrl.protocol !== "https:") throw new Error("CODEX_WEB_REMOTE_BASE_URL must use HTTPS");
  if (["localhost", "127.0.0.1", "::1"].includes(remoteBaseUrl.hostname)) {
    throw new Error("Remote delegated acceptance must not target a loopback server");
  }
  const apiKey = requiredEnv("CODEX_WEB_REMOTE_API_KEY");
  const attestationPath = resolve(requiredEnv("CODEX_WEB_REMOTE_SERVER_ATTESTATION"));
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as ServerAttestation;
  assert.equal(attestation.schema, ATTESTATION_SCHEMA, "server attestation schema");
  assert.equal(attestation.challenge, challenge, "server attestation challenge");
  assert.equal(attestation.authorityMode, "delegated", "server delegated authority");
  assert.equal(attestation.codexCliPresent, false, "server must not contain Codex CLI");
  assert.equal(attestation.clientCodexStatePresent, false, "server must not contain client Codex state");
  assert.deepEqual(attestation.unexpectedMounts, [], "server must not mount client workspace or Codex state");
  assert.notEqual(attestation.serverHostId, hostId(), "Codex client and Server must be different hosts");

  const codexArg = process.argv[3];
  const codex = resolve(codexArg ?? Bun.which("codex") ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
  if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);
  const catalogSource = expandHome(
    process.env.CODEX_WEB_REMOTE_MODEL_CATALOG ?? join(homedir(), ".codex", "api-key-models.json"),
  );
  if (!existsSync(catalogSource)) throw new Error(`Remote model catalog is missing: ${catalogSource}`);
  JSON.parse(readFileSync(catalogSource, "utf8"));
  const model = process.env.CODEX_WEB_REMOTE_ZERO_RISK_MODEL?.trim() || "chatgpt-web/zero-risk";
  const timeoutMs = Number(process.env.CODEX_WEB_REMOTE_ZERO_RISK_TIMEOUT_MS ?? 15 * 60_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) {
    throw new Error("CODEX_WEB_REMOTE_ZERO_RISK_TIMEOUT_MS must be at least 30000");
  }

  const root = mkdtempSync(join(tmpdir(), "cgw-remote-delegated-zero-risk-"));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  mkdirSync(workspace);
  mkdirSync(codexHome);
  const proofValue = `ZERO_RISK_PROOF_${createHash("sha256").update(challenge).digest("hex").slice(0, 16)}`;
  const sourceMarker = `ZERO_RISK_SOURCE_${createHash("sha256").update(`${challenge}:compaction`).digest("hex").slice(0, 16)}`;
  writeFileSync(join(workspace, "zero-risk-proof.txt"), `${proofValue}\n`);
  const catalogPath = join(root, "models.json");
  writeFileSync(catalogPath, readFileSync(catalogSource));

  const captured: CapturedRequest[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const target = new URL(remoteBaseUrl);
      const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, "");
      target.pathname = `${remoteBaseUrl.pathname.replace(/\/$/, "")}${suffix}`;
      target.search = incoming.search;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
      let capturedRequest: CapturedRequest | undefined;
      if (incoming.pathname.endsWith("/responses") && bytes) {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (object(parsed)) {
          capturedRequest = { body: parsed };
          captured.push(capturedRequest);
        }
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(target, {
        method: request.method,
        headers,
        ...(bytes ? { body: bytes } : {}),
        redirect: "manual",
      });
      if (capturedRequest) capturedRequest.responseText = response.clone().text();
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });

  writeFileSync(join(codexHome, "config.toml"), [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "delegated_remote_acceptance"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'approval_policy = "never"',
    "",
    "[model_providers.delegated_remote_acceptance]",
    'name = "Delegated remote acceptance"',
    `base_url = ${JSON.stringify(`http://127.0.0.1:${proxy.port}/v1`)}`,
    `env_key = ${JSON.stringify(API_KEY_ENV)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
    "[features]",
    "multi_agent = false",
    "",
  ].join("\n"));

  const child = Bun.spawn([codex, "app-server"], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome, [API_KEY_ENV]: apiKey },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const notifications: Record<string, unknown>[] = [];
  let nextId = 1;
  const readLoop = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === "number") {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
          else waiter?.resolve(message.result);
        } else {
          notifications.push(message);
        }
      }
    }
    for (const waiter of pending.values()) waiter.reject(new Error("Native app-server exited"));
  })();

  function send(value: unknown): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.flush();
  }

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolveRequest, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for native ${method}`)), 30_000);
        pending.set(id, { resolve: resolveRequest, reject });
        send({ id, method, params });
      });
    } finally {
      if (timer) clearTimeout(timer);
      pending.delete(id);
    }
  }

  async function completed(threadId: string, label: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = notifications.findIndex(message => message.method === "turn/completed"
        && object(message.params)?.threadId === threadId);
      if (index >= 0) {
        const notification = notifications.splice(index, 1)[0]!;
        const turn = object(object(notification.params)?.turn);
        if (!turn) throw new Error(`${label} returned no native turn`);
        assert.equal(turn.status, "completed", `${label}: ${JSON.stringify(turn.error)}`);
        return turn;
      }
      if (child.exitCode !== null) {
        throw new Error(`${label} failed because native app-server exited with ${child.exitCode}`);
      }
      await Bun.sleep(100);
    }
    throw new Error(`${label} timed out waiting for manual Zero Risk completion`);
  }

  try {
    await rpc("initialize", {
      clientInfo: { name: "remote-delegated-zero-risk-acceptance", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const started = object(await rpc("thread/start", {
      cwd: workspace,
      model,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    }));
    const thread = object(started?.thread);
    const threadId = thread?.id;
    const rolloutPath = thread?.path;
    if (typeof threadId !== "string" || !threadId) throw new Error("Zero Risk thread/start returned no thread id");
    if (typeof rolloutPath !== "string" || !rolloutPath) throw new Error("Zero Risk thread/start returned no rollout path");

    const captureStart = captured.length;
    await rpc("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: [
          `This is the remote delegated Zero Risk acceptance source. Remember the exact marker ${sourceMarker}.`,
          "Use the Zero Risk Native tool connector and call exec_command exactly once with cmd `pwd && cat zero-risk-proof.txt`.",
          "Return ZERO_RISK_FIRST_OK only after the native tool result is available.",
        ].join(" "),
      }],
    });
    await completed(threadId, "Zero Risk native tool turn");

    await rpc("thread/compact/start", { threadId });
    await completed(threadId, "Zero Risk fresh compaction");

    await rpc("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: "Do not use tools. Return ZERO_RISK_FINAL_OK followed by the exact ZERO_RISK_SOURCE marker from the compacted prior context.",
      }],
    });
    await completed(threadId, "Zero Risk post-compaction final turn");

    const session = sessionEvidence(rolloutPath);
    const nativeExec = execEvidence(session, "pwd && cat zero-risk-proof.txt");
    const nativeOutput = JSON.stringify(nativeExec.output);
    assert.ok(nativeOutput.includes(workspace), "Zero Risk native pwd must use the client workspace");
    assert.ok(nativeOutput.includes(proofValue), "Zero Risk native read must use the client workspace");
    const finalCompletion = lastTaskCompletion(session);
    const finalMessage = typeof finalCompletion?.last_agent_message === "string"
      ? finalCompletion.last_agent_message
      : "";
    assert.ok(finalMessage.includes("ZERO_RISK_FINAL_OK"), "Zero Risk final completion marker");
    assert.ok(finalMessage.includes(sourceMarker), "Zero Risk compaction must retain the source marker");

    const requests = captured.slice(captureStart).filter(entry => metadata(entry.body)?.thread_id === threadId);
    if (requests.length === 0) throw new Error("No captured Responses request matched the Zero Risk native thread");
    const compactions = requests.filter(entry => metadata(entry.body)?.request_kind === "compaction");
    if (compactions.length === 0) throw new Error("Zero Risk phase produced no native compaction request");
    const compactionMetadata = await Promise.all(compactions.map(capturedCompletedMetadata));
    assert.ok(compactionMetadata.some(value => (
      value?.codex_chatgpt_web_compaction_path === "fresh"
      && value.codex_chatgpt_web_compaction_fallback_reason === "zero_risk_source_already_completed"
    )), "Zero Risk compaction must expose fresh fallback evidence for its completed source");
    assert.ok(requests.some(entry => capturedHasCallId(entry, callId(nativeExec))),
      "Zero Risk native tool result must return to its origin thread");

    process.stdout.write(
      `REMOTE_DELEGATED_ZERO_RISK_OK thread=${threadId} native_tool=ok manual_completion=ok `
        + `compaction=fresh server=${attestation.containerId}\n`,
    );
  } finally {
    child.kill();
    await child.exited;
    await readLoop;
    const stderr = await stderrPromise;
    if (child.exitCode !== 0 && child.exitCode !== null && stderr.trim()) process.stderr.write(compact(stderr));
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "server") {
  serverAttestation();
} else if (mode === "client") {
  await runClientAcceptance();
} else if (mode === "client-zero-risk") {
  await runZeroRiskAcceptance();
} else {
  throw new Error("Usage: accept-codex-remote-delegated.ts <server|client|client-zero-risk> [codex-path]");
}
