import { expect, test } from "bun:test";
import { DEV_CHATGPT_CONNECTOR_NAME, DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../src/config";
import { assertDevChatConnector } from "../src/dev-chat/cli";

test("DEV chat accepts the current connector only in its selected interaction mode", () => {
  const check = (browserInteractionMode: "automatic" | "manual", appName: string) =>
    assertDevChatConnector({ mode: "full", browserInteractionMode, appName });
  expect(() => check("manual", ZERO_RISK_CHATGPT_CONNECTOR_NAME)).not.toThrow();
  for (const name of [DEV_CHATGPT_CONNECTOR_NAME, DEV_NATIVE_LONG_WAIT_CONNECTOR_NAME]) {
    expect(() => check("automatic", name)).not.toThrow();
    expect(() => check("manual", name)).toThrow("another interaction mode");
  }
  expect(() => check("automatic", ZERO_RISK_CHATGPT_CONNECTOR_NAME)).toThrow("another interaction mode");
  for (const mode of ["manual", "automatic"] as const) {
    for (const name of ["Codex Native3 DEV", "Codex Zero Risk2", "Codex Native4", "unknown"]) {
      expect(() => check(mode, name)).toThrow("DEV connector identity");
    }
    expect(() => assertDevChatConnector({ mode: "browser-only", browserInteractionMode: mode, appName: "unused" })).not.toThrow();
  }
});
