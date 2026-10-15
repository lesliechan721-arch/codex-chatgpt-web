import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightSetup, type SetupOptions } from "../src/setup";
import { parseDevSetupArgs, parseProductionSetupArgs } from "../src/setup-cli-args";

const devDescriptorPath = "/isolated-dev/launcher-browser.json";
const parsers = [
  { name: "production", parse: (args: readonly string[]) => parseProductionSetupArgs(args).options },
  { name: "DEV", parse: (args: readonly string[]) => parseDevSetupArgs(args, devDescriptorPath) },
] as const;

for (const { name, parse } of parsers) {
  for (const { flags, message } of [
    { flags: ["--app-name", "Other Connector"], message: `Unknown ${name === "DEV" ? "DEV setup " : ""}arguments: --app-name Other Connector` },
    { flags: ["--fresh-conversation", "--retained-conversation"], message: "Choose --fresh-conversation or --retained-conversation" },
    { flags: ["--composer-predictions", "--no-composer-predictions"], message: "Choose --composer-predictions or --no-composer-predictions" },
    { flags: ["--skill-attachments", "--inline-skills"], message: "Choose --skill-attachments or --inline-skills" },
    { flags: ["--saved-chats", "--temporary-chats"], message: "Choose --saved-chats or --temporary-chats" },
    { flags: ["--bigger-context", "--standard-context"], message: "Choose at most one context mode: --bigger-context or --standard-context" },
    { flags: ["--tool-authority-mode", "unsafe"], message: "--tool-authority-mode must be verified-environment or delegated" },
    { flags: ["--tool-authority-mode", "--acknowledge-unofficial"], message: "--tool-authority-mode requires a value" },
    { flags: ["--browser-only"], message: `Unknown ${name === "DEV" ? "DEV setup " : ""}arguments: --browser-only` },
  ]) {
    test(`${name} setup rejects ${flags.join(" ")} without a process`, () => {
      expect(() => parse(["--browser-only", ...flags])).toThrow(new Error(message));
    });
  }

  test(`${name} setup requires exactly one mode before checking other flags`, () => {
    const message = `Choose exactly one ${name === "DEV" ? "DEV " : ""}setup mode: --browser-only or --full`;
    expect(() => parse(["--tool-authority-mode", "unsafe"])).toThrow(new Error(message));
    expect(() => parse(["--browser-only", "--full", "--tool-authority-mode", "unsafe"])).toThrow(new Error(message));
  });

  test(`${name} setup keeps interaction conflict ahead of later argument errors`, () => {
    const message = "Choose at most one browser interaction mode"
      + (name === "production" ? ": --automatic-browser-interaction or --zero-risk-browser-interaction" : "");
    expect(() => parse([
      "--browser-only", "--automatic-browser-interaction", "--zero-risk-browser-interaction",
      "--tool-authority-mode", "unsafe", "--fresh-conversation", "--retained-conversation", "unknown",
    ])).toThrow(new Error(message));
  });

  test(`${name} setup preserves explicit opt-in and opt-out values`, () => {
    for (const { enabled, disabled, property } of [
      { enabled: "--fresh-conversation", disabled: "--retained-conversation", property: "experimentalFreshConversationPerTurn" },
      { enabled: "--composer-predictions", disabled: "--no-composer-predictions", property: "composerPredictionsEnabled" },
      { enabled: "--skill-attachments", disabled: "--inline-skills", property: "experimentalSkillAttachments" },
      { enabled: "--saved-chats", disabled: "--temporary-chats", property: "useSavedChats" },
      { enabled: "--bigger-context", disabled: "--standard-context", property: "experimentalBiggerContext" },
    ] as const) {
      expect(parse(["--browser-only", enabled])[property]).toBe(true);
      expect(parse(["--browser-only", disabled])[property]).toBe(false);
      expect(parse(["--browser-only"])[property]).toBeUndefined();
    }
    expect(parse(["--browser-only", "--automatic-browser-interaction"]).browserInteractionMode).toBe("automatic");
    expect(parse(["--full", "--zero-risk-browser-interaction"]).browserInteractionMode).toBe("manual");
    expect(parse(["--browser-only", "--tool-authority-mode", "verified-environment"]).toolAuthorityMode).toBe("verified-environment");
    expect(parse(["--browser-only", "--tool-authority-mode", "delegated"]).toolAuthorityMode).toBe("delegated");
  });
}

