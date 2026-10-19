const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerTaskInputIpc } = require("../electron/task-input-ipc.cjs");
function harness() {
  let invoke; const copied = [], calls = [];
  const frame = { url: "file:///application/index.html" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const runtimeHost = { taskInputAction: async request => { calls.push(request); return { ok: true, value: { text: "private original" } }; } };
  registerTaskInputIpc({ ipcMain: { handle: (_, fn) => { invoke = fn; } }, runtimeHost,
    clipboard: { writeText: text => copied.push(text) }, getWindow: () => ({ isDestroyed: () => false, webContents: contents }),
    rendererNavigationAllowed: url => url === frame.url });
  return { invoke: (...args) => invoke(...args), event: { sender: contents, senderFrame: frame }, runtimeHost, calls, copied };
}
test("task body control rejects untrusted frames before any helper or clipboard access", async () => {
  const h = harness();
  assert.deepEqual(await h.invoke({ ...h.event, senderFrame: { url: h.event.senderFrame.url } }, { action: "snapshot" }), { ok: false, code: "untrusted-sender" });
  assert.equal(h.calls.length, 0);
});
test("copy uses only the saved original; missing and uncertain reads never touch the clipboard", async () => {
  const h = harness(); const request = { action: "copy", identity: {}, messageId: "A" };
  assert.deepEqual(await h.invoke(h.event, request), { ok: true, value: null });
  assert.deepEqual(h.calls, [{ ...request, action: "read" }]);
  assert.deepEqual(h.copied, ["private original"]);
  h.runtimeHost.taskInputAction = async () => ({ ok: false, code: "continuity_context_missing" });
  assert.deepEqual(await h.invoke(h.event, request), { ok: false, code: "continuity_context_missing" });
  h.runtimeHost.taskInputAction = async () => { throw new Error("private original secret path"); };
  assert.deepEqual(await h.invoke(h.event, request), { ok: false, code: "unavailable", receiveStatus: "unknown" });
  assert.equal(h.copied.length, 1);
});
