const CURRENT_CONNECTOR_NAME = "Codex Native3";
const DEV_CONNECTOR_NAME = `${CURRENT_CONNECTOR_NAME} DEV`;
const DEV_LONG_WAIT_CONNECTOR_NAME = "Codex Native3 DEV";
const LEGACY_CONNECTOR_NAMES = Object.freeze(["Codex Native", "Codex Native2", "Codex Native2 DEV"]);

function validateConnectorName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("Connector name is invalid");
  }
  return value.trim();
}

function isLegacyConnectorName(value) {
  return LEGACY_CONNECTOR_NAMES.includes(value);
}

function connectorNameForSetup(value) {
  const configured = validateConnectorName(value);
  return isLegacyConnectorName(configured)
    ? configured.endsWith(" DEV") ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME
    : configured;
}

function connectorNameForDevSetup(value) {
  if (value === undefined || value === null) return DEV_CONNECTOR_NAME;
  const configured = validateConnectorName(value);
  if (configured === CURRENT_CONNECTOR_NAME || isLegacyConnectorName(configured)) {
    return DEV_CONNECTOR_NAME;
  }
  return configured;
}

function requireCurrentRuntimeConnectorName(value) {
  const configured = validateConnectorName(value);
  if (isLegacyConnectorName(configured)) {
    const current = configured.endsWith(" DEV") ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME;
    throw new Error(
      `The local runtime still targets legacy ChatGPT connector ${JSON.stringify(configured)}. Reconnect the harness`
      + ` so it targets ${JSON.stringify(current)}, then create that connector as a new ChatGPT plugin;`
      + ` do not rename or refresh the legacy connector.`,
    );
  }
  return configured;
}

module.exports = {
  connectorNameForSetup,
  connectorNameForDevSetup,
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  DEV_LONG_WAIT_CONNECTOR_NAME,
  isLegacyConnectorName,
  LEGACY_CONNECTOR_NAMES,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
};