test("production setup preserves parsed options and leaves argv unchanged", () => {
  expect(parseProductionSetupArgs(["--browser-only"])).toEqual({
    preflightOnly: false,
    acknowledged: false,
    options: {
      mode: "browser-only", refreshAccountCapabilities: false, forceLogin: false, autoApproveToolCalls: false,
      replaceCodexRoute: false, preserveDisconnectedRoute: false, restartService: false,
    },
  });
  const args = [
    "--full", "--preflight-only", "--port", "0x10", "--acknowledge-unofficial",
    "--zero-risk-browser-interaction", "--tool-authority-mode", "delegated", "--connector-name-suffix", "Local",
    "--subagent-protocol", "native", "--tunnel-id", "tunnel", "--runtime-key-file", "key",
    "--chrome", "chrome", "--browser-host-descriptor", "descriptor", "--refresh-account-capabilities",
    "--login", "--auto-approve-tool-calls", "--skill-attachments", "--saved-chats", "--fresh-conversation",
    "--bigger-context", "--zero-risk-pro", "--zero-risk-no-sent-confirmation",
    "--replace-codex-route", "--preserve-disconnected-route", "--restart-service",
  ];
  const original = [...args];
  expect(parseProductionSetupArgs(args)).toEqual({
    preflightOnly: true,
    acknowledged: true,
    options: {
      mode: "full", port: 16, browserInteractionMode: "manual", toolAuthorityMode: "delegated",
      connectorNameSuffix: "Local", subagentProtocol: "native", tunnelId: "tunnel", runtimeKeyFile: "key",
      chromeExecutablePath: "chrome", browserHostDescriptorPath: "descriptor", refreshAccountCapabilities: true,
      forceLogin: true, autoApproveToolCalls: true, experimentalSkillAttachments: true, useSavedChats: true,
      experimentalFreshConversationPerTurn: true, experimentalBiggerContext: true, zeroRiskProEnabled: true,
      zeroRiskRequireSentConfirmation: false, replaceCodexRoute: true, preserveDisconnectedRoute: true,
      restartService: true,
    },
  });
  expect(args).toEqual(original);
});

test("production setup keeps profile conflicts and option errors in their original order", () => {
  expect(() => parseProductionSetupArgs([
    "--browser-only", "--zero-risk-pro", "--zero-risk-default", "--zero-risk-sent-confirmation", "--zero-risk-no-sent-confirmation",
  ])).toThrow(new Error("Choose at most one Zero Risk model profile: --zero-risk-pro or --zero-risk-default"));
  expect(() => parseProductionSetupArgs([
    "--browser-only", "--zero-risk-sent-confirmation", "--zero-risk-no-sent-confirmation",
  ])).toThrow(new Error("Choose at most one Zero Risk Sent confirmation mode"));
  expect(() => parseProductionSetupArgs([
    "--browser-only", "--port", "--automatic-browser-interaction", "--zero-risk-browser-interaction",
  ])).toThrow(new Error("--port requires a value"));
  expect(() => parseProductionSetupArgs(["--browser-only", "--subagent-protocol", "legacy"])).toThrow(
    new Error("--subagent-protocol must be compatibility-v1 or native"),
  );
  expect(parseProductionSetupArgs(["--full", "--zero-risk-default", "--zero-risk-sent-confirmation"]).options).toMatchObject({
    zeroRiskProEnabled: false, zeroRiskRequireSentConfirmation: true,
  });
});

