import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import {
  activateCodexIntegration, deactivateCodexIntegration, getCodexConfigPath, getCodexJournalPath,
  getCodexJournalRecoveryPath, installCodexIntegration, inspectCodexIntegration,
  preflightCodexIntegration, readCodexModelContextOverride, uninstallCodexIntegration,
} from "../src/codex-integration";
import { splitLines } from "../src/codex-integration-document";
import { restoreAutoRecap } from "../src/codex-integration-tui";
import { installCodexInterruptHookCommand, restoreCodexInterruptHook } from "../src/codex-interrupt-hook";
import type { CodexIntegrationJournal } from "../src/codex-integration-shared";

const envKeys = ["HOME", "CODEX_HOME", "CODEX_CHATGPT_WEB_HOME"] as const;
let root: string;
let savedEnv: Array<string | undefined>;
beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key]);
  root = mkdtempSync(join(tmpdir(), "codex-auto-recap-"));
  envKeys.forEach((key, index) => {
    process.env[key] = join(root, String(index));
    mkdirSync(process.env[key]!, { recursive: true });
  });
});
afterEach(() => {
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  rmSync(root, { recursive: true, force: true });
});
const parsed = () => Bun.TOML.parse(splitLines(readFileSync(getCodexConfigPath(), "utf8")).join("\n")) as { tui?: { auto_recap?: boolean; status_line?: string[] } };
const originals = [
  "",
  'model = "gpt-5.6-sol"\n',
  '[tui]\nauto_recap = true # user choice\nstatus_line = ["model"]\n',
  '[tui]\nauto_recap = false # user choice\n',
  '[tui]\nstatus_line = ["model"]\n',
  '["tui"] # settings\n"auto_recap" = true # user choice\n',
  '"tui".\'auto_recap\' = true # user choice\n',
  'tui.status_line = ["model"]\n',
  'tui = { "auto_recap" = true, status_line = ["model"] } # user choice\n',
  'tui = { status_line = ["model"], notifications = { enabled = true } }\n',
  'tui = {   }\n',
  '[tui.notifications]\nenabled = true\n',
  'model = "gpt-5.6-sol"\r\n\r[tui]\nauto_recap = true # user choice\rstatus_line = ["model"]',
];

function oldV10Config(journal: CodexIntegrationJournal): string {
  const withoutHook = restoreCodexInterruptHook(readFileSync(getCodexConfigPath(), "utf8"), journal.interruptHook);
  const baseline = restoreAutoRecap(withoutHook, journal.previousAutoRecap!);
  const hook = installCodexInterruptHookCommand(baseline, getCodexConfigPath(), journal.interruptHook.command);
  journal.interruptHook = hook.installed;
  delete journal.previousAutoRecap;
  return hook.text;
}

