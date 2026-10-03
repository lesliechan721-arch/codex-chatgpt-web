const assert = require("node:assert/strict");
const test = require("node:test");
const identity = require("../electron/connector-identity.cjs");

test("task_updates-v1 has distinct production, manual, and DEV ABI identities", () => {
  assert.equal(identity.CURRENT_CONNECTOR_NAME, "Codex Native4");
  assert.equal(identity.CURRENT_MANUAL_CONNECTOR_NAME, "Codex Zero Risk3");
  assert.equal(identity.DEV_CONNECTOR_NAME, "Codex Native4 DEV");
  assert.equal(identity.DEV_LONG_WAIT_CONNECTOR_NAME, "Codex Native4 DEV");
});

test("all retired identities migrate for setup and are rejected by live runtime verification", () => {
  for (const [oldName, newName] of [
    ["Codex Native", "Codex Native4"], ["Codex Native2", "Codex Native4"],
    ["Codex Native2 DEV", "Codex Native4 DEV"], ["Codex Native3", "Codex Native4"],
    ["Codex Native3 DEV", "Codex Native4 DEV"], ["Codex Zero Risk", "Codex Zero Risk3"],
    ["Codex Zero Risk2", "Codex Zero Risk3"],
  ]) {
    assert.equal(identity.connectorNameForSetup(oldName), newName);
    assert.equal(identity.isLegacyConnectorName(oldName), true);
    assert.throws(() => identity.requireCurrentRuntimeConnectorName(oldName), /do not rename or refresh/);
    assert.throws(() => identity.validateConnectorNameSuffix(oldName.slice(6)), /retired/);
    assert.equal(identity.connectorNameForDevSetup(oldName), oldName.startsWith("Codex Zero Risk")
      ? "Codex Zero Risk3" : "Codex Native4 DEV");
  }
});

test("custom nonlegacy configured names survive setup, DEV setup and runtime validation", () => {
  for (const name of ["Codex Work", "Codex Native3 - Work", "Codex Zero Risk2 - Work"]) {
    assert.equal(identity.connectorNameForSetup(name), name);
    assert.equal(identity.connectorNameForDevSetup(name), name);
    assert.equal(identity.requireCurrentRuntimeConnectorName(name), name);
  }
});
