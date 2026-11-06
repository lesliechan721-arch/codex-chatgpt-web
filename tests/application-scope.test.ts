import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { apiKeyMatches, apiKeyPolicy } from "../src/api-access";
import { apiAccessConfigPath, loadApiAccessPolicy, saveApiAccessPolicy } from "../src/api-access-config";
import { defaultConfig, getApplicationDir, getConfigDir, loadConfig, saveConfig } from "../src/config";
import { getCodexJournalPath, installCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { preflightSetup } from "../src/setup";
import { modelsRequest } from "../src/server";
import { loadUpstreamProviderConfig, saveUpstreamProviderConfig } from "../src/upstream-provider-config";
import { upstreamApiKeyDigest } from "../src/upstream-provider";
import { installCodexInterruptHookLauncher, loadCodexInterruptHookConfig } from "../src/codex-interrupt-hook";

const ACCOUNT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const environmentKeys = ["CODEX_CHATGPT_WEB_HOME", "CODEX_CHATGPT_WEB_APPLICATION_HOME", "CODEX_HOME",
  "CODEX_CHATGPT_WEB_ACCOUNT_ID", "CODEX_CHATGPT_WEB_ACCOUNTS_PATH"] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-application-scope-"));
  roots.push(root);
  const applicationHome = join(root, "application");
  const accountHome = join(applicationHome, "accounts", ACCOUNT_ID, "core");
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = applicationHome;
  delete process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME;
  delete process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID;
  delete process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH;
  return { root, applicationHome, accountHome, codexHome };
}

test("application paths retain the CLI default and share policy across account homes", async () => {
  const { applicationHome, accountHome } = fixture();
  expect(getApplicationDir()).toBe(getConfigDir());
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
  const key = "cgw_" + "a".repeat(43);
  saveApiAccessPolicy(apiKeyPolicy(key));
  saveUpstreamProviderConfig({ version: 2, baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("account-a-key"), proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false });

  process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
  expect(getApplicationDir()).toBe(applicationHome);
  expect(apiAccessConfigPath()).toBe(join(applicationHome, "api-access.json"));
  const policy = loadApiAccessPolicy();
  expect(apiKeyMatches(key, policy)).toBe(true);
  expect(apiKeyMatches("cgw_" + "b".repeat(43), policy)).toBe(false);
  expect(loadUpstreamProviderConfig()).toBeUndefined();
  for (const [bearer, status] of [[key, 200], ["cgw_" + "b".repeat(43), 401]] as const) {
    const response = await modelsRequest(new Request("http://127.0.0.1/v1/models", {
      headers: { authorization: `Bearer ${bearer}` },
    }), defaultConfig(), undefined, undefined, policy);
    expect(response.status).toBe(status);
  }
});

test("new accounts use the established application port without inheriting account settings", () => {
  const { applicationHome, accountHome } = fixture();
  const original = { ...defaultConfig(), port: 18749, proAvailable: true };
  saveConfig(original);
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
  loadConfig();
  process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
  const next = defaultConfig();
  expect(next.port).toBe(original.port);
  expect(next.storageStatePath).toBe(join(accountHome, "browser", "storage-state.json"));
  expect(next.proAvailable).toBe(false);
  expect(next.tunnel).toBeUndefined();
  expect(next.controlToken).not.toBe(original.controlToken);
  expect(() => preflightSetup({ mode: "browser-only", port: original.port + 1 }))
    .toThrow("application service port");
  saveConfig(next);
  expect(JSON.parse(readFileSync(join(accountHome, "config.json"), "utf8")).port).toBe(original.port);
  rmSync(join(applicationHome, "config.json"));
  expect(loadConfig().port).toBe(original.port);
  expect(existsSync(join(applicationHome, "service-endpoint.json"))).toBe(true);
});

test("setting up another account retains the original shared Codex restoration journal", () => {
  const { applicationHome, accountHome, codexHome } = fixture();
  const original = '# Existing Codex configuration\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:9000/v1"\n';
  writeFileSync(join(codexHome, "config.toml"), original);
  const first = { ...defaultConfig(), port: 18749 };
  saveConfig(first);
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
  const installed = installCodexIntegration(loadConfig(), { replaceExistingRoute: true });
  process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
  const second = defaultConfig();
  saveConfig(second);
  const updated = installCodexIntegration(second);
  expect(getCodexJournalPath()).toBe(join(applicationHome, "codex", "integration-journal.json"));
  expect(updated.previous).toEqual(installed.previous);
  expect(updated.interruptHook.command).toBe(installed.interruptHook.command);
  expect(updated.installed.openai_base_url).toBe(installed.installed.openai_base_url);
  expect(existsSync(join(accountHome, "codex", "integration-journal.json"))).toBe(false);
  uninstallCodexIntegration();
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
});

