const { ipcMain, session } = require("electron");
const {
  applyNetworkProxyEnvironment,
  captureProxyEnvironment,
  electronProxyConfiguration,
  networkProxyAuthentication,
  normalizeNetworkProxyUrl,
  proxyAuthenticationMatches,
  PROXY_ENV_KEYS,
  restoreProxyEnvironment,
} = require("./network-proxy-config.cjs");
const { registerLoggedIpc, registerSensitiveProxyUrl } = require("./logging.cjs");

const NETWORK_PROXY_FATAL_MESSAGE = "Network proxy authentication could not be reset safely. Launcher must exit.";
const NETWORK_PROXY_APPLY_MESSAGE = "The network proxy could not be applied to the embedded browser.";
const NETWORK_PROXY_CONNECTION_MESSAGE = "Existing browser proxy connections could not be closed.";
const NETWORK_PROXY_RUNTIME_MESSAGE = "Managed runtimes could not restart after the network proxy changed.";
const NETWORK_PROXY_SAVE_MESSAGE = "The network proxy setting could not be saved.";
const NETWORK_PROXY_ROLLBACK_MESSAGE = "The previous network proxy could not be restored.";

class FatalNetworkProxyError extends Error {}

function runtimeRestartFailed(result) {
  return Boolean(result && result.status !== "ready" && result.status !== "not-configured");
}

