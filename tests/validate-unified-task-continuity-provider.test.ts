import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, getContextCapabilityEvidencePath, providerConfig } from "../src/config";
import { installedContextCapabilitySchemaDigest,
  readProviderContextCapabilityEvidence, saveContextCapabilityEvidence, type ContextCapabilityReceipts } from "../src/adapters/chatgpt-web/context-capability-verification";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { contextTextReadReceipt } from "../src/adapters/chatgpt-web/context-text-result";
import { parseRequest } from "../src/responses/parser";
import { continuityDevProvider, prepareContinuityDevProvider, continuityDevProviderEvidence } from "../scripts/unified-task-continuity-dev-provider";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(mode: "automatic" | "manual" = "automatic") {
  const home = mkdtempSync(join(tmpdir(), "continuity-provider-profile-")); roots.push(home);
  const config = defaultConfig("full"); config.purpose = "dev-harness"; config.browserInteractionMode = mode; config.browserHost = "launcher";
  config.appName = mode === "manual" ? config.manualAppName : config.automaticAppName;
  config.browserHostDescriptorPath = join(home, "runtime", "launcher-browser.json");
  config.brokerSocketPath = defaultBrokerEndpoint(home); config.runtimeCommand = [process.execPath, resolve("src/cli.ts")];
  config.automaticTunnel = { binaryPath: "/fixture/tunnel-client", tunnelId: `tunnel_${"a".repeat(32)}`, runtimeKeyFile: "/fixture/runtime-key",
    profileDir: join(home, "automatic-tunnel"), profileName: "automatic", alias: "automatic" };
  config.manualTunnel = { ...config.automaticTunnel, tunnelId: `tunnel_${"b".repeat(32)}`, profileName: "manual", alias: "manual" };
  config.tunnel = mode === "manual" ? config.manualTunnel : config.automaticTunnel;
  const saveConfig = () => writeFileSync(join(home, "config.json"), JSON.stringify(config)); saveConfig();
  const paths = { home, runtimePath: join(home, "runtime", "dev-chat") };
  const privateRoot = mkdtempSync(join(tmpdir(), "continuity-provider-case-")); roots.push(privateRoot);
  const state = { continuityStateDirectory: join(privateRoot, "session-continuity"), lunaCheckpointStatePath: join(privateRoot, "luna.json"),
    browserHelperScriptPath: "/fixture/current-source-helper.js" };
  return { home, config, paths, privateRoot, state, saveConfig };
}

// Isolated local receipt fixtures use the production text transport and receipt validator.
// They are not copied to DEV and are not evidence of remote/cloud verification.
function receipts(): ContextCapabilityReceipts {
  const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: [
    { role: "user", content: "First inert fixture receipt source." },
    { role: "user", content: "Second inert fixture receipt source." },
  ] }));
  const read = (purpose: "normal" | "compaction") => contextTextReadReceipt(new ContextNavigator({ scopeId: "profile-receipt-fixture", snapshot, purpose })
    .read({ context_id: snapshot.context_id, reads: snapshot.targets.map(target => ({ read_ref: target.read_ref! })) }));
  return { ordinary: { list: true, search: true, read: true, text_read: read("normal") },
    compaction: { list: true, search: true, read: true, text_read: read("compaction") } };
}

async function verifiedFixture(mode: "automatic" | "manual" = "automatic") {
  const f = fixture(mode), schema = await installedContextCapabilitySchemaDigest(f.config);
  const proof = saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
  return { ...f, schema, proof };
}

for (const mode of ["automatic", "manual"] as const) test(`final ${mode} DEV provider reads the installed profile while preserving private journals`, async () => {
  const f = await verifiedFixture(mode), original = providerConfig(f.config);
  original.chatgptWeb!.threadEnvironmentStatePath = join(f.privateRoot, mode === "manual" ? "environments.json" : "thread-environments.json");
  expect(() => readProviderContextCapabilityEvidence(original, f.schema)).toThrow("supported runtime profile");
  const firstActivity = mock((provider: typeof original) => readProviderContextCapabilityEvidence(provider, f.schema));
  const prepared = await prepareContinuityDevProvider(original, f.paths, f.state);
  expect(firstActivity).not.toHaveBeenCalled();
  expect(firstActivity(prepared.provider)).toEqual(f.proof);
  expect(prepared.provider.chatgptWeb!.threadEnvironmentStatePath).toBe(join(f.paths.runtimePath, "thread-environments.json"));
  expect(original.chatgptWeb!.threadEnvironmentStatePath).toStartWith(f.privateRoot);
  expect(prepared.provider.chatgptWeb!.continuityStateDirectory).toBe(f.state.continuityStateDirectory);
  expect(prepared.provider.chatgptWeb!.lunaCheckpointStatePath).toBe(f.state.lunaCheckpointStatePath);
  expect(prepared.provider.chatgptWeb!.browserHelperScriptPath).toBe(f.state.browserHelperScriptPath);
  expect(prepared.capability.mode).toBe(mode);
  expect(prepared.capability.schemaDigest).toBe(f.schema);
  const secondCase = continuityDevProvider(original, f.paths, { continuityStateDirectory: join(f.privateRoot, "other-case") });
  expect(secondCase.chatgptWeb!.continuityStateDirectory).not.toBe(prepared.provider.chatgptWeb!.continuityStateDirectory);
  expect(secondCase.chatgptWeb!.threadEnvironmentStatePath).toBe(prepared.provider.chatgptWeb!.threadEnvironmentStatePath);
  expect(existsSync(f.state.continuityStateDirectory)).toBe(false);
  expect(existsSync(f.state.lunaCheckpointStatePath)).toBe(false);
  const evidence = continuityDevProviderEvidence(prepared), json = JSON.stringify(evidence);
  expect(evidence.checkedBeforeTurnAdmission).toBe(true);
  expect(evidence.staticSchemaChecked).toBe(true);
  expect(evidence).not.toHaveProperty("verified");
  expect(evidence).not.toHaveProperty("verifiedAt");
  expect(evidence.profile).toBe("development");
  for (const secret of [f.home, f.privateRoot, f.config.brokerSocketPath, f.config.tunnel!.tunnelId]) expect(json).not.toContain(secret);
});

