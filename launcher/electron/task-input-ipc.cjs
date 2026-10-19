const ACTIONS = new Set(["snapshot", "read", "copy", "repair", "retry", "discard", "cleanup", "delete-task"]);
const CODES = new Set(["task_update_invalid", "task_update_stale", "task_update_message_conflict", "task_update_not_executed",
  "continuity_context_missing", "continuity_resource_capacity", "continuity_configuration_conflict", "continuity_unverified", "unavailable"]);

/** Task bodies never enter the general IPC logger, command arguments, or environment. */
function registerTaskInputIpc({ ipcMain, runtimeHost, clipboard, getWindow, rendererNavigationAllowed, beforeAction }) {
  const channel = "launcher:task-input";
  ipcMain.handle(channel, async (event, ...args) => {
    const window = getWindow();
    const contents = window && !window.isDestroyed() ? window.webContents : null;
    const frame = event.senderFrame;
    if (!contents || contents.isDestroyed() || event.sender !== contents || !frame
      || frame !== contents.mainFrame || !rendererNavigationAllowed(frame.url)) return { ok: false, code: "untrusted-sender" };
    if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0])
      || !ACTIONS.has(args[0].action)) return { ok: false, code: "task_update_invalid" };
    try {
      // Limit input before serializing it into the helper pipe. Text can use six JSON bytes per character.
      if (Buffer.byteLength(JSON.stringify(args[0])) > 6 * 1024 * 1024 + 16 * 1024) return { ok: false, code: "task_update_invalid" };
      await beforeAction?.();
      const request = args[0];
      if (request.action === "copy" && (Object.keys(request).length !== 3
        || !Object.hasOwn(request, "identity") || !Object.hasOwn(request, "messageId"))) return { ok: false, code: "task_update_invalid" };
      const result = await runtimeHost.taskInputAction(request.action === "copy" ? { ...request, action: "read" } : request);
      if (result?.ok !== true) return { ok: false, code: CODES.has(result?.code) ? result.code : "unavailable",
        ...(result?.receiveStatus === "unknown" ? { receiveStatus: "unknown" } : {}) };
      if (request.action === "copy") {
        if (typeof result.value?.text !== "string") return { ok: false, code: "unavailable" };
        clipboard.writeText(result.value.text);
        return { ok: true, value: null };
      }
      return result;
    } catch {
      // Timeout is not proof of rollback. Keep drafts and refresh the same saved message identity.
      return { ok: false, code: "unavailable", receiveStatus: "unknown" };
    }
  });
  return () => ipcMain.removeHandler(channel);
}

module.exports = { registerTaskInputIpc };
