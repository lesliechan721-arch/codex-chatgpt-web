import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfig, defaultConfig, loadConfigFromPath } from "../src/config";

test("composer limits default to 8000 and mode overrides survive profile loading", () => {
  const root = mkdtempSync(join(tmpdir(), "context-composer-config-"));
  const path = join(root, "config.json");
  try {
    const config = defaultConfig("browser-only");
    expect(providerConfig(config).chatgptWeb?.maxComposerCodePoints).toBe(8_000);
    writeFileSync(path, JSON.stringify({ ...config, maxComposerCodePoints: 7_000, automaticMaxComposerCodePoints: 6_000, zeroRiskMaxComposerCodePoints: 5_000 }));
    const loaded = loadConfigFromPath(path);
    expect(providerConfig(loaded).chatgptWeb?.maxComposerCodePoints).toBe(6_000);
    expect(providerConfig({ ...loaded, browserInteractionMode: "manual" }).chatgptWeb?.maxComposerCodePoints).toBe(5_000);
    for (const key of ["maxComposerCodePoints", "automaticMaxComposerCodePoints", "zeroRiskMaxComposerCodePoints"]) {
      for (const value of [0, -1, 1.5, "8000", null, Number.MAX_SAFE_INTEGER + 1]) {
        writeFileSync(path, JSON.stringify({ ...config, [key]: value }));
        expect(() => loadConfigFromPath(path)).toThrow(`Invalid ${key}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
