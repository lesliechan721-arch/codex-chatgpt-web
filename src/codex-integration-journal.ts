import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "./config";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  serializeJournal,
  writeFilesWithCompensation,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  LegacyCodexIntegrationJournal,
  LegacyCodexIntegrationJournalV9,
  LegacyCodexIntegrationJournalV3,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
} from "./codex-integration-shared";
import { verifyManagedJournalState } from "./codex-integration-route";
import { installCodexInterruptHookCommand, restoreCodexInterruptHook } from "./codex-interrupt-hook";
import { restoreAutoRecap } from "./codex-integration-tui";

function isPreviousAssignment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Record<string, unknown>;
  if (typeof assignment.present !== "boolean") return false;
  return !assignment.present
    || (typeof assignment.rawLine === "string" && typeof assignment.value === "string");
}

function isInstalledInterruptHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hook = value as Record<string, unknown>;
  return typeof hook.command === "string" && hook.command.length > 0
    && Number.isSafeInteger(hook.groupIndex) && (hook.groupIndex as number) >= 0
    && typeof hook.stateKey === "string" && hook.stateKey.length > 0
    && typeof hook.trustedHash === "string" && /^sha256:[a-f0-9]{64}$/.test(hook.trustedHash)
    && typeof hook.fragment === "string" && hook.fragment.length > 0;
}

function isPreviousAutoRecap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assignment = value as Record<string, unknown>;
  return isPreviousAssignment(value)
    && typeof assignment.tablePresent === "boolean"
    && (assignment.location === "table" || assignment.location === "dotted" || assignment.location === "inline")
    && typeof assignment.installedAssignment === "string" && assignment.installedAssignment.length > 0
    && (!assignment.present || assignment.value === "true" || assignment.value === "false")
    && (assignment.inlineInsertion === undefined || typeof assignment.inlineInsertion === "string")
    && (assignment.separatorInserted === undefined || typeof assignment.separatorInserted === "boolean");
}

function parseJournal(path: string): AnyCodexIntegrationJournal {
  const value = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))) as Record<string, unknown>;
  const installed = value.installed as Record<string, unknown> | undefined;
  if (value.version === 10
    && typeof value.active === "boolean"
    && installed
    && typeof installed.openai_base_url === "string"
    && installed.experimental_realtime_webrtc_call_base_url === CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && isPreviousAssignment(value.previousRealtimeWebrtcCallBaseUrl)
    && isInstalledInterruptHook(value.interruptHook)
    && (value.previousAutoRecap === undefined || isPreviousAutoRecap(value.previousAutoRecap))
    && typeof value.configPath === "string") {
    return value as unknown as CodexIntegrationJournal;
  }
  if (value.version === 9
    && typeof value.active === "boolean"
    && installed
    && typeof installed.openai_base_url === "string"
    && installed.experimental_realtime_webrtc_call_base_url === CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && isPreviousAssignment(value.previousRealtimeWebrtcCallBaseUrl)
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV9;
  }
  if (value.version === 8
    && typeof value.active === "boolean"
    && installed
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV8;
  }
  if (value.version === 7
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV7;
  }
  if (value.version === 6
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && value.previousMultiAgentV2
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV6;
  }
  if (value.version === 5
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV5;
  }
  if (value.version === 4
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV4;
  }
  if (value.version === 3 && value.installed && value.previous && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV3;
  }
  if (value.version === 2 && value.installed && value.previous && typeof value.providerBlock === "string") {
    return value as unknown as LegacyCodexIntegrationJournal;
  }
  throw new Error(`Invalid Codex integration journal: ${path}`);
}
function journalMatchesConfig(journal: AnyCodexIntegrationJournal): boolean {
  try {
    assertJournalTargetsConfig(journal, getCodexConfigPath());
    if (!existsSync(journal.configPath)) return false;
    const text = readFileSync(journal.configPath, "utf8");
    if (journal.version === 2) return text.includes(journal.providerBlock);
    verifyManagedJournalState(text, journal);
    return true;
  } catch {
    return false;
  }
}

