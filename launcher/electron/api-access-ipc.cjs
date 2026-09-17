const { ERROR_CODES } = require("./api-access-settings.cjs");

/** Explicit per-method IPC; never expose ipcRenderer or general file/command/clipboard access. */
function registerApiAccessIpc({ ipcMain, controller, getWindow, rendererNavigationAllowed }) {
  const methods = {
    "launcher:api-access-status": () => controller.status(),
    "launcher:api-access-reveal": () => controller.reveal(),
    "launcher:api-access-generate": () => controller.generate(),
    "launcher:api-access-apply": input => controller.apply(input),
    "launcher:api-access-copy-key": key => controller.copyKey(key),
    "launcher:api-access-copy-url": () => controller.copyBaseUrl(),
    "launcher:api-access-export": () => controller.exportConfig(),
  };
  for (const [channel, method] of Object.entries(methods)) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      const contents = window && !window.isDestroyed() ? window.webContents : null;
      const frame = event.senderFrame;
      if (!contents || contents.isDestroyed() || event.sender !== contents
        || !frame || frame !== contents.mainFrame || !rendererNavigationAllowed(frame.url)) {
        return { ok: false, code: "untrusted-sender" };
      }
      // Exact arity and validation in the controller keep secrets out of exception messages.
      const arity = channel === "launcher:api-access-apply" || channel === "launcher:api-access-copy-key" ? 1 : 0;
      if (args.length !== arity) return { ok: false, code: "invalid-input" };
      try { return { ok: true, value: await method(...args) }; }
      catch (error) {
        // Do not send/log arbitrary errors from file IO or runtime helpers: they may contain secrets.
        return { ok: false, code: ERROR_CODES.has(error?.code) ? error.code : "unavailable" };
      }
    });
  }
  return () => {
    for (const channel of Object.keys(methods)) ipcMain.removeHandler(channel);
    controller.dispose();
  };
}

module.exports = { registerApiAccessIpc };
