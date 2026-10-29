export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
const REMOVED_CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web-continuity/";
export type ChatGptConversationPolicy = "recoverable" | "task";
/** Shared automatic transport profile; exact browser version is carried by modelFamily. */
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
/** Internal Luna transport identity; the Free UI does not expose a selectable model version. */
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
/** Internal adapter identity for a turn whose ChatGPT model is selected by the user in the launcher. */
export const CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL = "chatgpt-web-zero-risk";
/** Internal adapter identity for the explicitly enabled, Pro-sized Zero Risk context profile. */
export const CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL = "chatgpt-web-zero-risk-pro";

export type ChatGptWebAutomaticBackendModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;
export type ChatGptWebBackendModel =
  | ChatGptWebAutomaticBackendModel
  | ChatGptWebZeroRiskBackendModel;
export type ChatGptWebZeroRiskBackendModel =
  | typeof CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
  | typeof CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGptWebModelFamily = "5.6" | "6";

/** Visible text accepted by one Plus browser message after the platform reserve. */
export const CHATGPT_WEB_INSTANT_MESSAGE_TOKEN_LIMIT = 32_807;
export const CHATGPT_WEB_MEDIUM_HIGH_MESSAGE_TOKEN_LIMIT = 81_807;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
// Rechecked on Plus with GPT-6 on 2026-10-08: 500,001 characters reached the
// model; 530,000 were rejected with message_length_exceeds_limit even at 67k
// tokens. Keep headroom below that independent server boundary.
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 500_000;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Reserve for each image in a browser message. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === "original" ? 8_192 : 4_096;
}
/** Separately measured visible one-message boundaries for a Pro account. */
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
/**
 * Preserve the manual profiles' original exclusive input ceilings after their platform reserve.
 * These are single-message limits. They do not describe canonical history or infer the UI model.
 */
export const CHATGPT_WEB_ZERO_RISK_MESSAGE_TOKEN_LIMIT = 114_807;
export const CHATGPT_WEB_ZERO_RISK_PRO_MESSAGE_TOKEN_LIMIT = 328_386;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
// Rechecked 2026-09-19: Pro-account Medium/High accept 500k characters but the server
// rejects larger messages with HTTP 413 (message_length_exceeds_limit), even below
// the token budget. Composer insertion itself still accepts them. Keep headroom;
// Instant and the Pro model have different bounds, not this reasoning-mode ceiling.
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/** Measured Free one-message budget, including the hidden ChatGPT platform reserve. */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

export function isChatGptWebZeroRiskBackendModel(
  model: string,
): model is ChatGptWebZeroRiskBackendModel {
  return model === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    || model === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
}

