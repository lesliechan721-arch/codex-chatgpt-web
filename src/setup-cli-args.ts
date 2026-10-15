import type { SetupOptions } from "./setup";

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

// Keep each command's consumption order and error text. DEV accepts fewer options.
export function parseProductionSetupArgs(arguments_: readonly string[]): {
  options: SetupOptions;
  acknowledged: boolean;
  preflightOnly: boolean;
} {
  const args = [...arguments_];
  const preflightOnly = takeFlag(args, "--preflight-only");
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if (browserOnly === full) throw new Error("Choose exactly one setup mode: --browser-only or --full");
  const portRaw = takeOption(args, "--port");
  const acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = {
    mode: full ? "full" : "browser-only",
    ...(portRaw ? { port: Number(portRaw) } : {}),
  };
  const automaticBrowserInteraction = takeFlag(args, "--automatic-browser-interaction");
  const manualBrowserInteraction = takeFlag(args, "--zero-risk-browser-interaction");
  if (automaticBrowserInteraction && manualBrowserInteraction) {
    throw new Error(
      "Choose at most one browser interaction mode: --automatic-browser-interaction or --zero-risk-browser-interaction",
    );
  }
  if (automaticBrowserInteraction || manualBrowserInteraction) {
    options.browserInteractionMode = manualBrowserInteraction ? "manual" : "automatic";
  }
  const toolAuthorityMode = takeOption(args, "--tool-authority-mode");
  if (toolAuthorityMode !== undefined) {
    if (toolAuthorityMode !== "verified-environment" && toolAuthorityMode !== "delegated") {
      throw new Error("--tool-authority-mode must be verified-environment or delegated");
    }
    options.toolAuthorityMode = toolAuthorityMode;
  }
  const connectorNameSuffix = takeOption(args, "--connector-name-suffix");
  if (connectorNameSuffix !== undefined) options.connectorNameSuffix = connectorNameSuffix;
  const subagentProtocol = takeOption(args, "--subagent-protocol");
  if (subagentProtocol !== undefined) {
    if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
      throw new Error("--subagent-protocol must be compatibility-v1 or native");
    }
    options.subagentProtocol = subagentProtocol;
  }
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const chrome = takeOption(args, "--chrome");
  const browserHostDescriptorPath = takeOption(args, "--browser-host-descriptor");
  if (chrome) options.chromeExecutablePath = chrome;
  if (browserHostDescriptorPath) options.browserHostDescriptorPath = browserHostDescriptorPath;
  options.refreshAccountCapabilities = takeFlag(args, "--refresh-account-capabilities");
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = runtimeKeyFile;
  options.forceLogin = takeFlag(args, "--login");
  options.autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  const predictions = takeFlag(args, "--composer-predictions");
  const noPredictions = takeFlag(args, "--no-composer-predictions");
  if (predictions && noPredictions) throw new Error("Choose --composer-predictions or --no-composer-predictions");
  const skillAttachments = takeFlag(args, "--skill-attachments");
  const inlineSkills = takeFlag(args, "--inline-skills");
  if (skillAttachments && inlineSkills) throw new Error("Choose --skill-attachments or --inline-skills");
  const savedChats = takeFlag(args, "--saved-chats");
  const temporaryChats = takeFlag(args, "--temporary-chats");
  if (savedChats && temporaryChats) throw new Error("Choose --saved-chats or --temporary-chats");
  if (savedChats || temporaryChats) options.useSavedChats = savedChats;
  const freshConversation = takeFlag(args, "--fresh-conversation");
  const retainedConversation = takeFlag(args, "--retained-conversation");
  if (freshConversation && retainedConversation) {
    throw new Error("Choose --fresh-conversation or --retained-conversation");
  }
  if (freshConversation || retainedConversation) options.experimentalFreshConversationPerTurn = freshConversation;
  const biggerContext = takeFlag(args, "--bigger-context");
  const standardContext = takeFlag(args, "--standard-context");
  if (biggerContext && standardContext) {
    throw new Error("Choose at most one context mode: --bigger-context or --standard-context");
  }
  if (biggerContext || standardContext) options.experimentalBiggerContext = biggerContext;
  if (predictions || noPredictions) options.composerPredictionsEnabled = predictions;
  if (skillAttachments || inlineSkills) options.experimentalSkillAttachments = skillAttachments;
  const zeroRiskPro = takeFlag(args, "--zero-risk-pro");
  const zeroRiskDefault = takeFlag(args, "--zero-risk-default");
  if (zeroRiskPro && zeroRiskDefault) {
    throw new Error("Choose at most one Zero Risk model profile: --zero-risk-pro or --zero-risk-default");
  }
  if (zeroRiskPro || zeroRiskDefault) options.zeroRiskProEnabled = zeroRiskPro;
  const zeroRiskSentConfirmation = takeFlag(args, "--zero-risk-sent-confirmation");
  const zeroRiskNoSentConfirmation = takeFlag(args, "--zero-risk-no-sent-confirmation");
  if (zeroRiskSentConfirmation && zeroRiskNoSentConfirmation) {
    throw new Error("Choose at most one Zero Risk Sent confirmation mode");
  }
  if (zeroRiskSentConfirmation || zeroRiskNoSentConfirmation) {
    options.zeroRiskRequireSentConfirmation = zeroRiskSentConfirmation;
  }
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.preserveDisconnectedRoute = takeFlag(args, "--preserve-disconnected-route");
  options.restartService = takeFlag(args, "--restart-service");
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);

  return { options, acknowledged, preflightOnly };
}

