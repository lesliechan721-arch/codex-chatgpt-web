import { existsSync, readFileSync, rmSync } from "node:fs";
import { loadApiAccessPolicy } from "./api-access-config";
import { readJournal, assertJournalTargetsConfig } from "./codex-integration-journal";
import { replacementBaseline, restoreLegacyV2 } from "./codex-integration-route";
import { uninstallCodexIntegration } from "./codex-integration";
import {
  getCodexConfigPath, getCodexJournalPath, getCodexJournalRecoveryPath, getCodexModelsCachePath,
  snapshotFile, writeFileSnapshot, restoreFileSnapshot,
} from "./codex-integration-shared";

/** No journal means no authority to edit a user's manually copied provider or hooks. */
export function cleanupApiKeyCodexIntegration(dryRun = false): { changed: boolean } {
  if (loadApiAccessPolicy().mode !== "api-key") return { changed: false };
  const journal = readJournal();
  if (!journal) return { changed: false };
  const configPath = getCodexConfigPath();
  assertJournalTargetsConfig(journal, configPath);
  const config = snapshotFile(configPath, { followSymlink: true });
  const original = config.data?.toString("utf8") ?? "";
  if (journal.version === 2) {
    // Preserve the legacy installer's stricter provider/catalog ownership checks.
    if (dryRun) { restoreLegacyV2(original, journal); return { changed: true }; }
    return uninstallCodexIntegration();
  }
  // Unlike strict uninstall, this removes only still-owned settings and preserves newer manual
  // provider/catalog values. Altered hook definitions remain a conflict, never a deletion guess.
  const restored = replacementBaseline(original, config.exists, journal);
  if (dryRun) return { changed: true };
  const auxiliary = [getCodexJournalPath(), getCodexJournalRecoveryPath(), getCodexModelsCachePath()]
    .map(filePath => snapshotFile(filePath));
  // Refuse to overwrite an edit made after the plan was computed.
  if (config.exists !== existsSync(configPath)
    || (config.exists && !readFileSync(configPath).equals(config.data!))) {
    throw new Error("Codex configuration changed during API-mode cleanup; retry after the edit finishes");
  }
  for (const saved of auxiliary) {
    if (saved.exists !== existsSync(saved.path)
      || (saved.exists && !readFileSync(saved.path).equals(saved.data!))) {
      throw new Error("Codex integration ownership changed during API-mode cleanup; retry");
    }
  }
  try {
    // Never create an absent config merely to remove a stale journal.
    if (config.exists && original !== restored) writeFileSnapshot(config, restored);
    for (const saved of auxiliary) rmSync(saved.path, { force: true });
  } catch (error) {
    const failures: string[] = [];
    for (const saved of [...auxiliary, config].reverse()) {
      try { restoreFileSnapshot(saved); } catch { failures.push(saved.path); }
    }
    if (failures.length) throw new Error("Codex cleanup failed and its snapshot could not be fully restored");
    throw error;
  }
  return { changed: true };
}