function assertChatGptWebBackendAvailable(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) {
    if (effort !== "low") throw new Error(`Zero Risk uses only its technical low effort: ${effort}`);
    if (capabilities.browserInteractionMode === "automatic") {
      throw new Error("Zero Risk is only available while manual interaction is enabled");
    }
    return;
  }
  if (capabilities.browserInteractionMode === "manual") {
    throw new Error("Automatic ChatGPT models are not available while Zero Risk is enabled");
  }
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) throw new Error("Luna is only available for Luna-only accounts");
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`Luna context limit is not defined for unavailable effort: ${effort}`);
    }
    return;
  }
  if (backendModel !== CHATGPT_WEB_BACKEND_MODEL) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${backendModel}`);
  }
  if (!capabilities.solAvailable) throw new Error("Sol is not available for this Luna-only account");
  if (effort === "low" || effort === "medium" || effort === "high"
    || (effort === "xhigh" && capabilities.extraHighAvailable)
    || (effort === "max" && capabilities.proAvailable)) return;
  throw new Error(`ChatGPT context limit is not defined for unavailable effort: ${effort}`);
}

function historyLimits(contextWindow: 200_000 | 300_000 | 500_000 | 600_000): ChatGptWebContextLimits {
  return {
    contextWindow,
    effectiveContextWindowPercent: 90,
    autoCompactTokenLimit: contextWindow * 0.9,
  };
}

/** Canonical history policy. Never use these values to admit one browser message or MCP read. */
export function resolveChatGptWebContextLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  modelFamily?: ChatGptWebModelFamily,
): ChatGptWebContextLimits {
  assertChatGptWebBackendAvailable(backendModel, effort, capabilities);
  if (modelFamily !== undefined && modelFamily !== "5.6" && modelFamily !== "6") {
    throw new Error(`ChatGPT web history policy is not defined for model family: ${modelFamily}`);
  }
  if (backendModel === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL) return historyLimits(300_000);
  if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) return historyLimits(600_000);
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return historyLimits(200_000);
  if (effort === "max") return historyLimits(600_000);
  if (modelFamily === "6") {
    if (effort === "low") return historyLimits(capabilities.proAvailable ? 300_000 : 200_000);
    return historyLimits(capabilities.proAvailable ? 500_000 : 300_000);
  }
  if (capabilities.proAvailable) return historyLimits(600_000);
  return historyLimits(effort === "low" ? 300_000 : 500_000);
}

/** Resolve separately measured text and character boundaries of one visible composer message. */
export function resolveChatGptWebTransportLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebTransportLimits {
  assertChatGptWebBackendAvailable(backendModel, effort, capabilities);
  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return { browserMessageTokenLimit: CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS };
  }
  if (!capabilities.proAvailable) {
    return { browserComposerCharLimit: effort === "low"
      ? CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT : CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

/** Visible text available in one message after the platform reserve and optional image reserve. */
export function resolveChatGptWebMessageTokenBudget(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  imageTokens = 0,
): number {
  assertChatGptWebBackendAvailable(backendModel, effort, capabilities);
  let tokenLimit: number;
  if (backendModel === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL) {
    tokenLimit = CHATGPT_WEB_ZERO_RISK_MESSAGE_TOKEN_LIMIT;
  } else if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) {
    tokenLimit = CHATGPT_WEB_ZERO_RISK_PRO_MESSAGE_TOKEN_LIMIT;
  } else if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    tokenLimit = CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS;
  } else if (capabilities.proAvailable) {
    tokenLimit = effort === "max" ? CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT : CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT;
  } else {
    tokenLimit = effort === "low" ? CHATGPT_WEB_INSTANT_MESSAGE_TOKEN_LIMIT : CHATGPT_WEB_MEDIUM_HIGH_MESSAGE_TOKEN_LIMIT;
  }
  return Math.max(0, tokenLimit - imageTokens);
}

interface ChatGptWebModelRouteBase {
  slug: string;
  /** Selected by the trusted route, never by request metadata or prompt content. */
  conversationPolicy?: ChatGptConversationPolicy;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresPro: boolean;
  requiresExtraHigh?: boolean;
  /** Old task identities remain resolvable, but are omitted from the picker. */
  legacy?: boolean;
  /** Omission denotes an immutable route, including all pre-6.0 task identities. */
  supportedCodexEfforts?: readonly ChatGptWebCodexEffort[];
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  /** Exact browser family, independent of the generic adapter's context/transport profile. */
  modelFamily?: ChatGptWebModelFamily;
}

export interface ChatGptWebZeroRiskModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "manual";
  backendModel: ChatGptWebZeroRiskBackendModel;
  /** Technical protocol value only; Zero Risk must not use it to choose the ChatGPT model. */
  adapterEffort: "low";
}

export type ChatGptWebModelRoute = ChatGptWebAutomaticModelRoute | ChatGptWebZeroRiskModelRoute;

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  /** Missing in older saved observations; setup must probe before exposing Extra High. */
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  browserInteractionMode?: "automatic" | "manual";
  zeroRiskProEnabled?: boolean;
  mode?: "browser-only" | "full";
  browserHost?: "managed-chrome" | "launcher";
  experimentalFreshConversationPerTurn?: boolean;
}

export const CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk",
  displayName: "ChatGPT Web — Zero Risk",
  description: "Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk-pro",
  displayName: "ChatGPT Web — Zero Risk Pro",
  description: "Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: true,
};

export const CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE: ChatGptWebModelRoute = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  // The backend model remains Luna. This internal adapter effort distinguishes the explicit
  // Think route after Codex has selected its separate catalog row.
  adapterEffort: "medium",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/gpt-5.6-luna",
  displayName: "Luna (Web)",
  description: "ChatGPT Luna. Light selects the ordinary mode; Medium enables Think.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  supportedCodexEfforts: ["low", "medium"],
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
];

/**
 * Preserve the exact pre-6.0 bindings for saved tasks, including the old unpinned Pro route.
 * Native Codex may normalize its technical effort; these identities have always owned the mode.
 */
export const CHATGPT_WEB_LEGACY_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
    requiresExtraHigh: true,
    legacy: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
    legacy: true,
  },
];

/** Group only efforts with identical context and compaction budgets. */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/gpt-6-sol-instant",
    displayName: "GPT-6 Sol Instant (Web)",
    description: "GPT-6 Sol Instant through ChatGPT, with history sized for the account.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-6-sol",
    displayName: "GPT-6 Sol (Web)",
    description: "GPT-6 Sol with Medium, High, or account-supported Extra High and history sized for the account.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol-instant",
    displayName: "GPT-5.6 Sol Instant (Web)",
    description: "GPT-5.6 Sol Instant through ChatGPT, with its own context and compaction budget.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Web)",
    description: "GPT-5.6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-pro",
    displayName: "GPT-5.6 Pro (Web)",
    description: "GPT-5.6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/gpt-6-pro",
    displayName: "GPT-6 Pro (Web)",
    description: "GPT-6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
];

const routesBySlug = new Map(
  [
    CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
    ...CHATGPT_WEB_MODEL_ROUTES,
    CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
    CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
    ...CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  ]
    .map(route => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX)
    || modelId.startsWith(REMOVED_CHATGPT_WEB_MODEL_PREFIX);
}

export function assertCurrentChatGptWebModelName(modelId: string): void {
  if (modelId.startsWith(REMOVED_CHATGPT_WEB_MODEL_PREFIX)) {
    throw new Error("The chatgpt-web-continuity/ model names were removed. Change your configured model to "
      + modelId.replace(REMOVED_CHATGPT_WEB_MODEL_PREFIX, CHATGPT_WEB_MODEL_PREFIX) + ". Existing task records are preserved.");
  }
}

export function chatGptWebTaskContinuityAvailable(capabilities: ChatGptWebAccountCapabilities): boolean {
  return capabilities.mode === "full" && capabilities.browserHost === "launcher";
}

function withTaskPolicy(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebModelRoute {
  return chatGptWebTaskContinuityAvailable(capabilities) && route.backendModel !== CHATGPT_WEB_LUNA_BACKEND_MODEL
    ? { ...route, conversationPolicy: "task" }
    : route;
}

/** Model catalog history policy, shared by all browser hosts and conversation policies. */
export function resolveChatGptWebHistoryLimits(
  route: Pick<ChatGptWebModelRoute, "backendModel" | "adapterEffort" | "conversationPolicy">
    & { modelFamily?: ChatGptWebModelFamily },
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebContextLimits {
  return resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, capabilities, route.modelFamily);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
  includeLegacy = false,
): readonly ChatGptWebModelRoute[] {
  if (capabilities.browserInteractionMode === "manual") {
    return (capabilities.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE]).map(route => withTaskPolicy(route, capabilities));
  }
  if (!capabilities.solAvailable) return includeLegacy
    ? [...CHATGPT_WEB_LUNA_MODEL_ROUTES, CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE, CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE]
    : CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const candidates = includeLegacy
    ? [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LEGACY_MODEL_ROUTES]
    : CHATGPT_WEB_MODEL_ROUTES;
  return candidates.filter(route =>
    (!route.requiresPro || capabilities.proAvailable)
    && (!route.requiresExtraHigh || capabilities.extraHighAvailable)).map(route => withTaskPolicy(route, capabilities));
}

export function chatGptWebRouteEfforts(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebCodexEffort[] {
  return (route.supportedCodexEfforts ?? [route.codexEffort])
    .filter(effort => effort !== "xhigh" || capabilities.extraHighAvailable === true);
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebModelRoute {
  assertCurrentChatGptWebModelName(modelId);
  const known = routesBySlug.get(modelId);
  if (!known) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  const route = withTaskPolicy(known, capabilities);
  if (capabilities.browserInteractionMode === "manual") {
    if (route.interactionMode !== "manual") {
      throw new Error(`${route.displayName} is not available while Zero Risk is enabled`);
    }
    const proRoute = route.backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
    if (proRoute && capabilities.zeroRiskProEnabled !== true) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }
  if (route.interactionMode === "manual") {
    throw new Error(`${route.displayName} is only available while Zero Risk is enabled`);
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return resolveRouteEffort(route, capabilities, reasoning);
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if ((route.requiresPro && !capabilities.proAvailable)
    || (route.requiresExtraHigh && !capabilities.extraHighAvailable)) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return resolveRouteEffort(route, capabilities, reasoning);
}

function resolveRouteEffort(
  route: ChatGptWebAutomaticModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebAutomaticModelRoute {
  if (!route.supportedCodexEfforts) return route;
  const effort = reasoning ?? route.codexEffort;
  if (!chatGptWebRouteEfforts(route, capabilities).includes(effort as ChatGptWebCodexEffort)) {
    throw new Error(`${route.displayName} does not support effort ${JSON.stringify(effort)} for this account`);
  }
  if (effort === route.codexEffort) return route;
  return { ...route, codexEffort: effort as ChatGptWebCodexEffort, adapterEffort: effort as ChatGptWebAdapterEffort };
}
