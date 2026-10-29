import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfigFromPath } from "../src/config";

test("saved profiles default to next-message predictions and preserve explicit opt-out", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-prediction-config-"));
  const path = join(root, "config.json");
  try {
    for (const mode of ["browser-only", "full"] as const) {
      const config = defaultConfig(mode);
      if (mode === "full") config.tunnel = {
        binaryPath: join(root, "tunnel-client"), tunnelId: `tunnel_${"a".repeat(32)}`,
        runtimeKeyFile: join(root, "runtime.key"), profileDir: root,
        profileName: "prediction-test", alias: "prediction-test",
      };
      expect(config.composerPredictionsEnabled).toBe(true);
      const { composerPredictionsEnabled: _preference, ...legacy } = config;
      writeFileSync(path, JSON.stringify(legacy));
      expect(loadConfigFromPath(path).composerPredictionsEnabled).toBe(true);
      for (const enabled of [true, false]) {
        writeFileSync(path, JSON.stringify({ ...legacy, composerPredictionsEnabled: enabled }));
        expect(loadConfigFromPath(path).composerPredictionsEnabled).toBe(enabled);
      }
      writeFileSync(path, JSON.stringify({ ...legacy, composerPredictionsEnabled: "true" }));
      expect(() => loadConfigFromPath(path)).toThrow("Invalid composerPredictionsEnabled");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
