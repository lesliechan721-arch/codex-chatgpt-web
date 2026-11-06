const languages = require("./languages.json");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { normalizeNetworkProxyUrl } = require("./network-proxy-config.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
const SHARED_STATE_KEYS = new Set([
  "language", "onboardingComplete", "githubOpened", "xOpened", "autoStart",
  "keepRunningOnClose", "showBrowserDuringTurns", "sidebarOpen", "sidebarWidth",
]);

const DEFAULT_STATE = Object.freeze({
  version: 1,
  language: null,
  onboardingComplete: false,
  githubOpened: false,
  xOpened: false,
  autoStart: true,
  keepRunningOnClose: true,
  showBrowserDuringTurns: true,
  autoApproveToolCalls: false,
  browserInteractionMode: "automatic",
  toolAuthorityMode: "verified-environment",
  composerPredictionsEnabled: true,
  experimentalSkillAttachments: false,
  experimentalFreshConversationPerTurn: false,
  useTemporaryChats: true,
  zeroRiskProEnabled: false,
  zeroRiskRequireSentConfirmation: true,
  networkProxyUrl: null,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  sessionRefreshReminderAt: null,
});

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readStateData(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && !Array.isArray(parsed) && parsed.version === 1 ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeState(parsed) {
    const state = { ...DEFAULT_STATE, ...parsed };
    delete state.bridgeEnabled;
    delete state.experimentalBiggerContext;
    delete state.biggerContextAvailable;
    delete state.useSavedChats;
    if (state.language !== null && (typeof state.language !== "string" || !Object.hasOwn(languages, state.language))) {
      state.language = DEFAULT_STATE.language;
    }
    for (const key of [
      "onboardingComplete",
      "githubOpened",
      "xOpened",
      "autoStart",
      "keepRunningOnClose",
      "showBrowserDuringTurns",
      "autoApproveToolCalls",
      "composerPredictionsEnabled",
      "experimentalSkillAttachments",
      "experimentalFreshConversationPerTurn",
      "useTemporaryChats",
      "zeroRiskProEnabled",
      "zeroRiskRequireSentConfirmation",
      "browserSmokePassed",
      "sidebarOpen",
    ]) {
      if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
    }
    if (state.browserInteractionMode !== "automatic" && state.browserInteractionMode !== "manual") {
      state.browserInteractionMode = DEFAULT_STATE.browserInteractionMode;
    }
    if (state.toolAuthorityMode !== "verified-environment" && state.toolAuthorityMode !== "delegated") {
      state.toolAuthorityMode = DEFAULT_STATE.toolAuthorityMode;
    }
    if (state.coreSetupComplete !== true) {
      if (state.onboardingComplete !== true) state.browserInteractionMode = "automatic";
      state.zeroRiskProEnabled = false;
    }
    try {
      state.networkProxyUrl = normalizeNetworkProxyUrl(state.networkProxyUrl);
    } catch {
      state.networkProxyUrl = DEFAULT_STATE.networkProxyUrl;
    }
    if (state.browserSmokeVersion !== null
      && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
      state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
    }
    if (!Number.isFinite(state.sidebarWidth)
      || state.sidebarWidth < SIDEBAR_MIN_WIDTH
      || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
      state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
    }
    if (!Number.isInteger(state.mcpGuideStep) || state.mcpGuideStep < 0 || state.mcpGuideStep > 2) {
      state.mcpGuideStep = DEFAULT_STATE.mcpGuideStep;
    }
    if (state.sessionRefreshReminderAt !== null
      && (typeof state.sessionRefreshReminderAt !== "string"
        || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
      state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
    }
    for (const key of [
      "coreSetupComplete",
      "codexCatalogVerified",
      "mcpSetupComplete",
      "mcpRuntimeInstalled",
      "codexRestartRequired",
    ]) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
    }
    return state;
}

function readState(filePath) {
  return normalizeState(readStateData(filePath));
}

function writeState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath) {
  let state = readState(filePath);
  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      delete next.experimentalBiggerContext;
      delete next.biggerContextAvailable;
      delete next.useSavedChats;
      writeState(filePath, next);
      state = next;
      return structuredClone(next);
    },
  };
}

function splitState(state, shared) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key === "version" || SHARED_STATE_KEYS.has(key) === shared));
}

function assertStatePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Account state path must remain inside launcher userData");
  }
  let current = root;
  for (const component of ["", ...relative.split(path.sep)]) {
    if (component) current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Launcher state path must not use symbolic links");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function createAccountStateStore({ sharedPath, accountPath, migrateLegacy = false }) {
  if (typeof sharedPath !== "string" || !path.isAbsolute(sharedPath)
    || (accountPath !== null && (typeof accountPath !== "string" || !path.isAbsolute(accountPath)))) {
    throw new Error("Account state requires absolute storage paths");
  }
  const root = path.dirname(sharedPath);
  const validatePaths = () => {
    assertStatePath(root, sharedPath);
    if (accountPath !== null) assertStatePath(root, accountPath);
    if (accountPath === sharedPath) throw new Error("Shared and account state must use separate files");
  };
  validatePaths();
  const shared = readState(sharedPath);
  if (accountPath !== null && !fs.existsSync(accountPath)) {
    writeState(accountPath, splitState(migrateLegacy ? shared : { ...DEFAULT_STATE }, false));
  }
  // Copy the legacy account settings before removing them from the shared file.
  writeState(sharedPath, splitState(shared, true));
  const read = () => {
    validatePaths();
    return normalizeState({
      ...(accountPath === null ? {} : splitState(readStateData(accountPath), false)),
      ...splitState(readState(sharedPath), true),
      version: 1,
    });
  };
  return {
    read() { return structuredClone(read()); },
    update(patch) {
      validatePaths();
      if (accountPath === null && Object.keys(patch).some(key => key !== "version" && !SHARED_STATE_KEYS.has(key))) {
        throw new Error("No account is selected for account settings");
      }
      const next = { ...read(), ...patch, version: 1 };
      delete next.experimentalBiggerContext;
      delete next.biggerContextAvailable;
      delete next.useSavedChats;
      if (accountPath !== null) writeState(accountPath, splitState(next, false));
      writeState(sharedPath, splitState(next, true));
      return structuredClone(next);
    },
  };
}

module.exports = {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createAccountStateStore,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
};
