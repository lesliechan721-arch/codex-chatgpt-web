import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CodexProviderConfig } from "../src/types";
import type { DevProfilePaths } from "../src/dev-chat/profile";
import { assertProviderContextCapabilityVerified } from "../src/adapters/chatgpt-web/context-capability-verification";

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
  const evidence = await assertProviderContextCapabilityVerified(provider);
  if (evidence.binding.profile !== "development") throw new Error("Continuity acceptance requires verified installed DEV capability");
  return { provider, evidence };
}

/** Whitelisted runtime identity evidence; never emit the provider or its complete binding. */
export function continuityDevProviderEvidence(prepared: Awaited<ReturnType<typeof prepareContinuityDevProvider>>) {
  const { provider, evidence } = prepared;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return { verified: true, verifiedAt: evidence.verifiedAt, profile: evidence.binding.profile, mode: evidence.binding.mode,
    schemaDigest: evidence.binding.schemaDigest, runtimeFingerprint: evidence.binding.runtimeFingerprint,
    installedHomeDigest: digest(evidence.binding.home), statePathDigest: digest(provider.chatgptWeb!.threadEnvironmentStatePath!),
    contextProtocol: evidence.binding.contextProtocol, textReadFormat: evidence.binding.textReadFormat,
    checkedBeforeTurnAdmission: true };
}