test("DEV setup preserves its defaults, accepted options, and argv", () => {
  expect(parseDevSetupArgs(["--browser-only"], devDescriptorPath)).toEqual({
    mode: "browser-only", browserHostDescriptorPath: devDescriptorPath, acknowledgedUnofficial: false,
    refreshAccountCapabilities: false, autoApproveToolCalls: false,
  });
  const args = [
    "--full", "--tunnel-id", "tunnel", "--runtime-key-file", "key", "--browser-host-descriptor", "explicit-descriptor",
    "--connector-name-suffix", "Local", "--acknowledge-unofficial", "--refresh-account-capabilities",
    "--auto-approve-tool-calls", "--automatic-browser-interaction", "--tool-authority-mode", "delegated",
    "--skill-attachments", "--saved-chats", "--fresh-conversation", "--bigger-context", "--native-tool-long-wait-probe",
  ];
  const original = [...args];
  expect(parseDevSetupArgs(args, devDescriptorPath)).toEqual({
    mode: "full", tunnelId: "tunnel", runtimeKeyFile: "key", browserHostDescriptorPath: "explicit-descriptor",
    connectorNameSuffix: "Local", acknowledgedUnofficial: true, refreshAccountCapabilities: true,
    autoApproveToolCalls: true, browserInteractionMode: "automatic", toolAuthorityMode: "delegated",
    experimentalSkillAttachments: true, useSavedChats: true, experimentalFreshConversationPerTurn: true,
    experimentalBiggerContext: true, devNativeToolLongWaitProbe: true,
  });
  expect(args).toEqual(original);
});

test("DEV setup keeps unsupported production flags and early option errors", () => {
  expect(() => parseDevSetupArgs([
    "--browser-only", "--port", "17841", "--zero-risk-pro", "--subagent-protocol", "native",
  ], devDescriptorPath)).toThrow(new Error("Unknown DEV setup arguments: --port 17841 --zero-risk-pro --subagent-protocol native"));
  expect(() => parseDevSetupArgs([
    "--browser-only", "--tunnel-id", "--automatic-browser-interaction", "--zero-risk-browser-interaction",
  ], devDescriptorPath)).toThrow(new Error("--tunnel-id requires a value"));
});

function withIsolatedPreflight(callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codex-web-cli-parameter-preflight-"));
  const environment = {
    CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    CODEX_HOME: join(root, "codex"),
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: undefined,
    CODEX_CHATGPT_WEB_BIND_HOST: undefined,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    callback(root);
    expect(existsSync(join(root, "app", "config.json"))).toBe(false);
    expect(existsSync(join(root, "codex", "config.toml"))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// Port and manual restrictions belong to setup preflight, after CLI acknowledgement.
// Reuse that production boundary instead of changing its validation order in the parser.
test("setup preflight validates the port before browser runtime work", () => {
  withIsolatedPreflight(root => {
    const { options } = parseProductionSetupArgs([
      "--browser-only", "--chrome", process.execPath,
      "--browser-host-descriptor", join(root, "missing-launcher.json"), "--port", "0", "--acknowledge-unofficial",
    ]);
    expect(() => preflightSetup({ ...options, acknowledgedUnofficial: true })).toThrow(
      new Error("--port must be an integer from 1 to 65535"),
    );
  });
});

test("manual setup preflight rejects refresh and Bigger Context before requiring full mode", () => {
  withIsolatedPreflight(() => {
    for (const { flags, message } of [
      { flags: ["--refresh-account-capabilities"], message: "Zero Risk cannot refresh account capabilities" },
      { flags: ["--refresh-account-capabilities", "--bigger-context"], message: "Zero Risk cannot refresh account capabilities" },
      { flags: ["--bigger-context"], message: "Zero Risk does not support Bigger Context" },
      { flags: [], message: "Zero Risk requires --full so Codex Zero Risk3 can signal start, tools, and completion" },
    ]) {
      const options: SetupOptions = parseProductionSetupArgs([
        "--browser-only", "--zero-risk-browser-interaction", ...flags, "--acknowledge-unofficial",
      ]).options;
      expect(() => preflightSetup({ ...options, acknowledgedUnofficial: true })).toThrow(new Error(message));
    }
  });
});
