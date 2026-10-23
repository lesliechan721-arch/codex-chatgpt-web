import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfig, defaultConfig, loadConfigFromPath, saveConfig } from "../src/config";

test("retired context booleans load identically and disappear from runtime and saved configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "retired-context-config-"));
  const path = join(root, "config.json");
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    for (const manual of [false, true]) {
      const config = defaultConfig(manual ? "full" : "browser-only");
      if (manual) {
        config.browserInteractionMode = "manual";
        config.browserHost = "launcher";
        config.browserHostDescriptorPath = join(root, "launcher-browser.json");
        config.appName = config.manualAppName;
        config.tunnel = {
          binaryPath: join(root, "tunnel"), tunnelId: `tunnel_${"a".repeat(32)}`,
          runtimeKeyFile: join(root, "key"), profileDir: join(root, "profile"),
          profileName: "manual", alias: "manual",
        };
      }
      const variants = [undefined, false, true].map(experimentalBiggerContext => {
        writeFileSync(path, JSON.stringify({ ...config, experimentalBiggerContext }));
        return loadConfigFromPath(path);
      });
      expect(variants[1]).toEqual(variants[0]);
      expect(variants[2]).toEqual(variants[0]);
      for (const loaded of variants) {
        expect(loaded).not.toHaveProperty("experimentalBiggerContext");
        expect(providerConfig(loaded).chatgptWeb).not.toHaveProperty("experimentalBiggerContext");
        saveConfig(loaded);
        expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("experimentalBiggerContext");
      }
      writeFileSync(path, JSON.stringify({ ...config, experimentalBiggerContext: "true" }));
      expect(() => loadConfigFromPath(path)).toThrow("Invalid experimentalBiggerContext");
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

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