test("starting an empty account retains the installed Codex route and serves unready on the shared endpoint", async () => {
  const { applicationHome, accountHome, codexHome } = fixture();
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserved.port!;
  await reserved.stop(true);
  writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:9000/v1"\n');
  const first = { ...defaultConfig(), port };
  saveConfig(first);
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
  installCodexIntegration(first, { replaceExistingRoute: true });
  const configBefore = readFileSync(join(codexHome, "config.toml"), "utf8");
  const journalBefore = readFileSync(getCodexJournalPath(), "utf8");
  process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
  expect(existsSync(join(accountHome, "config.json"))).toBe(false);

  const require = createRequire(import.meta.url);
  const { listenAccountNotReady } = require("../launcher/electron/account-not-ready.cjs");
  const main = readFileSync(resolve(import.meta.dir, "../launcher/electron/main.cjs"), "utf8");
  const start = main.indexOf("} else void (async () => {");
  const startup = main.slice(start + "} else ".length, main.indexOf('  app.on("before-quit"', start));
  const listenerSource = main.slice(main.indexOf("async function ensureNotReadyListener()"), main.indexOf("function restoreLaunchEnvironment()"));
  const state = { coreSetupComplete: false, mcpRuntimeInstalled: false, mcpSetupComplete: false };
  let routeRestorations = 0;
  let listener: { close: () => Promise<void> } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((complete, reject) => {
      timeout = setTimeout(() => reject(new Error("Unready listener did not start")), 5000);
      runInNewContext(listenerSource + startup, {
        IS_DEV_PROFILE: false, exitCommitted: false, proxyReady: true, notReadyListener: null,
        APPLICATION_HOME: applicationHome, path: { join }, finishRuntimeStartup() {},
        logger: { info() {}, error() {} }, send() {}, connectorSetupStatePatch: () => ({}),
        stateStore: { read: () => state, update: (patch: object) => Object.assign(state, patch) },
        runtimeSupervisor: { startIfConfigured: async () => ({ status: "not-configured" }) },
        runtimeHost: { upgradeManagedRuntime: async () => ({ updated: false }),
          runtimeConfigSnapshot: () => ({ configured: false, config: null }) },
        restoreCodexRouteAfterRuntimeFailure: async () => {
          routeRestorations++;
          uninstallCodexIntegration();
          return { restored: true };
        },
        publishOperation: (operation: { message: string }) => reject(new Error(operation.message)),
        listenAccountNotReady: async (options: { applicationHome: string }) => {
          listener = await listenAccountNotReady({ ...options, environment: {} });
          complete();
          return listener;
        },
      });
    });
    expect(routeRestorations).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(configBefore);
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(journalBefore);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST" });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("account_not_ready");
  } finally {
    clearTimeout(timeout);
    await listener?.close();
  }
});

test("API-key export uses the shared service URL and selected account settings", async () => {
  const { applicationHome, accountHome } = fixture();
  const key = "cgw_" + "a".repeat(43);
  const first = defaultConfig();
  saveConfig(first);
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
  saveApiAccessPolicy(apiKeyPolicy(key));
  saveUpstreamProviderConfig({ version: 2, baseUrl: "https://account-a.invalid/v1/",
    apiKeySha256: upstreamApiKeyDigest("account-a-key"), proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false });
  process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
  const second = defaultConfig();
  second.solAvailable = false;
  saveConfig(second);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"),
    "--home", accountHome, "api-key", "codex-config", "--json"], {
    env: { ...process.env, CODEX_CHATGPT_WEB_API_KEY: key, CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: undefined,
      CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: undefined, CODEX_CHATGPT_WEB_CLIENT_PORT: undefined },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, errors).toBe(0);
  const exported = JSON.parse(output);
  expect(Object.keys(exported).sort()).toEqual(["baseUrl", "config", "environment"]);
  expect(existsSync(join(applicationHome, "api-key-models.json"))).toBe(false);
  expect(existsSync(join(accountHome, "api-key-models.json"))).toBe(false);
  expect(exported.config).not.toContain("account-a.invalid");
  expect(exported.baseUrl).toBe(`http://127.0.0.1:${first.port}/v1`);
  const provider = (Bun.TOML.parse(exported.config) as any).model_providers.chatgpt_web;
  expect(provider.model_catalog_url).toBe(`${exported.baseUrl}/models`);
});

test("the installed Interrupt hook selects the loaded account after a switch without another setup", async () => {
  if (process.platform === "win32") return;
  const { applicationHome, accountHome, root } = fixture();
  const registryPath = join(root, "launcher", "accounts.json");
  const registry = { version: 1, currentId: "default", lastLoadedId: "default", pendingId: null as string | null,
    accounts: [{ id: "default", legacy: true, status: "active" },
      { id: ACCOUNT_ID, legacy: false, status: "active" }] };
  mkdirSync(join(root, "launcher"));
  writeFileSync(registryPath, JSON.stringify(registry));
  let authorization = "";
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    authorization = request.headers.get("authorization") ?? "";
    return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 0 });
  } });
  try {
    const first = { ...defaultConfig(), port: listener.port!, runtimeCommand: [process.execPath, resolve(import.meta.dir, "../src/cli.ts")] };
    saveConfig(first);
    process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = applicationHome;
    process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH = registryPath;
    installCodexInterruptHookLauncher(first);
    process.env.CODEX_CHATGPT_WEB_HOME = accountHome;
    const second = defaultConfig();
    saveConfig(second);
    registry.currentId = ACCOUNT_ID;
    registry.lastLoadedId = ACCOUNT_ID;
    writeFileSync(registryPath, JSON.stringify(registry));
    const child = Bun.spawn(["/bin/sh", join(applicationHome, "hooks", "interrupt.sh")], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: applicationHome, CODEX_CHATGPT_WEB_ACCOUNT_ID: "default" },
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Interrupt", session_id: "thread_example", turn_id: "turn_example" })),
      stdout: "pipe", stderr: "pipe",
    });
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
    expect(authorization).toBe(`Bearer ${second.controlToken}`);
    registry.pendingId = "default";
    writeFileSync(registryPath, JSON.stringify(registry));
    expect(() => loadCodexInterruptHookConfig()).toThrow("No loaded account");
    registry.pendingId = null;
    registry.accounts[1]!.status = "removing";
    writeFileSync(registryPath, JSON.stringify(registry));
    expect(() => loadCodexInterruptHookConfig()).toThrow("loaded account is unavailable");
    registry.currentId = "../outside";
    registry.lastLoadedId = "../outside";
    writeFileSync(registryPath, JSON.stringify(registry));
    expect(() => loadCodexInterruptHookConfig()).toThrow("No loaded account");
  } finally { await listener.stop(true); }
});