function matchesAutoRecapMigration(newer: CodexIntegrationJournal, older: CodexIntegrationJournal): boolean {
  if (!newer.previousAutoRecap || older.previousAutoRecap) return false;
  const { previousAutoRecap: _recap, ...prior } = newer;
  const sameBaseline = {
    ...prior,
    interruptHook: { ...prior.interruptHook, fragment: older.interruptHook.fragment },
  };
  // All previous route/feature assignments and the hook's command, trust and index must agree.
  if (serializeJournal(sameBaseline) !== serializeJournal(older)) return false;
  if (newer.interruptHook.fragment === older.interruptHook.fragment) return true;
  if (!newer.active || !older.active) return false;
  try {
    const text = readFileSync(newer.configPath, "utf8");
    const withoutHook = restoreCodexInterruptHook(text, newer.interruptHook);
    const regeneratedNew = installCodexInterruptHookCommand(withoutHook, newer.configPath, newer.interruptHook.command);
    if (JSON.stringify(regeneratedNew.installed) !== JSON.stringify(newer.interruptHook)) return false;
    // Adding [tui] can change the hook's leading separator. Reproduce both installations to
    // accept only that generated difference, rather than ignoring arbitrary fragment changes.
    const withoutRecap = restoreAutoRecap(withoutHook, newer.previousAutoRecap);
    const regeneratedOld = installCodexInterruptHookCommand(withoutRecap, older.configPath, older.interruptHook.command);
    return JSON.stringify(regeneratedOld.installed) === JSON.stringify(older.interruptHook);
  } catch {
    return false;
  }
}

export function readJournal(): AnyCodexIntegrationJournal | undefined {
  const primaryPath = getCodexJournalPath();
  const recoveryPath = getCodexJournalRecoveryPath();
  let primary: AnyCodexIntegrationJournal | undefined;
  let recovery: AnyCodexIntegrationJournal | undefined;
  let primaryError: unknown;
  let recoveryError: unknown;
  if (existsSync(primaryPath)) {
    try { primary = parseJournal(primaryPath); } catch (error) { primaryError = error; }
  }
  if (existsSync(recoveryPath)) {
    try { recovery = parseJournal(recoveryPath); } catch (error) { recoveryError = error; }
  }
  if (!primary && !recovery) {
    if (primaryError) throw primaryError;
    if (recoveryError) throw recoveryError;
    return undefined;
  }
  if (primary && recovery && serializeJournal(primary) === serializeJournal(recovery)) return primary;
  if (primary && !recovery && !recoveryError) {
    atomicWriteFile(recoveryPath, serializeJournal(primary));
    return primary;
  }
  if (recovery && !primary && !primaryError) {
    if (!journalMatchesConfig(recovery)) {
      throw new Error("Codex integration recovery journal does not match the active config");
    }
    atomicWriteFile(primaryPath, serializeJournal(recovery));
    return recovery;
  }

  const primaryMatches = primary ? journalMatchesConfig(primary) : false;
  const recoveryMatches = recovery ? journalMatchesConfig(recovery) : false;
  // Released v10 journals do not own auto_recap. After adding its baseline, both copies can
  // still match the config. Accept only the added baseline and its reproducible hook separator.
  let migrated: CodexIntegrationJournal | undefined;
  if (primaryMatches && recoveryMatches && primary?.version === 10 && recovery?.version === 10) {
    const newer = primary.previousAutoRecap ? primary : recovery.previousAutoRecap ? recovery : undefined;
    const older = newer === primary ? recovery : primary;
    if (newer && matchesAutoRecapMigration(newer, older)) migrated = newer;
  }
  if (migrated) {
    const data = serializeJournal(migrated);
    writeFilesWithCompensation([{ path: recoveryPath, data }, { path: primaryPath, data }]);
    return migrated;
  }
  if (primaryMatches === recoveryMatches) {
    throw new Error(
      primaryMatches
        ? "Codex integration journal copies contain different baselines for the same config"
        : "Codex integration journal copies do not match the active config",
    );
  }
  const selected = primaryMatches ? primary! : recovery!;
  const data = serializeJournal(selected);
  writeFilesWithCompensation([
    { path: recoveryPath, data },
    { path: primaryPath, data },
  ]);
  return selected;
}

export function assertJournalTargetsConfig(
  journal: AnyCodexIntegrationJournal,
  configPath: string,
): void {
  const pathIdentity = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (pathIdentity(journal.configPath) !== pathIdentity(configPath)) {
    throw new Error(
      `Codex integration journal belongs to ${journal.configPath}, not the active config ${configPath}`,
    );
  }
}
