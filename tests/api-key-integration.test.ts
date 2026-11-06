import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { saveApiAccessPolicy } from "../src/api-access-config";
import {
  installCodexIntegration,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "../src/codex-integration";
import { cleanupApiKeyCodexIntegration } from "../src/api-key-integration";
import { renderApiKeyCodexConfig } from "../src/api-key-codex-config";
import { installCompatibilityV1Features } from "../src/codex-integration-document";
import { codexInterruptHookCommand } from "../src/codex-interrupt-hook";
import { preflightSetup } from "../src/setup";

let home: string;
let oldCore: string | undefined;
let oldCodex: string | undefined;
beforeEach(() => {
  oldCore = process.env.CODEX_CHATGPT_WEB_HOME; oldCodex = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "api-manual-config-"));
  process.env.CODEX_CHATGPT_WEB_HOME = join(home, "core"); process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
});
afterEach(() => {
  if (oldCore === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldCore;
  if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  rmSync(home, { recursive: true, force: true });
});
const api = () => saveApiAccessPolicy(apiKeyPolicy("a".repeat(40)));
function injected() {
  saveApiAccessPolicy(OPENAI_ACCESS);
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "openai"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = defaultConfig(); saveConfig(config); installCodexIntegration(config);
  writeFileSync(
    getCodexConfigPath(),
    readFileSync(getCodexConfigPath(), "utf8").replace('model_provider = "openai"', 'model_provider = "custom"'),
  );
  api(); return config;
}

function clientFileSnapshot(): Array<{ path: string; bytes: string | null }> {
  return [
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => ({
    path,
    bytes: existsSync(path) ? readFileSync(path).toString("base64") : null,
  }));
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port reservation has no TCP address");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return port;
}

async function cli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", process.env.CODEX_CHATGPT_WEB_HOME!, ...args],
    {
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`CLI ${args.join(" ")} failed: exit=${exitCode}; signal=${child.signalCode}`
      + `\nstdout: ${stdout.slice(-8_192)}\nstderr: ${stderr.slice(-8_192)}`);
  }
  return { exitCode, stdout, stderr };
}
test("API cleanup removes recorded routes/features/hooks but retains the user's provider", () => {
  injected(); expect(cleanupApiKeyCodexIntegration().changed).toBe(true);
  const parsed = Bun.TOML.parse(readFileSync(getCodexConfigPath(), "utf8")) as any;
  expect(parsed.model_provider).toBe("custom"); expect(parsed.model_providers.custom.name).toBe("Own provider");
  expect(parsed.openai_base_url).toBeUndefined(); expect(parsed.experimental_realtime_webrtc_call_base_url).toBeUndefined();
  expect(parsed.hooks?.Interrupt).toBeUndefined(); expect(existsSync(getCodexJournalPath())).toBe(false);
  expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
});
test("later manual API-provider changes survive cleanup of the old injection", () => {
  injected(); const file = getCodexConfigPath();
  const updated = readFileSync(file, "utf8").replace('model_provider = "custom"',
    'model_provider = "chatgpt_web"\nmodel_catalog_json = "/manual/catalog.json"');
  writeFileSync(file, updated); cleanupApiKeyCodexIntegration();
  const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(parsed.model_provider).toBe("chatgpt_web"); expect(parsed.model_catalog_json).toBe("/manual/catalog.json");
});
test("without ownership journal manually copied settings are byte-for-byte untouched", () => {
  api(); const text = 'model_provider = "chatgpt_web"\n[features]\nmulti_agent = true\n';
  writeFileSync(getCodexConfigPath(), text); expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(text);
});
test("dry run never edits or removes recorded injection", () => {
  injected(); const before = readFileSync(getCodexConfigPath(), "utf8");
  cleanupApiKeyCodexIntegration(true); expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(before);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("missing config is not recreated to clean a stale journal", () => {
  injected(); rmSync(getCodexConfigPath()); cleanupApiKeyCodexIntegration();
  expect(existsSync(getCodexConfigPath())).toBe(false); expect(existsSync(getCodexJournalPath())).toBe(false);
});
test("modified hook is a conflict and never overwritten", () => {
  injected(); const file = getCodexConfigPath();
  const text = readFileSync(file, "utf8").replace('timeout = 3', 'timeout = 7'); writeFileSync(file, text);
  expect(() => cleanupApiKeyCodexIntegration()).toThrow(); expect(readFileSync(file, "utf8")).toBe(text);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("OpenAI forwarding is not cleaned by an API-only operation", () => {
  injected(); saveApiAccessPolicy(OPENAI_ACCESS); expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("API preflight accepts manual providers and creates no Codex injection", () => {
  api(); preflightSetup({ mode: "browser-only", browserHostDescriptorPath: join(home, "browser.json"), acknowledgedUnofficial: true });
  expect(existsSync(getCodexConfigPath())).toBe(false); expect(existsSync(getCodexJournalPath())).toBe(false);
});
// Three CLI processes, server startup, and cleanup each have their own deadline.
test("manual server mode leaves recorded Codex client files byte-for-byte unchanged on API enable, rotate and serve", async () => {
  const port = await unusedPort();
  saveApiAccessPolicy(OPENAI_ACCESS);
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "openai"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = { ...defaultConfig(), port };
  saveConfig(config);
  installCodexIntegration(config);
  writeFileSync(
    getCodexConfigPath(),
    readFileSync(getCodexConfigPath(), "utf8").replace('model_provider = "openai"', 'model_provider = "custom"'),
  );
  const before = clientFileSnapshot();

  const enabled = await cli(["api-key", "enable", "--generate"]);
  expect(enabled.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const rotated = await cli(["api-key", "rotate", "--generate"]);
  expect(rotated.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const cleanup = await cli(["api-key", "cleanup"]);
  expect(cleanup.exitCode).toBe(0);
  expect(JSON.parse(cleanup.stdout)).toEqual({ changed: false, manualConfigurationRequired: true });
  expect(clientFileSnapshot()).toEqual(before);

  const serve = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", process.env.CODEX_CHATGPT_WEB_HOME!, "serve"],
    {
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const logs = { stdout: "", stderr: "" };
  const drain = async (stream: ReadableStream<Uint8Array>, name: keyof typeof logs) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        logs[name] = (logs[name] + decoder.decode(value, { stream: true })).slice(-8_192);
      }
      logs[name] = (logs[name] + decoder.decode()).slice(-8_192);
    } finally { reader.releaseLock(); }
  };
  const output = Promise.allSettled([drain(serve.stdout, "stdout"), drain(serve.stderr, "stderr")]);
  let exitCode: number | undefined;
  const exited = serve.exited.then(code => { exitCode = code; });
  let failure: unknown;
  try {
    const deadline = performance.now() + 30_000;
    let lastFailure = "no health response";
    for (;;) {
      if (exitCode !== undefined) throw new Error("Server exited before becoming healthy");
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Server health deadline exceeded: ${lastFailure}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, Math.ceil(remaining)))),
        });
        await response.body?.cancel();
        if (response.ok) break;
        lastFailure = `HTTP ${response.status}`;
      } catch (error) { lastFailure = String(error); }
      await Promise.race([Bun.sleep(Math.min(50, Math.max(0, deadline - performance.now()))), exited]);
    }
    expect(clientFileSnapshot()).toEqual(before);
  } catch (error) {
    failure = error;
  } finally {
    if (serve.exitCode === null) serve.kill();
    const forceStop = setTimeout(() => serve.kill("SIGKILL"), 3_000);
    try { await exited; await output; }
    finally { clearTimeout(forceStop); }
  }
  if (failure) {
    throw new Error(`${String(failure)}; server exit=${exitCode}; signal=${serve.signalCode}`
      + `\nstdout: ${logs.stdout}\nstderr: ${logs.stderr}`, { cause: failure });
  }
}, 150_000);
test("export shares V1 feature defaults and Interrupt command but omits conflicting auth/voice/trust", () => {
  const config = defaultConfig();
  const text = renderApiKeyCodexConfig({ port: 17841, model: "chatgpt-web/high",
    reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: config.subagentProtocol, runtimeCommand: config.runtimeCommand });
  const parsed = Bun.TOML.parse(text) as any;
  const defaults = Bun.TOML.parse(installCompatibilityV1Features("").text) as any;
  expect(text).not.toContain("Managed by codex-chatgpt-web");
  expect(parsed.features).toEqual({ ...defaults.features, instant_interrupt: false });
  expect(parsed.agents).toEqual(defaults.agents);
  expect(parsed.tui.auto_recap).toBe(false);
  expect(parsed.hooks.Interrupt[0].hooks[0].command).toBe(codexInterruptHookCommand());
  expect(parsed.hooks.state).toBeUndefined(); expect(parsed.openai_base_url).toBeUndefined();
  expect(parsed.experimental_realtime_webrtc_call_base_url).toBeUndefined();
  expect(parsed.model_providers.chatgpt_web.requires_openai_auth).toBe(false);
  expect(parsed.model_providers.chatgpt_web.model_catalog_url).toBe("http://127.0.0.1:17841/v1/models");
  expect(parsed.model_catalog_json).toBeUndefined();
  expect(existsSync(getCodexConfigPath())).toBe(false);
});
test("native subagent export does not inject Compatibility V1 feature overrides", () => {
  const parsed = Bun.TOML.parse(renderApiKeyCodexConfig({ port: 17841,
    model: "chatgpt-web/high", reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: "native" })) as any;
  expect(parsed.features).toEqual({ instant_interrupt: false });
  expect(parsed.agents).toBeUndefined();
  expect(parsed.tui.auto_recap).toBe(false);
});

test("API-key catalog URL appends models after a path prefix and removes trailing slashes", () => {
  const parsed = Bun.TOML.parse(renderApiKeyCodexConfig({
    port: 17841,
    baseUrl: " https://server.example.com/service/v1/// ",
    model: "chatgpt-web/high",
    reasoningEffort: "high",
    apiKey: "cgw_" + "a".repeat(43),
  })) as any;
  expect(parsed.model_providers.chatgpt_web.model_catalog_url).toBe("https://server.example.com/service/v1/models");
  expect(parsed.model_catalog_json).toBeUndefined();
});
