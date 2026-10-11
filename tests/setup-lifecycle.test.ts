import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import * as browserHost from "../src/launcher-browser-host";
import * as browserLogin from "../src/browser-login";
import * as apiAccessConfig from "../src/api-access-config";
import { runDoctor } from "../src/doctor";
import { DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME } from "../src/native-tool-long-wait-probe";
import { launcherCapabilityProbeRequired, setup, setupDevProfile, setupProxyIsReady } from "../src/setup";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";

for (const development of [false, true]) for (const interaction of ["automatic", "manual"] as const) {
  test(`${development ? "DEV" : "production"} ${interaction} upgrades the previous ABI only on setup commit`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-context-abi-setup-"));
    const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const configPath = join(root, "config.json");
    const tunnelFor = (mode: "automatic" | "manual") => ({
      binaryPath: join(root, "tunnel-client"), tunnelId: `tunnel_${(mode === "automatic" ? "a" : "b").repeat(32)}`,
      runtimeKeyFile: join(root, `${mode}.key`), profileDir: root, profileName: mode, alias: mode,
    });
    const automaticTunnel = tunnelFor("automatic");
    const manualTunnel = tunnelFor("manual");
    for (const tunnelConfig of [automaticTunnel, manualTunnel]) writeFileSync(tunnelConfig.runtimeKeyFile, "fixture-key");
    const existing = {
      ...configModule.defaultConfig("full"),
      ...(development ? { purpose: "dev-harness" as const, devNativeToolLongWaitProbe: interaction === "automatic" } : {}),
      browserHost: "launcher" as const, browserHostDescriptorPath: join(root, "launcher.json"),
      browserInteractionMode: interaction, automaticAppName: development ? "Codex Native4 DEV" : "Codex Native4",
      manualAppName: "Codex Zero Risk3", appName: interaction === "manual" ? "Codex Zero Risk3"
        : development ? "Codex Native4 DEV" : "Codex Native4",
      tunnel: interaction === "manual" ? manualTunnel : automaticTunnel, automaticTunnel, manualTunnel,
      useSavedChats: true, zeroRiskRequireSentConfirmation: false,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      acknowledgedUnofficialAt: "2026-10-01T00:00:00.000Z",
    };
    const original = JSON.stringify(existing);
    writeFileSync(configPath, original);
    let rejectCommit = false;
    const save = spyOn(configModule, "saveConfig").mockImplementation(value => {
      if (rejectCommit) throw new Error("fixture commit failed");
      writeFileSync(configPath, JSON.stringify(value));
    });
    const integrate = spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never));
    const inspect = spyOn(browserHost, "inspectLauncherBrowserHost").mockRejectedValue(new Error("fixture must not inspect a live account"));
    const mocks = [save, integrate, inspect,
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockImplementation(mode => mode === "manual" ? manualTunnel.runtimeKeyFile : automaticTunnel.runtimeKeyFile),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("fixture must not connect a tunnel"); }),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const options = { mode: "full" as const, browserHostDescriptorPath: existing.browserHostDescriptorPath,
        browserInteractionMode: interaction, subagentProtocol: "native" as const, port };
      const configure = development ? setupDevProfile : setup;
      const result = await configure(options);
      const committed = JSON.parse(readFileSync(configPath, "utf8"));
      expect(result.connectorSetupRequired).toBe(true);
      expect(committed.automaticAppName).toBe(development ? "Codex Native5 DEV" : "Codex Native5");
      expect(committed.manualAppName).toBe("Codex Zero Risk4");
      expect(committed.appName).toBe(interaction === "manual" ? "Codex Zero Risk4" : committed.automaticAppName);
      expect(committed.automaticTunnel.tunnelId).toBe(automaticTunnel.tunnelId);
      expect(committed.manualTunnel.tunnelId).toBe(manualTunnel.tunnelId);
      expect(committed.useSavedChats).toBe(true);
      expect(committed.zeroRiskRequireSentConfirmation).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
      writeFileSync(configPath, original);
      rejectCommit = true;
      const integrationCount = integrate.mock.calls.length;
      await expect(configure(options)).rejects.toThrow("fixture commit failed");
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(integrate.mock.calls.length).toBe(integrationCount);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("doctor rejects both retired MCP modes before browser verification and skips non-MCP access", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-abi-doctor-"));
  let runtimeConfig = { ...configModule.defaultConfig("full"), browserHost: "launcher" as const,
    browserHostDescriptorPath: join(root, "missing-launcher.json"), appName: "Codex Native4" };
  let policy = { version: 1, mode: "loopback" };
  const inspect = spyOn(browserHost, "inspectLauncherBrowserHost").mockRejectedValue(new Error("fixture browser unavailable"));
  const mocks = [inspect,
    spyOn(configModule, "loadConfig").mockImplementation(() => runtimeConfig),
    spyOn(apiAccessConfig, "loadApiAccessPolicy").mockImplementation(() => policy as never),
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture proxy unavailable")),
    spyOn(integration, "inspectCodexIntegration").mockReturnValue({ installed: false, errors: [] } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnel, "tunnelStatus").mockReturnValue({ ok: false, detail: "fixture tunnel unavailable" } as never),
  ];
  try {
    for (const [name, replacement] of [["Codex Native4", "Codex Native5"], ["Codex Native4 DEV", "Codex Native5 DEV"],
      ["Codex Zero Risk3", "Codex Zero Risk4"]]) {
      runtimeConfig.appName = name!;
      const report = await runDoctor();
      expect(report.ok).toBe(false);
      expect(report.checks).toHaveLength(2);
      expect(report.checks[1]).toMatchObject({ id: "connector", status: "error" });
      expect(report.checks[1]!.detail).toContain(replacement!);
      expect(report.checks[1]!.detail).toContain("do not rename or refresh");
    }
    expect(inspect).not.toHaveBeenCalled();
    runtimeConfig.mode = "browser-only";
    expect((await runDoctor()).checks.some(check => check.message.includes("ABI upgrade"))).toBe(false);
    runtimeConfig.mode = "full";
    runtimeConfig.tunnel = { binaryPath: join(root, "missing-client"), tunnelId: `tunnel_${"a".repeat(32)}`,
      runtimeKeyFile: join(root, "missing-key"), profileDir: root, profileName: "fixture", alias: "fixture" };
    policy = { version: 1, mode: "api-key" };
    expect((await runDoctor()).checks.some(check => check.message.includes("ABI upgrade"))).toBe(false);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({ ...verifiedLauncher, extraHighAvailable: undefined } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    extraHighAvailable: false, proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});

for (const development of [false, true]) {
  test(`${development ? "DEV" : "production"} updates an installed launcher without a ChatGPT session`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-offline-upgrade-"));
    const configPath = join(root, "config.json");
    const existing = {
      ...configModule.defaultConfig("browser-only"),
      releaseVersion: "6.1.4",
      browserHost: "launcher" as const,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      ...(development ? { purpose: "dev-harness" as const } : {}),
    };
    writeFileSync(configPath, JSON.stringify(existing));
    const save = spyOn(configModule, "saveConfig").mockImplementation(() => {});
    const inspect = spyOn(browserHost, "inspectLauncherBrowserHost").mockRejectedValue(new Error("ChatGPT is signed out"));
    const mocks = [save, inspect,
      spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
      spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(existing)),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const options = { mode: "browser-only" as const, subagentProtocol: "native" as const, port,
        browserHostDescriptorPath: join(root, "launcher-browser.json"), acknowledgedUnofficial: true };
      const configure = development ? setupDevProfile : setup;
      await configure(options);
      expect(inspect).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toMatchObject({
        releaseVersion: configModule.defaultConfig().releaseVersion,
        solAvailable: true, extraHighAvailable: true, proAvailable: true,
      });
      // Refreshing the actual model list still requires evidence from the account.
      await expect(configure({ ...options, refreshAccountCapabilities: true })).rejects.toThrow("ChatGPT is signed out");
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const development of [false, true]) for (const interaction of ["manual", "automatic"] as const) {
  test(`${development ? "DEV" : "production"} ${interaction} setup commits the tunnel inputs before its supervisor starts the runtime`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-setup-owner-"));
    const key = join(root, "runtime.key");
    writeFileSync(key, "fixture-runtime-key");
    const calls: string[] = [];
    let saved: configModule.AppConfig | undefined;
    const mocks = [
      spyOn(configModule, "getConfigDir").mockReturnValue(root),
      spyOn(configModule, "getConfigPath").mockReturnValue(join(root, "config.json")),
      spyOn(configModule, "saveConfig").mockImplementation(value => { saved = value; calls.push("save"); }),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => { calls.push("integrate"); return {} as never; }),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("setup started a runtime before committing its inputs"); }),
      spyOn(tunnel, "stopTunnel").mockImplementation(() => { throw new Error("setup stopped the supervisor's runtime"); }),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true } as never),
    ];
    try {
      const options = {
        mode: "full" as const,
        browserInteractionMode: interaction,
        subagentProtocol: "native" as const,
        browserHostDescriptorPath: join(root, "launcher-browser.json"),
        tunnelId: `tunnel_${"a".repeat(32)}`,
        acknowledgedUnofficial: true,
      };
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const result = await (development ? setupDevProfile : setup)({ ...options, port,
        ...(interaction === "automatic" ? { experimentalFreshConversationPerTurn: true } : {}),
        ...(development && interaction === "automatic" ? { devNativeToolLongWaitProbe: true } : {}),
        useSavedChats: true,
        connectorNameSuffix: "Work",
      });
      expect(calls).toEqual(development ? ["save"] : ["save", "integrate"]);
      expect(saved?.tunnel?.alias).toBe(`codex-chatgpt-web${development ? "-dev" : ""}${interaction === "manual" ? "-zero-risk" : ""}`);
      expect(result.tunnelReady).not.toBe(true);
      expect(result.connectorSetupRequired).toBe(true);
      expect(saved?.experimentalFreshConversationPerTurn).toBe(interaction === "automatic");
      expect(saved?.useSavedChats).toBe(true);
      const continuityPath = join(root, "runtime", "session-continuity");
      const continuity = new ContinuityRegistrationStore(continuityPath);
      const thread = "1".repeat(64);
      const owner = "2".repeat(64);
      expect(continuity.get(thread)).toBeUndefined();
      continuity.claim(thread, "3".repeat(64), owner);
      continuity.finish(thread, owner, "lost");

      if (development && interaction === "automatic") {
        expect(saved?.appName).toBe(DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME);
        expect(saved?.automaticAppName).toBe(DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME);
      } else {
        expect(saved?.appName).toBe("Codex Work");
      }
      expect(interaction === "manual" ? saved?.automaticAppName : saved?.manualAppName)
        .toBe(interaction === "automatic"
          ? configModule.ZERO_RISK_CHATGPT_CONNECTOR_NAME
          : development ? configModule.DEV_CHATGPT_CONNECTOR_NAME : configModule.CHATGPT_CONNECTOR_NAME);
      // Unrelated setup and mode changes retain the suffix; clearing it is explicit.
      const initial = structuredClone(saved!);
      mocks.push(spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(initial)));
      writeFileSync(join(root, "config.json"), JSON.stringify(initial));
      await (development ? setupDevProfile : setup)({ ...options, port });
      expect(saved?.appName).toBe(initial.appName);
      await expect((development ? setupDevProfile : setup)({
        ...options,
        port,
        connectorNameSuffix: interaction === "manual" ? "Zero Risk" : development ? "Native2 DEV" : "Native2",
      })).rejects.toThrow("retired");

      calls.length = 0;
      mocks.push(spyOn(configModule, "saveConfig").mockImplementation(() => { throw new Error("config commit failed"); }));
      await expect((development ? setupDevProfile : setup)({ ...options, port })).rejects.toThrow("config commit failed");
      expect(calls).toEqual([]);
      expect(continuity.get(thread)?.state).toBe("lost");
      const registryFile = join(continuityPath, "threads.json");
      writeFileSync(registryFile, "broken registration");
      await expect((development ? setupDevProfile : setup)({ ...options, port })).rejects.toThrow("was not reset");
      expect(readFileSync(registryFile, "utf8")).toBe("broken registration");
      expect(calls).toEqual([]);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const development of [false, true]) {
  test(`${development ? "DEV" : "production"} rejects Luna Bigger Context without changing config and accepts explicitly disabling it`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-luna-setup-"));
    const configPath = join(root, "config.json");
    const existing = {
      ...configModule.defaultConfig("browser-only"),
      browserHost: "launcher" as const,
      solAvailable: false, extraHighAvailable: false, proAvailable: false,
      experimentalBiggerContext: true,
      ...(development ? { purpose: "dev-harness" as const } : {}),
    };
    writeFileSync(configPath, JSON.stringify(existing));
    let scannedSolAvailable = false;
    const save = spyOn(configModule, "saveConfig").mockImplementation(() => {});
    const integrate = spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never));
    const mocks = [save, integrate,
      spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
      spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(existing)),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockImplementation(async () => ({
        solAvailable: scannedSolAvailable, extraHighAvailable: false, proAvailable: false,
      }) as never),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const options = { mode: "browser-only" as const, subagentProtocol: "native" as const, port,
        browserHostDescriptorPath: join(root, "launcher-browser.json"), acknowledgedUnofficial: true };
      const configure = development ? setupDevProfile : setup;
      await expect(configure(options)).rejects.toThrow("Turn it off in launcher Settings");
      await expect(configure({ ...options, experimentalBiggerContext: true })).rejects.toThrow("unavailable for Luna and Think");
      // Refreshing a previously paid account must validate the newly observed capability.
      existing.solAvailable = true;
      await expect(configure({ ...options, refreshAccountCapabilities: true })).rejects.toThrow("--standard-context");
      expect(save).not.toHaveBeenCalled();
      expect(integrate).not.toHaveBeenCalled();
      existing.solAvailable = false;
      await configure({ ...options, experimentalBiggerContext: false });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: false, experimentalBiggerContext: false });
      expect(existing.experimentalBiggerContext).toBeTrue();
      scannedSolAvailable = true;
      await configure({ ...options, refreshAccountCapabilities: true, experimentalBiggerContext: true });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: true, experimentalBiggerContext: true });
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform !== "darwin")("external service setup retains validation cleanup on success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-setup-"));
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(configPath, "{}");
  const existing = {
    ...configModule.defaultConfig("full"),
    subagentProtocol: "native" as const,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
    service: "codex-chatgpt-web", status: "ok", mode: "full", version: existing.releaseVersion, accepting_turns: true,
  }) });
  existing.port = proxy.port!;
  const calls: string[] = [];
  let ready = true;
  let stopFails = false;
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => {}),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(true),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "assertServiceIdle").mockResolvedValue(undefined),
    spyOn(service, "installService").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "restartService").mockResolvedValue({ installed: true, loaded: true } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnelService, "installTunnelService").mockImplementation(() => { calls.push("service"); return { installed: true, loaded: true } as never; }),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
    spyOn(tunnel, "connectTunnel").mockImplementation(() => { calls.push("connect"); }),
    spyOn(tunnel, "waitForTunnelReady").mockImplementation(async () => { calls.push("ready"); return { ok: ready, detail: "fixture readiness" } as never; }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {
      calls.push("stop");
      if (stopFails) throw new Error("fixture stop failure");
    }),
  ];
  try {
    const options = { mode: "full" as const, subagentProtocol: "native" as const, tunnelId: `tunnel_${"b".repeat(32)}`, restartService: true };
    expect((await setup(options)).tunnelReady).toBe(true);
    expect(calls).toEqual(["connect", "ready", "stop", "service", "ready"]);
    ready = false;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("did not become healthy and ready");
    expect(calls).toEqual(["connect", "ready", "stop"]);
    stopFails = true;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("fixture readiness; temporary tunnel cleanup also failed: fixture stop failure");
    expect(calls).toEqual(["connect", "ready", "stop"]);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