export function parseDevSetupArgs(
  arguments_: readonly string[],
  defaultDescriptorPath: string,
): SetupOptions {
  const args = [...arguments_];
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if (browserOnly === full) throw new Error("Choose exactly one DEV setup mode: --browser-only or --full");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const descriptorPath = takeOption(args, "--browser-host-descriptor") ?? defaultDescriptorPath;
  const connectorNameSuffix = takeOption(args, "--connector-name-suffix");
  const acknowledgedUnofficial = takeFlag(args, "--acknowledge-unofficial");
  const refreshAccountCapabilities = takeFlag(args, "--refresh-account-capabilities");
  const autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  const automaticBrowserInteraction = takeFlag(args, "--automatic-browser-interaction");
  const manualBrowserInteraction = takeFlag(args, "--zero-risk-browser-interaction");
  if (automaticBrowserInteraction && manualBrowserInteraction) {
    throw new Error("Choose at most one browser interaction mode");
  }
  const toolAuthorityMode = takeOption(args, "--tool-authority-mode");
  if (toolAuthorityMode !== undefined
    && toolAuthorityMode !== "verified-environment"
    && toolAuthorityMode !== "delegated") {
    throw new Error("--tool-authority-mode must be verified-environment or delegated");
  }
  const predictions = takeFlag(args, "--composer-predictions");
  const noPredictions = takeFlag(args, "--no-composer-predictions");
  if (predictions && noPredictions) throw new Error("Choose --composer-predictions or --no-composer-predictions");
  const skillAttachments = takeFlag(args, "--skill-attachments");
  const inlineSkills = takeFlag(args, "--inline-skills");
  if (skillAttachments && inlineSkills) throw new Error("Choose --skill-attachments or --inline-skills");
  const savedChats = takeFlag(args, "--saved-chats");
  const temporaryChats = takeFlag(args, "--temporary-chats");
  if (savedChats && temporaryChats) throw new Error("Choose --saved-chats or --temporary-chats");
  const freshConversation = takeFlag(args, "--fresh-conversation");
  const retainedConversation = takeFlag(args, "--retained-conversation");
  if (freshConversation && retainedConversation) {
    throw new Error("Choose --fresh-conversation or --retained-conversation");
  }
  const biggerContext = takeFlag(args, "--bigger-context");
  const standardContext = takeFlag(args, "--standard-context");
  const nativeToolLongWaitProbe = takeFlag(args, "--native-tool-long-wait-probe");
  if (biggerContext && standardContext) {
    throw new Error("Choose at most one context mode: --bigger-context or --standard-context");
  }
  if (args.length > 0) throw new Error(`Unknown DEV setup arguments: ${args.join(" ")}`);
  return {
    mode: full ? "full" : "browser-only",
    browserHostDescriptorPath: descriptorPath,
    ...(connectorNameSuffix !== undefined ? { connectorNameSuffix } : {}),
    refreshAccountCapabilities,
    autoApproveToolCalls,
    acknowledgedUnofficial,
    ...(automaticBrowserInteraction || manualBrowserInteraction
      ? { browserInteractionMode: manualBrowserInteraction ? "manual" : "automatic" }
      : {}),
    ...(toolAuthorityMode ? { toolAuthorityMode } : {}),
    ...(biggerContext || standardContext ? { experimentalBiggerContext: biggerContext } : {}),
    ...(predictions || noPredictions ? { composerPredictionsEnabled: predictions } : {}),
    ...(skillAttachments || inlineSkills ? { experimentalSkillAttachments: skillAttachments } : {}),
    ...(freshConversation || retainedConversation ? { experimentalFreshConversationPerTurn: freshConversation } : {}),
    ...(savedChats || temporaryChats ? { useSavedChats: savedChats } : {}),
    ...(tunnelId ? { tunnelId } : {}),
    ...(runtimeKeyFile ? { runtimeKeyFile } : {}),
    ...(nativeToolLongWaitProbe ? { devNativeToolLongWaitProbe: true } : {}),
  };
}
