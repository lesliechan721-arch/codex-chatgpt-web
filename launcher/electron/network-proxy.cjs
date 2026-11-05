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
const NETWORK_PROXY_BUSY_MESSAGE = "Finish active API, browser, or retained tasks before changing the network proxy. Managed runtime idleness could not be confirmed.";
const NETWORK_PROXY_SAVE_MESSAGE = "The network proxy setting could not be saved.";
const NETWORK_PROXY_ROLLBACK_MESSAGE = "The previous network proxy could not be restored.";

class FatalNetworkProxyError extends Error {}

function runtimeRestartFailed(result) {
  return !result || (result.status !== "ready" && result.status !== "not-configured");
}

function createNetworkProxyController({
  browserPartition,
  beforeMutation,
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

  const startManagedRuntime = async (supervisor) => {
    if (!supervisor) return;
    try {
      const result = await supervisor.startIfConfigured();
      if (runtimeRestartFailed(result)) throw new Error(NETWORK_PROXY_RUNTIME_MESSAGE);
    } catch {
      throw new Error(NETWORK_PROXY_RUNTIME_MESSAGE);
    }
  };

  const stopManagedRuntime = async (supervisor) => {
    if (!supervisor) return;
    try {
      const result = await supervisor.stopForAccountSwitch();
      if (result?.status !== "stopped") throw new Error(NETWORK_PROXY_BUSY_MESSAGE);
    } catch {
      throw new Error(NETWORK_PROXY_BUSY_MESSAGE);
    }
  };

  const applyProxy = async (proxyUrl, environmentSnapshot) => {
    activeAuthentication = null;
    applyNetworkProxyEnvironment(environment, inheritedEnvironment, proxyUrl);
    await applyElectronProxy(proxyUrl, environmentSnapshot);
  };

  const updateProxy = async (rawProxyUrl) => {
    if (beforeMutation) await beforeMutation();
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

    const supervisor = getRuntimeSupervisor();
    const admissionWasClosed = browserHost?.accountAdmissionClosed === true;
    let admissionCanResume = true;
    try {
      browserHost?.closeAccountAdmission?.();
      // The daemon drain closes API admission atomically. Keep every network
      // setting and existing connection intact until that drain proves idle.
      await stopManagedRuntime(supervisor);
      const environmentSnapshot = captureProxyEnvironment(environment);
      admissionCanResume = false;
      let primaryError;
      let state;
      let runtimeStartAttempted = false;
      try {
        await applyProxy(nextProxyUrl, environmentSnapshot);
        runtimeStartAttempted = true;
        await startManagedRuntime(supervisor);
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
          // A failed save can follow a successful new runtime start. Prove that
          // runtime idle too before restoring the old route and credentials.
          if (runtimeStartAttempted) await stopManagedRuntime(supervisor);
          await applyProxy(previousProxyUrl, environmentSnapshot);
          await startManagedRuntime(supervisor);
          admissionCanResume = true;
        } catch (rollbackError) {
          activeAuthentication = null;
          if (rollbackError instanceof FatalNetworkProxyError) throw rollbackError;
          throw new Error(`${primaryError.message} ${NETWORK_PROXY_ROLLBACK_MESSAGE}`);
        }
        throw primaryError;
      }

      admissionCanResume = true;
      logger?.info?.("network.proxy_updated", { customProxy: nextProxyUrl !== null });
      publishState(state);
      return state;
    } finally {
      if (!admissionWasClosed && admissionCanResume) browserHost?.resumeAccountAdmission?.();
    }
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
    await applyProxy(proxyUrl, environmentSnapshot);
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

  const restoreLaunchEnvironment = async () => {
    activeAuthentication = null;
    restoreProxyEnvironment(environment, inheritedEnvironment);
    await clearAuthenticationCache(inheritedEnvironment);
    if (typeof browserSession.closeAllConnections === "function") {
      try {
        await browserSession.closeAllConnections();
      } catch {
        throw new Error(NETWORK_PROXY_CONNECTION_MESSAGE);
      }
    }
  };

  registerLoggedIpc(
    ipc,
    logger,
    "launcher:network-proxy",
    (_event, proxyUrl) => setProxy(proxyUrl),
  );

  return { applySaved, handleLogin, restoreLaunchEnvironment, setProxy };
}

module.exports = {
  NETWORK_PROXY_FATAL_MESSAGE,
  createNetworkProxyController,
};
