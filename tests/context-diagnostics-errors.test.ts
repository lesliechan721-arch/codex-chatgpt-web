import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adapterFailureFromMessage, classifyError } from "../src/lib/errors";
import { sensitiveErrorSamples, type BrowserErrorLogResult } from "./helpers/browser-error-log-runtime";

const require = createRequire(import.meta.url);
const { RuntimeSupervisor } = require("../launcher/electron/runtime-supervisor.cjs");
const { createLogger } = require("../launcher/electron/logging.cjs");

test("availability wording and a local 503 do not claim model overload", () => {
  for (const message of [
    "Context navigation is not verified; context navigation remains unavailable",
    "Local source is temporarily unavailable",
  ]) expect(adapterFailureFromMessage(message).error.code).not.toBe("server_is_overloaded");
  expect(classifyError(503, "server_error", "Local protocol unavailable").code).not.toBe("server_is_overloaded");
  expect(adapterFailureFromMessage("ChatGPT server is overloaded")).toMatchObject({
    httpStatus: 503, error: { type: "server_error", code: "server_is_overloaded" },
  });
  expect(adapterFailureFromMessage("Selected model is at capacity.").error.code).toBe("server_is_overloaded");
});

test("real Adapter and Responses failures reach launcher logs with safe reasons and warning levels", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-error-log-"));
  const filePath = join(root, "launcher.jsonl");
  const logger = createLogger({ filePath });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "test", isPackaged: false }, logger, sourceRoot: process.cwd(), coreHome: root,
    browserDescriptorPath: join(root, "launcher.json"),
  });
  supervisor.stopping = true;
  try {
    const child = supervisor.spawnChild("daemon", {
      executable: process.execPath, args: [resolve("tests/helpers/browser-error-log-runtime.ts"), root], cwd: process.cwd(),
    });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    expect(exitCode, readFileSync(filePath, "utf8")).toBe(0);
    const results = JSON.parse(readFileSync(join(root, "responses.json"), "utf8")) as BrowserErrorLogResult[];
    const records = logger.recent(300);
    const browserRecords = records.filter((record: { detail: { line?: string } }) => record.detail.line?.includes("browser_settled"));
    expect(browserRecords).toHaveLength(results.length);
    for (const result of results) {
      expect(result.traceId).toBeDefined();
      const record = browserRecords.find((record: { detail: { line: string } }) => record.detail.line.includes(result.traceId!));
      const detail = JSON.parse(record.detail.line.split("browser_settled ")[1]);
      expect(detail).toMatchObject({ traceId: result.traceId, submission: result.submission, compaction: false });
      expect(result.httpStatus).toBe(200);
      if (result.name === "success") {
        expect(result.response.status, result.body).toBe("completed");
        expect(record.level).toBe("info");
        expect(record.event).toBe("runtime.daemon_stdout");
        expect(detail.reason).toBeUndefined();
        continue;
      }
      expect(result.response.status, result.body).toBe("failed");
      expect(record.level).toBe("warning");
      expect(record.event).toBe("runtime.daemon_stderr");
      expect(detail).toMatchObject({ outcome: "error", reason: result.reason });
      if (result.code) expect(detail.code).toBe(result.code);
      if (result.reason !== "upstream_overloaded") expect(result.response.error?.code).not.toBe("server_is_overloaded");
      else expect(result.response.error).toMatchObject({ type: "server_error", code: "server_is_overloaded" });
      if (result.name === "adapter-protocol") expect(result.response.error?.code).toBe("codex_context_upgrade_required");
      if (result.name === "cancelled") expect(result.response.error?.code).toBe("client_cancelled");
    }
    const logged = readFileSync(filePath, "utf8");
    for (const sample of sensitiveErrorSamples) expect(logged).not.toContain(sample);
    expect(logged).not.toContain("cause");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
