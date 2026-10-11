const CURRENT_CONNECTOR_NAME = "Codex Native5";
const DEV_CONNECTOR_NAME = `${CURRENT_CONNECTOR_NAME} DEV`;
const DEV_LONG_WAIT_CONNECTOR_NAME = DEV_CONNECTOR_NAME;
const CURRENT_MANUAL_CONNECTOR_NAME = "Codex Zero Risk4";
const LEGACY_CONNECTOR_NAMES = Object.freeze(["Codex Native", "Codex Native2", "Codex Native2 DEV", "Codex Native3", "Codex Native3 DEV", "Codex Native4", "Codex Native4 DEV"]);
const LEGACY_MANUAL_CONNECTOR_NAMES = Object.freeze(["Codex Zero Risk", "Codex Zero Risk2", "Codex Zero Risk3"]);
// This versions the Launcher setup check, not proof of ChatGPT's cached remote schema.
const MCP_SETUP_CONTRACT = "context-navigation-v1";

function connectorSetupStatePatch(config, state) {
  if (config?.mode !== "full") return { mcpSetupComplete: false, mcpGuideStep: 0 };
  if (isLegacyConnectorName(config.appName)
    || state.mcpSetupContract !== MCP_SETUP_CONTRACT
    || state.mcpSetupConnectorName !== config.appName) {
    return { mcpSetupComplete: false, mcpGuideStep: 2 };
  }
  return {};
}

function validateConnectorNameSuffix(value) {
  if (typeof value !== "string" || value.length > 74
    || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value)
    || value !== value.trim()) {
    throw new Error("The part after Codex must contain 1–74 letters, numbers, spaces, hyphens or underscores");
  }
  const fullName = `Codex ${value}`;
  if (LEGACY_CONNECTOR_NAMES.includes(fullName) || LEGACY_MANUAL_CONNECTOR_NAMES.includes(fullName)) {
    throw new Error(`${fullName} is retired; choose another plugin name`);
  }
  return value;
}

function validateConnectorName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("Connector name is invalid");
  }
  return value.trim();
}

function isLegacyConnectorName(value) {
  return LEGACY_CONNECTOR_NAMES.includes(value) || LEGACY_MANUAL_CONNECTOR_NAMES.includes(value);
}

function currentConnectorNameForLegacy(value) {
  if (LEGACY_MANUAL_CONNECTOR_NAMES.includes(value)) return CURRENT_MANUAL_CONNECTOR_NAME;
  return value.endsWith(" DEV") ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME;
}

function connectorNameForSetup(value) {
  const configured = validateConnectorName(value);
  return isLegacyConnectorName(configured)
    ? currentConnectorNameForLegacy(configured)
    : configured;
}

function connectorNameForDevSetup(value) {
  if (value === undefined || value === null) return DEV_CONNECTOR_NAME;
  const configured = validateConnectorName(value);
  if (LEGACY_MANUAL_CONNECTOR_NAMES.includes(configured)) return CURRENT_MANUAL_CONNECTOR_NAME;
  if (configured === CURRENT_CONNECTOR_NAME || LEGACY_CONNECTOR_NAMES.includes(configured)) {
    return DEV_CONNECTOR_NAME;
  }
  return configured;
}

function requireCurrentRuntimeConnectorName(value) {
  const configured = validateConnectorName(value);
  if (isLegacyConnectorName(configured)) {
    const current = currentConnectorNameForLegacy(configured);
    throw new Error(
      `The local runtime still targets legacy ChatGPT connector ${JSON.stringify(configured)}. Reconnect the harness`
      + ` so it targets ${JSON.stringify(current)}, then create that connector as a new ChatGPT plugin;`
      + ` do not rename or refresh the legacy connector.`,
    );
  }
  return configured;
}

module.exports = {
  connectorSetupStatePatch,
  connectorNameForSetup,
  connectorNameForDevSetup,
  CURRENT_CONNECTOR_NAME,
  CURRENT_MANUAL_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  DEV_LONG_WAIT_CONNECTOR_NAME,
  isLegacyConnectorName,
  LEGACY_CONNECTOR_NAMES,
  MCP_SETUP_CONTRACT,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
  validateConnectorNameSuffix,
};
