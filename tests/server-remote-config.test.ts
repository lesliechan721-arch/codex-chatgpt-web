import { expect, test } from "bun:test";
import {
  clientBaseUrl,
  clientCatalogPath,
  effectiveToolAuthorityMode,
  manualCodexConfigurationOnly,
  remoteTurnIdleTimeoutSec,
  responsesListenHost,
} from "../src/server-remote-config";

const apiKeyPolicy = { version: 1, mode: "api-key", keySha256: "a".repeat(64) } as const;
const openAiPolicy = { version: 1, mode: "openai" } as const;

test("remote listener requires both an explicit bind request and API-key access", () => {
  expect(responsesListenHost("127.0.0.1", apiKeyPolicy, {})).toBe("127.0.0.1");
  expect(responsesListenHost("127.0.0.1", apiKeyPolicy, {
    CODEX_CHATGPT_WEB_BIND_HOST: "0.0.0.0",
  })).toBe("0.0.0.0");
  expect(responsesListenHost("127.0.0.1", openAiPolicy, {
    CODEX_CHATGPT_WEB_BIND_HOST: "0.0.0.0",
  })).toBe("127.0.0.1");
  expect(() => responsesListenHost("127.0.0.1", apiKeyPolicy, {
    CODEX_CHATGPT_WEB_BIND_HOST: "192.0.2.10",
  })).toThrow("must be 127.0.0.1 or 0.0.0.0");
});

test("client Base URL defaults to host loopback and accepts only HTTPS remote /v1 URLs", () => {
  expect(clientBaseUrl(17841, {})).toEqual({
    baseUrl: "http://127.0.0.1:17841/v1",
    remote: false,
  });
  expect(clientBaseUrl(17841, {
    CODEX_CHATGPT_WEB_CLIENT_PORT: "27841",
  })).toEqual({
    baseUrl: "http://127.0.0.1:27841/v1",
    remote: false,
  });
  expect(clientBaseUrl(17841, {
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/service/v1/",
  })).toEqual({
    baseUrl: "https://server.example.com/service/v1",
    remote: true,
  });
  for (const value of [
    "http://server.example.com/v1",
    "https://user:pass@server.example.com/v1",
    "https://server.example.com/api",
    "https://server.example.com/v1?token=x",
  ]) {
    expect(() => clientBaseUrl(17841, { CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: value })).toThrow();
  }
  expect(() => clientBaseUrl(17841, { CODEX_CHATGPT_WEB_CLIENT_PORT: "0" })).toThrow();
});

test("remote client catalog and turn idle timeout are explicit deployment settings", () => {
  expect(clientCatalogPath("/server/catalog.json", false, {})).toBe("/server/catalog.json");
  expect(clientCatalogPath("/server/catalog.json", true, {})).toBe("~/.codex/api-key-models.json");
  expect(clientCatalogPath("/server/catalog.json", true, {
    CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH: "/home/client/catalog.json",
  })).toBe("/home/client/catalog.json");
  expect(remoteTurnIdleTimeoutSec({ CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC: "600" })).toBe(600);
  expect(remoteTurnIdleTimeoutSec({})).toBeUndefined();
  expect(remoteTurnIdleTimeoutSec({ CODEX_CHATGPT_WEB_REMOTE_TURN_TIMEOUT_SEC: "1800" })).toBeUndefined();
  expect(() => remoteTurnIdleTimeoutSec({ CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC: "0" })).toThrow();
  expect(() => remoteTurnIdleTimeoutSec({ CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC: "999999999" })).toThrow();
  expect(manualCodexConfigurationOnly({ CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1" })).toBe(true);
  expect(manualCodexConfigurationOnly({ CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "0" })).toBe(false);
});

test("tool authority defaults locally and a deployment override fails on persisted conflict", () => {
  expect(effectiveToolAuthorityMode(undefined, {})).toBe("verified-environment");
  expect(effectiveToolAuthorityMode("delegated", {})).toBe("delegated");
  expect(effectiveToolAuthorityMode(undefined, {
    CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: "delegated",
  })).toBe("delegated");
  expect(effectiveToolAuthorityMode(undefined, {
    CODEX_CHATGPT_WEB_BIND_HOST: "0.0.0.0",
  })).toBe("delegated");
  expect(() => effectiveToolAuthorityMode("verified-environment", {
    CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: "delegated",
  })).toThrow("conflicts with CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE=delegated");
  expect(() => effectiveToolAuthorityMode("verified-environment", {
    CODEX_CHATGPT_WEB_BIND_HOST: "0.0.0.0",
  })).toThrow("conflicts with CODEX_CHATGPT_WEB_BIND_HOST=0.0.0.0 (remote Responses bind)");
  expect(() => effectiveToolAuthorityMode(undefined, {
    CODEX_CHATGPT_WEB_BIND_HOST: "0.0.0.0",
    CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: "verified-environment",
  })).toThrow("requires delegated");
  expect(() => effectiveToolAuthorityMode(undefined, {
    CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: "unknown",
  })).toThrow("must be verified-environment or delegated");
});
