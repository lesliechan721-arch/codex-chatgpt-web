const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerApiAccessIpc } = require("../electron/api-access-ipc.cjs");

function harness() {
  const calls = []; const handlers = new Map();
  const frame = { url: "file:///application/index.html" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const controller = Object.fromEntries(["status", "reveal", "generate", "apply", "copyKey", "copyBaseUrl", "exportConfig", "dispose"]
    .map(name => [name, (...args) => { calls.push([name, ...args]); return "safe-value"; }]));
  const dispose = registerApiAccessIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    controller, getWindow: () => window, rendererNavigationAllowed: url => url === frame.url });
  return { handlers, calls, controller, dispose, frame, event: { sender: contents, senderFrame: frame } };
}

test("privileged calls require exact trusted main frame, not ChatGPT or a subframe", async () => {
  const h = harness(); const invoke = h.handlers.get("launcher:api-access-generate");
  for (const event of [{ sender: {}, senderFrame: h.frame }, { ...h.event, senderFrame: { url: h.frame.url } }, { ...h.event, senderFrame: null }]) {
    assert.deepEqual(await invoke(event), { ok: false, code: "untrusted-sender" });
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await invoke(h.event), { ok: true, value: "safe-value" });
});
test("extra IPC arguments are rejected", async () => {
  const h = harness();
  assert.deepEqual(await h.handlers.get("launcher:api-access-status")(h.event, "secret"), { ok: false, code: "invalid-input" });
  assert.equal(h.calls.length, 0);
});
test("unexpected errors are sanitized without returning private error text", async () => {
  const h = harness(); h.controller.apply = () => { throw new Error("SECRET_KEY private disk path"); };
  const result = await h.handlers.get("launcher:api-access-apply")(h.event, {});
  assert.deepEqual(result, { ok: false, code: "unavailable" });
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});
test("known codes survive and no arbitrary error code is reflected", async () => {
  const h = harness();
  h.controller.apply = () => { throw { code: "stale-settings", message: "secret" }; };
  assert.deepEqual(await h.handlers.get("launcher:api-access-apply")(h.event, {}), { ok: false, code: "stale-settings" });
  h.controller.apply = () => { throw { code: "secret-as-code" }; };
  assert.deepEqual(await h.handlers.get("launcher:api-access-apply")(h.event, {}), { ok: false, code: "unavailable" });
});
test("dispose unregisters every method and clears owned clipboard", () => {
  const h = harness(); assert.equal(h.handlers.size, 7); h.dispose();
  assert.equal(h.handlers.size, 0); assert.deepEqual(h.calls, [["dispose"]]);
});

test("reveal is available only to the trusted renderer with no arguments", async () => {
  const h = harness(); const reveal = h.handlers.get("launcher:api-access-reveal");
  assert.deepEqual(await reveal({ sender: {}, senderFrame: h.frame }), { ok: false, code: "untrusted-sender" });
  assert.deepEqual(await reveal(h.event, "unused"), { ok: false, code: "invalid-input" });
  assert.deepEqual(await reveal(h.event), { ok: true, value: "safe-value" });
  assert.deepEqual(h.calls, [["reveal"]]);
});
