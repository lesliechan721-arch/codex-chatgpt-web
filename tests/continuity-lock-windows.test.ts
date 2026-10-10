import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveContinuityLockWithoutReplacement } from "../src/adapters/chatgpt-web/continuity-lock-windows";

test.skipIf(process.platform !== "win32")("Windows native lock publication supports Unicode and long paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-native-lock-"));
  try {
    const parent = join(directory, "锁目录", "a".repeat(180), "b".repeat(80));
    mkdirSync(parent, { recursive: true });
    const source = join(parent, "prepared"), destination = join(parent, "write.lock");
    mkdirSync(source); writeFileSync(join(source, "owner"), "prepared-owner");
    moveContinuityLockWithoutReplacement(source, destination);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(destination, "owner"), "utf8")).toBe("prepared-owner");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ["file", "empty directory", "owned directory"]) {
  test.skipIf(process.platform !== "win32")(`Windows native lock publication preserves an existing ${kind}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-native-lock-exists-"));
    try {
      const source = join(directory, "prepared"), destination = join(directory, "write.lock");
      mkdirSync(source); writeFileSync(join(source, "owner"), "prepared-owner");
      if (kind === "file") writeFileSync(destination, "existing-owner");
      else {
        mkdirSync(destination);
        if (kind === "owned directory") writeFileSync(join(destination, "other-owner"), "existing-owner");
      }
      expect(() => moveContinuityLockWithoutReplacement(source, destination)).toThrow();
      expect(readFileSync(join(source, "owner"), "utf8")).toBe("prepared-owner");
      if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("existing-owner");
      else expect(readdirSync(destination)).toEqual(kind === "owned directory" ? ["other-owner"] : []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
