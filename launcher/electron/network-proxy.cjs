const { ipcMain, session } = require("electron");
const {
  applyNetworkProxyEnvironment,
  captureProxyEnvironment,
  electronProxyConfiguration,
  normalizeNetworkProxyUrl,
} = require("./network-proxy-config.cjs");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeRestartError(result) {
  if (!result || result.status === "ready" || result.status === "not-configured") return null;
  return result.detail
    ? `Launcher runtime did not restart cleanly: ${result.detail}`
    : `Launcher runtime did not restart cleanly (${String(result.status)})`;
}

function createNetworkProxyController({
  browserPartition,
  getBrowserHost = () => null,
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

  const applyElectronProxy = async (proxyUrl) => {
    const browserSession = sessionApi.fromPartition(browserPartition);
    await browserSession.setProxy(electronProxyConfiguration(proxyUrl));
    if (typeof browserSession.closeAllConnections === "function") {
      await browserSession.closeAllConnections();
    }
  };

  const applyProxy = async (proxyUrl, restartRuntime) => {
    applyNetworkProxyEnvironment(environment, inheritedEnvironment, proxyUrl);
    await applyElectronProxy(proxyUrl);
    if (!restartRuntime) return;
    const supervisor = getRuntimeSupervisor();
    if (!supervisor) return;
    const config = supervisor.readConfig();
    if (!config) return;
    const result = await supervisor.restart();
    const restartError = runtimeRestartError(result);
    if (restartError) throw new Error(restartError);
  };

  const setProxy = async (rawProxyUrl) => {
    const nextProxyUrl = normalizeNetworkProxyUrl(rawProxyUrl);
    const current = stateStore.read();
    const previousProxyUrl = current.networkProxyUrl ?? null;
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

    let primaryError;
    try {
      await applyProxy(nextProxyUrl, true);
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      let rollbackError;
      try {
        await applyProxy(previousProxyUrl, true);
      } catch (error) {
        rollbackError = error;
      }
      const message = rollbackError
        ? `${errorMessage(primaryError)}; restoring the previous proxy also failed: ${errorMessage(rollbackError)}`
        : errorMessage(primaryError);
      throw new Error(message);
    }

    const state = stateStore.update({ networkProxyUrl: nextProxyUrl });
    logger?.info?.("network.proxy_updated", { customProxy: nextProxyUrl !== null });
    publishState(state);
    return state;
  };

  const applySaved = async () => {
    const proxyUrl = normalizeNetworkProxyUrl(stateStore.read().networkProxyUrl ?? null);
    await applyProxy(proxyUrl, false);
    logger?.info?.("network.proxy_initialized", { customProxy: proxyUrl !== null });
    return proxyUrl;
  };

  ipc.handle("launcher:network-proxy", (_event, proxyUrl) => setProxy(proxyUrl));

  return {
    applySaved,
    setProxy,
  };
}

module.exports = {
  createNetworkProxyController,
  runtimeRestartError,
};