test("read-only preflight uses the installed DEV provider without creating a task journal", async () => {
  const f = await verifiedFixture(), before = readFileSync(getContextCapabilityEvidencePath(f.home));
  const prepared = await prepareContinuityDevProvider(providerConfig(f.config), f.paths);
  expect(prepared.capability).toEqual(f.proof.binding);
  expect(prepared.provider.chatgptWeb!.continuityStateDirectory).toBe(join(f.paths.runtimePath, "session-continuity"));
  expect(existsSync(f.paths.runtimePath)).toBe(false);
  expect(before.equals(readFileSync(getContextCapabilityEvidencePath(f.home)))).toBe(true);
});

for (const mismatch of ["app", "mode", "socket", "local-tools"] as const) test(`mismatched actual provider ${mismatch} rejects before the first activity`, async () => {
  const f = await verifiedFixture(), original = providerConfig(f.config), firstActivity = mock(() => {});
  if (mismatch === "app") original.chatgptWeb!.appName = "Codex Fixture Different";
  if (mismatch === "mode") original.chatgptWeb!.browserInteractionMode = "manual";
  if (mismatch === "socket") original.chatgptWeb!.brokerSocketPath = defaultBrokerEndpoint(f.privateRoot);
  if (mismatch === "local-tools") original.chatgptWeb!.localToolsEnabled = false;
  await expect(prepareContinuityDevProvider(original, f.paths, f.state).then(firstActivity)).rejects.toThrow("does not match the active provider");
  expect(firstActivity).not.toHaveBeenCalled();
  expect(existsSync(f.state.continuityStateDirectory)).toBe(false);
});

for (const stale of ["missing", "schema", "tunnel", "text-receipt"] as const) test(`invalid installed ${stale} diagnostics do not block the first activity`, async () => {
  const f = await verifiedFixture(), firstActivity = mock(() => {});
  if (stale === "missing") rmSync(getContextCapabilityEvidencePath(f.home));
  if (stale === "schema") saveContextCapabilityEvidence(f.config, "0".repeat(64), receipts(), f.home);
  if (stale === "tunnel") { f.config.automaticTunnel!.tunnelId = `tunnel_${"c".repeat(32)}`; f.saveConfig(); }
  if (stale === "text-receipt") {
    const store = JSON.parse(readFileSync(getContextCapabilityEvidencePath(f.home), "utf8"));
    delete store.modes.automatic.receipts.compaction.text_read;
    writeFileSync(getContextCapabilityEvidencePath(f.home), JSON.stringify(store));
  }
  const prepared = await prepareContinuityDevProvider(providerConfig(f.config), f.paths, f.state);
  firstActivity();
  expect(firstActivity).toHaveBeenCalledTimes(1);
  expect(prepared.capability.profile).toBe("development");
  expect(prepared.capability.schemaDigest).toBe(f.schema);
  expect(existsSync(f.state.continuityStateDirectory)).toBe(false);
});

test("an arbitrary runtime cannot become an installed DEV profile or allocate a first activity", async () => {
  const f = await verifiedFixture(), firstActivity = mock(() => {});
  await expect(prepareContinuityDevProvider(providerConfig(f.config), { ...f.paths, runtimePath: f.privateRoot }, f.state).then(firstActivity))
    .rejects.toThrow("canonical installed DEV runtime");
  const arbitrary = continuityDevProvider(providerConfig(f.config), f.paths, f.state);
  arbitrary.chatgptWeb!.threadEnvironmentStatePath = join(f.home, "other", "thread-environments.json");
  expect(() => readProviderContextCapabilityEvidence(arbitrary, f.schema)).toThrow("supported runtime profile");
  expect(firstActivity).not.toHaveBeenCalled();
});
