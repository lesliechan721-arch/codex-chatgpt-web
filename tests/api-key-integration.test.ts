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
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = defaultConfig(); saveConfig(config); installCodexIntegration(config);
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

function cli(args: string[]) {
  return Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", process.env.CODEX_CHATGPT_WEB_HOME!, ...args],
    {
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
test("manual server mode leaves recorded Codex client files byte-for-byte unchanged on API enable, rotate and serve", async () => {
  const port = await unusedPort();
  saveApiAccessPolicy(OPENAI_ACCESS);
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = { ...defaultConfig(), port };
  saveConfig(config);
  installCodexIntegration(config);
  const before = clientFileSnapshot();

  const enabled = cli(["api-key", "enable", "--generate"]);
  expect(enabled.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const rotated = cli(["api-key", "rotate", "--generate"]);
  expect(rotated.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const cleanup = cli(["api-key", "cleanup"]);
  expect(cleanup.exitCode).toBe(0);
  expect(JSON.parse(cleanup.stdout.toString())).toEqual({ changed: false, manualConfigurationRequired: true });
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
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await Bun.sleep(20);
    }
    expect(healthy).toBeTrue();
    expect(clientFileSnapshot()).toEqual(before);
  } finally {
    serve.kill();
    await serve.exited;
  }
});
test("export shares V1 feature defaults and Interrupt command but omits conflicting auth/voice/trust", () => {
  const config = defaultConfig();
  const text = renderApiKeyCodexConfig({ port: 17841, catalogPath: "/catalog.json", model: "chatgpt-web/high",
    reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: config.subagentProtocol, runtimeCommand: config.runtimeCommand });
  const parsed = Bun.TOML.parse(text) as any;
  const defaults = Bun.TOML.parse(installCompatibilityV1Features("").text) as any;
  expect(text).not.toContain("Managed by codex-chatgpt-web");
  expect(parsed.features).toEqual(defaults.features); expect(parsed.agents).toEqual(defaults.agents);
  expect(parsed.hooks.Interrupt[0].hooks[0].command).toBe(codexInterruptHookCommand(config));
  expect(parsed.hooks.state).toBeUndefined(); expect(parsed.openai_base_url).toBeUndefined();
  expect(parsed.experimental_realtime_webrtc_call_base_url).toBeUndefined();
  expect(parsed.model_providers.chatgpt_web.requires_openai_auth).toBe(false);
  expect(existsSync(getCodexConfigPath())).toBe(false);
});
test("native subagent export does not inject Compatibility V1 feature overrides", () => {
  const parsed = Bun.TOML.parse(renderApiKeyCodexConfig({ port: 17841, catalogPath: "/catalog.json",
    model: "chatgpt-web/high", reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: "native" })) as any;
  expect(parsed.features).toBeUndefined(); expect(parsed.agents).toBeUndefined();
});
