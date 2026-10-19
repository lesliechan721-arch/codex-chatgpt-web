const assert = require("node:assert/strict");
const test = require("node:test");
const identity = require("../electron/connector-identity.cjs");

test("context navigation has distinct production, manual, and DEV ABI identities", () => {
  assert.equal(identity.CURRENT_CONNECTOR_NAME, "Codex Native5");
  assert.equal(identity.CURRENT_MANUAL_CONNECTOR_NAME, "Codex Zero Risk4");
  assert.equal(identity.DEV_CONNECTOR_NAME, "Codex Native5 DEV");
  assert.equal(identity.DEV_LONG_WAIT_CONNECTOR_NAME, "Codex Native5 DEV");
});

test("all retired identities migrate for setup and are rejected by live runtime verification", () => {
  for (const [oldName, newName] of [
    ["Codex Native", "Codex Native5"], ["Codex Native2", "Codex Native5"],
    ["Codex Native2 DEV", "Codex Native5 DEV"], ["Codex Native3", "Codex Native5"],
    ["Codex Native3 DEV", "Codex Native5 DEV"], ["Codex Native4", "Codex Native5"],
    ["Codex Native4 DEV", "Codex Native5 DEV"], ["Codex Zero Risk", "Codex Zero Risk4"],
    ["Codex Zero Risk2", "Codex Zero Risk4"], ["Codex Zero Risk3", "Codex Zero Risk4"],
  ]) {
    assert.equal(identity.connectorNameForSetup(oldName), newName);
    assert.equal(identity.isLegacyConnectorName(oldName), true);
    assert.throws(() => identity.requireCurrentRuntimeConnectorName(oldName), /do not rename or refresh/);
    assert.throws(() => identity.validateConnectorNameSuffix(oldName.slice(6)), /retired/);
    assert.equal(identity.connectorNameForDevSetup(oldName), oldName.startsWith("Codex Zero Risk")
      ? "Codex Zero Risk4" : "Codex Native5 DEV");
  }
});

test("custom nonlegacy configured names survive setup, DEV setup and runtime validation", () => {
  for (const name of ["Codex Work", "Codex Native3 - Work", "Codex Zero Risk2 - Work", "Codex Native4 - Work", "Codex Zero Risk3 - Work"]) {
    assert.equal(identity.connectorNameForSetup(name), name);
    assert.equal(identity.connectorNameForDevSetup(name), name);
    assert.equal(identity.requireCurrentRuntimeConnectorName(name), name);
  }
});

test("DEV setup gives the current production default its separate DEV identity", () => {
  assert.equal(identity.connectorNameForDevSetup(identity.CURRENT_CONNECTOR_NAME), identity.DEV_CONNECTOR_NAME);
});

test("startup requires configuration migration for retired identities without changing config", () => {
  for (const appName of ["Codex Native4", "Codex Native4 DEV", "Codex Zero Risk3"]) {
    const config = { mode: "full", appName };
    const state = { mcpSetupComplete: true, mcpGuideStep: 0 };
    assert.deepEqual(identity.connectorSetupStatePatch(config, state), { mcpSetupComplete: false, mcpGuideStep: 2 });
    assert.equal(config.appName, appName);
    assert.equal(state.mcpSetupComplete, true);
  }
});

test("startup preserves completed configuration across setup-contract upgrades", () => {
  for (const appName of [identity.CURRENT_CONNECTOR_NAME, identity.DEV_CONNECTOR_NAME, identity.CURRENT_MANUAL_CONNECTOR_NAME, "Codex Work"]) {
    for (const mcpSetupContract of [undefined, "previous-ABI", identity.MCP_SETUP_CONTRACT]) {
      const config = { mode: "full", appName };
      const state = { mcpSetupComplete: true, mcpSetupContract, mcpGuideStep: 0 };
      assert.deepEqual(identity.connectorSetupStatePatch(config, state), {});
    }
  }
});

test("current setup checks survive restart only for the same exact identity", () => {
  const config = { mode: "full", appName: identity.CURRENT_CONNECTOR_NAME };
  const state = { mcpSetupComplete: true, mcpSetupContract: identity.MCP_SETUP_CONTRACT,
    mcpSetupConnectorName: config.appName };
  assert.deepEqual(identity.connectorSetupStatePatch(config, state), {});
  assert.deepEqual(identity.connectorSetupStatePatch({ ...config, appName: "Codex Other" }, state),
    { mcpSetupComplete: false, mcpGuideStep: 2 });
  assert.deepEqual(identity.connectorSetupStatePatch({ mode: "browser-only", appName: "Codex Native4" }, state),
    { mcpSetupComplete: false, mcpGuideStep: 0 });
});
