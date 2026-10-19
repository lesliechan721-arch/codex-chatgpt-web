import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CodexProviderConfig } from "../src/types";
import type { DevProfilePaths } from "../src/dev-chat/profile";
import { contextCapabilityBinding, installedContextCapabilitySchemaDigest } from "../src/adapters/chatgpt-web/context-capability-verification";
import { loadConfigFromPath, providerConfig } from "../src/config";

type DevRuntimePaths = Pick<DevProfilePaths, "home" | "runtimePath">;
interface PrivateState {
  continuityStateDirectory?: string;
  lunaCheckpointStatePath?: string;
  browserHelperScriptPath?: string;
}

/** Keep case journals private while retaining the actual installed DEV identity. */
export function continuityDevProvider(original: CodexProviderConfig, paths: DevRuntimePaths, state: PrivateState = {}): CodexProviderConfig {
  if (original.adapter !== "chatgpt-web" || !original.chatgptWeb) throw new Error("Continuity acceptance requires the ChatGPT Web provider");
  if (resolve(paths.runtimePath) !== resolve(join(paths.home, "runtime", "dev-chat"))) {
    throw new Error("Continuity acceptance requires the canonical installed DEV runtime");
  }
  return { ...original, chatgptWeb: { ...original.chatgptWeb,
    ...(state.browserHelperScriptPath ? { browserHelperScriptPath: state.browserHelperScriptPath } : {}),
    continuityStateDirectory: state.continuityStateDirectory ?? join(paths.runtimePath, "session-continuity"),
    lunaCheckpointStatePath: state.lunaCheckpointStatePath ?? join(paths.runtimePath, "luna-checkpoints.json"),
    threadEnvironmentStatePath: join(paths.runtimePath, "thread-environments.json"), browserDiagnosticsPath: undefined } };
}

/** Call before transport/turn/page admission, then pass this exact provider to the adapter. */
export async function prepareContinuityDevProvider(original: CodexProviderConfig, paths: DevRuntimePaths, state: PrivateState = {}) {
  const provider = continuityDevProvider(original, paths, state);
  const config = loadConfigFromPath(join(paths.home, "config.json"));
  const current = providerConfig(config).chatgptWeb!, web = provider.chatgptWeb!;
  if (config.purpose !== "dev-harness") throw new Error("Continuity acceptance requires the installed DEV profile");
  if (config.mode !== "full" || web.localToolsEnabled !== true || web.appName !== current.appName
    || (web.browserInteractionMode ?? "automatic") !== current.browserInteractionMode || web.brokerSocketPath !== current.brokerSocketPath) {
    throw new Error("Continuity acceptance configuration does not match the active provider");
  }
  const schemaDigest = await installedContextCapabilitySchemaDigest(config);
  return { provider, capability: contextCapabilityBinding(config, schemaDigest, paths.home) };
}

/** Whitelisted runtime identity evidence; never emit the provider or its complete binding. */
export function continuityDevProviderEvidence(prepared: Awaited<ReturnType<typeof prepareContinuityDevProvider>>) {
  const { provider, capability } = prepared;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return { configured: true, staticSchemaChecked: true, profile: capability.profile, mode: capability.mode,
    schemaDigest: capability.schemaDigest, runtimeFingerprint: capability.runtimeFingerprint,
    installedHomeDigest: digest(capability.home), statePathDigest: digest(provider.chatgptWeb!.threadEnvironmentStatePath!),
    contextProtocol: capability.contextProtocol, textReadFormat: capability.textReadFormat,
    checkedBeforeTurnAdmission: true };
}