describe("reversible auto_recap configuration", () => {
  for (const protocol of ["native", "compatibility-v1"] as const) {
    for (const delimiter of ['"""', "'''"]) {
      for (const realTable of [false, true]) {
        test(`${protocol} preserves multiline ${delimiter} instructions with real table=${realTable}`, () => {
          const config = { ...defaultConfig(), subagentProtocol: protocol };
          const instructions = `${delimiter}\nUse this TOML example:\n[example]\nvalue = true\n`
            + 'openai_base_url = "https://example.invalid/v1"\nmodel_provider = "example"\nmodel_catalog_json = "/example.json"\n'
            + 'experimental_realtime_webrtc_call_base_url = "https://voice.example/v1"\nmodel_context_window = 123\n'
            + delimiter;
          const original = `tui.status_line = ["model"]\ndeveloper_instructions = ${instructions}\n`
            + (realTable ? "\n[features]\ngoals = true\n" : "");
          writeFileSync(getCodexConfigPath(), original);
          const before = Bun.TOML.parse(original) as { developer_instructions: string };
          expect(readCodexModelContextOverride()).toBeUndefined();
          preflightCodexIntegration(config);
          expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
          installCodexIntegration(config);
          const after = Bun.TOML.parse(readFileSync(getCodexConfigPath(), "utf8")) as { developer_instructions: string; tui: { auto_recap: boolean } };
          expect(after.developer_instructions).toBe(before.developer_instructions);
          expect(readFileSync(getCodexConfigPath(), "utf8")).toContain(`developer_instructions = ${instructions}`);
          expect(after.tui.auto_recap).toBe(false);
          expect(inspectCodexIntegration().errors).toEqual([]);
          deactivateCodexIntegration();
          expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
          activateCodexIntegration();
          uninstallCodexIntegration();
          expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
        });
      }
    }
  }

  for (const protocol of ["native", "compatibility-v1"] as const) {
    for (const [index, original] of originals.entries()) {
      test(`${protocol} restores TUI source form ${index} after reinstall, disconnect and uninstall`, () => {
        const config = { ...defaultConfig(), subagentProtocol: protocol };
        writeFileSync(getCodexConfigPath(), original);
        const first = installCodexIntegration(config);
        expect(first.version).toBe(10);
        expect(first.previousAutoRecap).toBeDefined();
        expect(parsed().tui?.auto_recap).toBe(false);
        expect(inspectCodexIntegration().errors).toEqual([]);
        installCodexIntegration({ ...config, port: config.port + 1 });
        expect(parsed().tui?.auto_recap).toBe(false);
        deactivateCodexIntegration();
        expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
        activateCodexIntegration();
        expect(parsed().tui?.auto_recap).toBe(false);
        expect(activateCodexIntegration()).toEqual({ changed: false, active: true });
        uninstallCodexIntegration();
        expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
      });
    }
  }

  for (const active of [true, false]) {
    for (const action of ["install", "activate"] as const) {
      for (const protocol of ["native", "compatibility-v1"] as const) {
        for (const [index, original] of [
          '[tui]\nauto_recap = true # original\n', '[tui]\nauto_recap = false # original\n', 'model = "gpt-5.6-sol"\n',
        ].entries()) {
          test(`upgrades old v10 ${protocol} source ${index} with active=${active} through ${action}`, () => {
            const config = { ...defaultConfig(), subagentProtocol: protocol };
            writeFileSync(getCodexConfigPath(), original);
            const journal = installCodexIntegration(config);
            const oldConfig = oldV10Config(journal);
            writeFileSync(getCodexConfigPath(), oldConfig);
            writeFileSync(getCodexJournalPath(), JSON.stringify(journal));
            writeFileSync(getCodexJournalRecoveryPath(), JSON.stringify(journal));
            expect(inspectCodexIntegration().errors).toEqual([]);
            if (!active) deactivateCodexIntegration();
            preflightCodexIntegration(config);
            expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(active ? oldConfig : original);
            if (action === "install") installCodexIntegration(config);
            else expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
            expect(parsed().tui?.auto_recap).toBe(false);
            expect(inspectCodexIntegration().journal).toHaveProperty("previousAutoRecap");
            uninstallCodexIntegration();
            expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
          });
        }
      }
    }
  }

  for (const version of [9, 10]) {
    for (const protocol of ["native", "compatibility-v1"] as const) {
      for (const active of [true, false]) {
        for (const action of ["install", "activate"] as const) {
          test(`upgrades old v${version} ${protocol} custom Voice baseline with active=${active} through ${action}`, () => {
            const config = { ...defaultConfig(), subagentProtocol: protocol };
            saveConfig(config);
            const originalVoiceLine = "experimental_realtime_webrtc_call_base_url = 'https://voice.example/v1' # original route";
            const original = `${originalVoiceLine}\n[tui]\nauto_recap = true # original\n`;
            writeFileSync(getCodexConfigPath(), original);
            const journal = installCodexIntegration(config, { replaceExistingRoute: true });
            let oldConfig = oldV10Config(journal);
            let oldJournal: object = journal;
            if (version === 9) {
              oldConfig = restoreCodexInterruptHook(oldConfig, journal.interruptHook);
              const { interruptHook: _hook, ...prior } = journal;
              oldJournal = { ...prior, version: 9 };
            }
            writeFileSync(getCodexConfigPath(), oldConfig);
            writeFileSync(getCodexJournalPath(), JSON.stringify(oldJournal));
            writeFileSync(getCodexJournalRecoveryPath(), JSON.stringify(oldJournal));
            if (!active) deactivateCodexIntegration();
            const paths = [getCodexConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()];
            const snapshots = paths.map(path => readFileSync(path, "utf8"));
            preflightCodexIntegration(config);
            expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(snapshots);
            if (action === "install") installCodexIntegration(config);
            else activateCodexIntegration();
            expect(parsed().tui?.auto_recap).toBe(false);
            expect(inspectCodexIntegration().errors).toEqual([]);
            expect(inspectCodexIntegration().journal).toHaveProperty("previousRealtimeWebrtcCallBaseUrl.rawLine", originalVoiceLine);
            uninstallCodexIntegration();
            expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
          });
        }
      }
    }
  }

  test("recovers either side of an interrupted old-v10 auto_recap migration", () => {
    const config = { ...defaultConfig(), subagentProtocol: "native" as const };
    const original = '[tui]\nauto_recap = true # original\n';
    writeFileSync(getCodexConfigPath(), original);
    const journal = installCodexIntegration(config);
    const upgradedConfig = readFileSync(getCodexConfigPath(), "utf8");
    const upgradedJournal = readFileSync(getCodexJournalPath(), "utf8");
    const oldConfig = oldV10Config(journal);
    const oldJournal = JSON.stringify(journal, null, 2) + "\n";
    writeFileSync(getCodexConfigPath(), oldConfig);
    writeFileSync(getCodexJournalPath(), oldJournal);
    writeFileSync(getCodexJournalRecoveryPath(), upgradedJournal);
    expect(inspectCodexIntegration().journal).not.toHaveProperty("previousAutoRecap");
    writeFileSync(getCodexConfigPath(), upgradedConfig);
    writeFileSync(getCodexJournalRecoveryPath(), upgradedJournal);
    expect(inspectCodexIntegration().journal).toHaveProperty("previousAutoRecap");
    uninstallCodexIntegration();
    expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
  });

  for (const protocol of ["native", "compatibility-v1"] as const) {
    for (const swapped of [false, true]) {
      for (const upgradedConfig of [false, true]) {
        for (const blankLine of [false, true]) {
          test(`recovers v10 ${protocol} hook separator migration with swapped=${swapped} upgraded config=${upgradedConfig} trailing blank=${blankLine}`, () => {
            const config = { ...defaultConfig(), subagentProtocol: protocol };
            const original = "[features]\ngoals = true\n" + (blankLine ? "\n" : "");
            writeFileSync(getCodexConfigPath(), original);
            const journal = installCodexIntegration(config);
            const oldConfig = oldV10Config(journal);
            const oldJournal = JSON.stringify(journal, null, 2) + "\n";
            writeFileSync(getCodexConfigPath(), oldConfig);
            writeFileSync(getCodexJournalPath(), oldJournal);
            writeFileSync(getCodexJournalRecoveryPath(), oldJournal);
            const next = installCodexIntegration(config);
            if (protocol === "native" && blankLine) expect(next.interruptHook.fragment).not.toBe(journal.interruptHook.fragment);
            const newJournal = readFileSync(getCodexJournalPath(), "utf8");
            if (!upgradedConfig) writeFileSync(getCodexConfigPath(), oldConfig);
            writeFileSync(getCodexJournalPath(), swapped ? newJournal : oldJournal);
            writeFileSync(getCodexJournalRecoveryPath(), swapped ? oldJournal : newJournal);
            const status = inspectCodexIntegration();
            expect(status.errors).toEqual([]);
            if (upgradedConfig) expect(status.journal).toHaveProperty("previousAutoRecap");
            else expect(status.journal).not.toHaveProperty("previousAutoRecap");
            const selected = upgradedConfig ? newJournal : oldJournal;
            expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(selected);
            expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(selected);
            uninstallCodexIntegration();
            expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
          });
        }
      }
    }
  }

  for (const swapped of [false, true]) {
    test(`rejects an unrelated hook fragment separator difference with swapped=${swapped}`, () => {
      const config = { ...defaultConfig(), subagentProtocol: "native" as const };
      writeFileSync(getCodexConfigPath(), "[features]\ngoals = true\n\n");
      const journal = installCodexIntegration(config);
      const oldConfig = oldV10Config(journal);
      const oldJournal = JSON.stringify(journal, null, 2) + "\n";
      writeFileSync(getCodexConfigPath(), oldConfig);
      writeFileSync(getCodexJournalPath(), oldJournal);
      writeFileSync(getCodexJournalRecoveryPath(), oldJournal);
      installCodexIntegration(config);
      const newJournal = readFileSync(getCodexJournalPath(), "utf8");
      journal.interruptHook.fragment = "\n\n\n" + journal.interruptHook.fragment;
      const changedJournal = JSON.stringify(journal, null, 2) + "\n";
      writeFileSync(getCodexJournalPath(), swapped ? newJournal : changedJournal);
      writeFileSync(getCodexJournalRecoveryPath(), swapped ? changedJournal : newJournal);
      expect(() => inspectCodexIntegration()).toThrow("different baselines for the same config");
    });
  }

  for (const protocol of ["native", "compatibility-v1"] as const) {
    for (const swapped of [false, true]) {
      test(`rejects a different v10 ${protocol} baseline with swapped=${swapped}`, () => {
        const config = { ...defaultConfig(), subagentProtocol: protocol };
        const original = 'openai_base_url = "https://original.example/v1" # original route\n\n[features]\ngoals = true\n\n';
        writeFileSync(getCodexConfigPath(), original);
        const journal = installCodexIntegration(config, { replaceExistingRoute: true });
        const oldConfig = oldV10Config(journal);
        const oldJournal = JSON.stringify(journal, null, 2) + "\n";
        writeFileSync(getCodexConfigPath(), oldConfig);
        writeFileSync(getCodexJournalPath(), oldJournal);
        writeFileSync(getCodexJournalRecoveryPath(), oldJournal);
        installCodexIntegration(config);
        const newJournal = readFileSync(getCodexJournalPath(), "utf8");
        journal.previous.openai_base_url.rawLine = 'openai_base_url = "https://original.example/v1" # different baseline';
        const changedJournal = JSON.stringify(journal, null, 2) + "\n";
        writeFileSync(getCodexJournalPath(), swapped ? newJournal : changedJournal);
        writeFileSync(getCodexJournalRecoveryPath(), swapped ? changedJournal : newJournal);
        const paths = [getCodexConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()];
        const snapshots = paths.map(path => readFileSync(path, "utf8"));
        expect(() => inspectCodexIntegration()).toThrow("different baselines for the same config");
        expect(() => uninstallCodexIntegration()).toThrow("different baselines for the same config");
        expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(snapshots);
      });
    }
  }

  test("protects changed auto_recap values and explicit replacement adopts the newer value", () => {
    const config = { ...defaultConfig(), subagentProtocol: "native" as const };
    const original = '[tui]\nauto_recap = false # original\nstatus_line = ["model"]\n';
    writeFileSync(getCodexConfigPath(), original);
    installCodexIntegration(config);
    const newer = readFileSync(getCodexConfigPath(), "utf8").replace("auto_recap = false # original", "auto_recap = true # newer");
    writeFileSync(getCodexConfigPath(), newer);
    const snapshots = [getCodexConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()].map(path => readFileSync(path, "utf8"));
    for (const action of [
      () => preflightCodexIntegration(config), () => installCodexIntegration(config),
      () => deactivateCodexIntegration(), () => activateCodexIntegration(), () => uninstallCodexIntegration(),
    ]) expect(action).toThrow("auto_recap changed after setup");
    expect([getCodexConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()].map(path => readFileSync(path, "utf8"))).toEqual(snapshots);
    preflightCodexIntegration(config, { replaceExistingRoute: true });
    installCodexIntegration(config, { replaceExistingRoute: true });
    expect(parsed().tui?.auto_recap).toBe(false);
    uninstallCodexIntegration();
    expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original.replace("auto_recap = false # original", "auto_recap = true # newer"));
  });

  test("protects a disconnected auto_recap baseline and preserves explicit replacement", () => {
    const config = { ...defaultConfig(), subagentProtocol: "native" as const };
    const original = '[tui]\nauto_recap = true # original\n';
    writeFileSync(getCodexConfigPath(), original);
    installCodexIntegration(config);
    deactivateCodexIntegration();
    const newer = original.replace("true # original", "false # newer");
    writeFileSync(getCodexConfigPath(), newer);
    expect(() => activateCodexIntegration()).toThrow("auto_recap changed while the bridge was disconnected");
    expect(() => uninstallCodexIntegration()).toThrow("auto_recap changed while the bridge was disconnected");
    installCodexIntegration(config, { replaceExistingRoute: true });
    uninstallCodexIntegration();
    expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(newer);
  });

  test("preserves unrelated changes in inline TUI settings", () => {
    const config = { ...defaultConfig(), subagentProtocol: "native" as const };
    const original = 'tui = { auto_recap = true, status_line = ["model"] }\n';
    writeFileSync(getCodexConfigPath(), original);
    installCodexIntegration(config);
    writeFileSync(getCodexConfigPath(), readFileSync(getCodexConfigPath(), "utf8").replace('["model"]', '["context"]'));
    uninstallCodexIntegration();
    expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original.replace('["model"]', '["context"]'));
  });

  test("retains fields added to an initially empty inline TUI table", () => {
    const config = { ...defaultConfig(), subagentProtocol: "native" as const };
    writeFileSync(getCodexConfigPath(), 'tui = { }\n');
    installCodexIntegration(config);
    writeFileSync(getCodexConfigPath(), readFileSync(getCodexConfigPath(), "utf8").replace("auto_recap = false", 'auto_recap = false, status_line = ["model"]'));
    uninstallCodexIntegration();
    expect(parsed().tui?.auto_recap).toBeUndefined();
    expect(parsed().tui?.status_line).toEqual(["model"]);
  });

  test("rejects non-boolean auto_recap without changing the user config", () => {
    const config = defaultConfig();
    const original = '[tui]\nauto_recap = "true"\n';
    writeFileSync(getCodexConfigPath(), original);
    expect(() => preflightCodexIntegration(config)).toThrow("auto_recap in Codex [tui] must be a boolean");
    expect(() => installCodexIntegration(config)).toThrow("auto_recap in Codex [tui] must be a boolean");
    expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
  });
});