function createNetworkProxyController({
  browserPartition,
  fatal = async () => {},
  getBrowserHost = () => null,
  getRuntimeHost = () => null,
  getRuntimeSupervisor = () => null,
  logger,
  publishState = () => {},
  stateStore,
  environment = process.env,
  ipc = ipcMain,
  sessionApi = session,
}) {
  if (typeof browserPartition !== "string" || !browserPartition) {
    throw new Error("Network proxy controller requires a browser partition");
  }
  if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.update !== "function") {
    throw new Error("Network proxy controller requires launcher state");
  }
  const inheritedEnvironment = captureProxyEnvironment(environment);
  const registerEnvironment = (snapshot) => {
    for (const key of PROXY_ENV_KEYS) registerSensitiveProxyUrl(snapshot?.[key]);
  };
  registerEnvironment(inheritedEnvironment);
  const browserSession = sessionApi.fromPartition(browserPartition);
  let activeAuthentication = null;

  const failClosed = async (environmentSnapshot) => {
    activeAuthentication = null;
    restoreProxyEnvironment(environment, environmentSnapshot);
    try {
      await fatal(NETWORK_PROXY_FATAL_MESSAGE);
    } catch {}
    throw new FatalNetworkProxyError(NETWORK_PROXY_FATAL_MESSAGE);
  };

  const clearAuthenticationCache = async (environmentSnapshot) => {
    try {
      await browserSession.clearAuthCache();
    } catch {
      await failClosed(environmentSnapshot);
    }
  };

  const applyElectronProxy = async (proxyUrl, environmentSnapshot) => {
    activeAuthentication = null;
    await clearAuthenticationCache(environmentSnapshot);
    try {
      await browserSession.setProxy(electronProxyConfiguration(proxyUrl));
    } catch {
      throw new Error(NETWORK_PROXY_APPLY_MESSAGE);
    }
    activeAuthentication = networkProxyAuthentication(proxyUrl);
    if (typeof browserSession.closeAllConnections === "function") {
      try {
        await browserSession.closeAllConnections();
      } catch {
        activeAuthentication = null;
        throw new Error(NETWORK_PROXY_CONNECTION_MESSAGE);
      }
    }
  };

  const restartManagedRuntime = async () => {
    const supervisor = getRuntimeSupervisor();
    if (!supervisor) return;
    try {
      const config = supervisor.readConfig();
      if (!config) return;
      const result = await supervisor.restart();
      if (runtimeRestartFailed(result)) throw new Error(NETWORK_PROXY_RUNTIME_MESSAGE);
    } catch {
      throw new Error(NETWORK_PROXY_RUNTIME_MESSAGE);
    }
  };

  const applyProxy = async (proxyUrl, restartRuntime, environmentSnapshot) => {
    activeAuthentication = null;
    applyNetworkProxyEnvironment(environment, inheritedEnvironment, proxyUrl);
    await applyElectronProxy(proxyUrl, environmentSnapshot);
    if (restartRuntime) await restartManagedRuntime();
  };

  const updateProxy = async (rawProxyUrl) => {
    registerSensitiveProxyUrl(rawProxyUrl);
    registerEnvironment(inheritedEnvironment);
    registerEnvironment(captureProxyEnvironment(environment));
    const nextProxyUrl = normalizeNetworkProxyUrl(rawProxyUrl);
    const current = stateStore.read();
    const previousProxyUrl = current.networkProxyUrl ?? null;
    registerSensitiveProxyUrl(previousProxyUrl);
    if (previousProxyUrl === nextProxyUrl) return current;

    const browserHost = getBrowserHost();
    const browserOperation = browserHost?.currentOperation?.();
    if (browserHost?.activeTraceId || browserOperation) {
      throw new Error(
        browserHost?.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing the network proxy"
          : `Finish ${browserOperation} before changing the network proxy`,
      );
    }

    const environmentSnapshot = captureProxyEnvironment(environment);
    let primaryError;
    let state;
    try {
      await applyProxy(nextProxyUrl, true, environmentSnapshot);
      try {
        state = stateStore.update({ networkProxyUrl: nextProxyUrl });
      } catch {
        throw new Error(NETWORK_PROXY_SAVE_MESSAGE);
      }
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      if (primaryError instanceof FatalNetworkProxyError) throw primaryError;
      try {
        await applyProxy(previousProxyUrl, true, environmentSnapshot);
      } catch (rollbackError) {
        activeAuthentication = null;
        if (rollbackError instanceof FatalNetworkProxyError) throw rollbackError;
        throw new Error(`${primaryError.message} ${NETWORK_PROXY_ROLLBACK_MESSAGE}`);
      }
      throw primaryError;
    }

    logger?.info?.("network.proxy_updated", { customProxy: nextProxyUrl !== null });
    publishState(state);
    return state;
  };

  const setProxy = async (rawProxyUrl) => {
    const runtimeHost = getRuntimeHost();
    if (!runtimeHost) return updateProxy(rawProxyUrl);
    if (typeof runtimeHost.runLifecycleOperation !== "function") {
      const activeOperation = runtimeHost.currentOperation?.();
      if (activeOperation) throw new Error(`Another launcher operation is active: ${activeOperation}`);
      return updateProxy(rawProxyUrl);
    }
    return runtimeHost.runLifecycleOperation(
      "network-proxy",
      () => updateProxy(rawProxyUrl),
    );
  };

  const applySaved = async () => {
    const savedProxyUrl = stateStore.read().networkProxyUrl ?? null;
    registerSensitiveProxyUrl(savedProxyUrl);
    registerEnvironment(inheritedEnvironment);
    registerEnvironment(captureProxyEnvironment(environment));
    const proxyUrl = normalizeNetworkProxyUrl(savedProxyUrl);
    const environmentSnapshot = captureProxyEnvironment(environment);
    await applyProxy(proxyUrl, false, environmentSnapshot);
    logger?.info?.("network.proxy_initialized", { customProxy: proxyUrl !== null });
    return proxyUrl;
  };

  const handleLogin = (event, webContents, authInfo, callback) => {
    if (!activeAuthentication
      || !webContents
      || webContents.session !== browserSession
      || !proxyAuthenticationMatches(activeAuthentication, authInfo)) return false;
    event.preventDefault();
    callback(activeAuthentication.username, activeAuthentication.password);
    return true;
  };

  registerLoggedIpc(
    ipc,
    logger,
    "launcher:network-proxy",
    (_event, proxyUrl) => setProxy(proxyUrl),
  );

  return { applySaved, handleLogin, setProxy };
}

module.exports = {
  NETWORK_PROXY_FATAL_MESSAGE,
  createNetworkProxyController,
};
