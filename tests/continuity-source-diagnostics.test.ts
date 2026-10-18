import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as bindingModule from "../src/adapters/chatgpt-web/continuity-binding";
import * as continuationModule from "../src/adapters/chatgpt-web/continuity-recovery-continuation";
import * as compactionModule from "../src/adapters/chatgpt-web/continuity-recovery-compaction";
import * as environmentModule from "../src/adapters/chatgpt-web/environment";
import type { RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { parseRequest } from "../src/responses/parser";
import { withContinuitySourceDiagnostics } from "./helpers/continuity-source-diagnostics";

test("source diagnostics distinguish absent, unreadable, and invalid durable snapshots without changing results", async () => {
  const previous = process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
  process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = "1";
  const root = mkdtempSync(join(tmpdir(), "cgw-source-diagnostic-"));
  const reports: any[] = [];
  const output = spyOn(console, "error").mockImplementation(line => {
    reports.push(JSON.parse(String(line).split("[continuity-source-diagnostic] ")[1]!));
  });
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [] });
  const context = { scenario: "diagnostic-boundary", format: "v1" as const, round: 0, change: "none",
    threadId: "diagnostic-thread", statePath: root, submissions: () => 0 };
  const result = {};
  const check = async (status: string) => {
    expect(await withContinuitySourceDiagnostics(parsed, context, async () => result)).toBe(result);
    const report = reports.at(-1)!;
    expect(report.before.durableRead.status).toBe(status);
    expect(report.after.durableRead.status).toBe(status);
    expect(report.before.durable).toBeNull();
    expect(report.outcome).toEqual({ status: "accepted" });
    expect(JSON.stringify(report)).not.toContain(root);
  };
  try {
    await check("file-missing");
    writeFileSync(join(root, "recovery.json"), "invalid-json-body-must-not-appear");
    await check("parse-error");
    expect(JSON.stringify(reports)).not.toContain("invalid-json-body-must-not-appear");
    writeFileSync(join(root, "recovery.json"), JSON.stringify({ threads: {} }));
    await check("thread-missing");
    writeFileSync(join(root, "recovery.json"), JSON.stringify({ threads: null }));
    await check("invalid-document");
    rmSync(join(root, "recovery.json"));
    mkdirSync(join(root, "recovery.json"));
    await check("read-error");
  } finally {
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
    else process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = previous;
  }
});

test("source diagnostics observe fresh and durable compaction entries without replacing their failures", async () => {
  const previous = process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
  process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = "1";
  const reports: any[] = [];
  const output = spyOn(console, "error").mockImplementation(line => {
    reports.push(JSON.parse(String(line).split("[continuity-source-diagnostic] ")[1]!));
  });
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [] });
  parsed._compactionRequest = true;
  const context = { scenario: "diagnostic-boundary", format: "v1" as const, round: 0, change: "none",
    threadId: "diagnostic-thread", statePath: join(tmpdir(), "cgw-diagnostic-unused"), submissions: () => 0 };
  try {
    const failure = new Error("Fixture compatibility failure");
    let checks = 0;
    const fresh = await withContinuitySourceDiagnostics(parsed, context, () => compactionModule.prepareFreshRecoveryCompaction(
      parsed, undefined as never, "fixture", undefined as never, undefined as never, undefined as never, "fixture",
      undefined, async () => { checks++; throw failure; },
    )).catch(error => error);
    expect(fresh).toBe(failure);
    expect(checks).toBe(1);
    expect(reports.at(-1).observations).toContainEqual({ path: "compaction-prepare", entry: "fresh", error: "other-error" });
    const durable = await withContinuitySourceDiagnostics(parsed, context, () => compactionModule.prepareRecoveryCompaction(
      parsed, undefined as never, "fixture", undefined as never, undefined as never, undefined as never, undefined, "fixture",
    )).catch(error => error);
    expect(durable).toMatchObject({ code: "continuity_source_unproven" });
    expect(reports.at(-1).observations).toContainEqual({ path: "compaction-prepare", entry: "durable", state: null,
      existingTarget: null, error: "continuity_source_unproven" });
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
    else process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = previous;
  }
});

test("source diagnostics preserve results and selector exceptions when observation and output fail", async () => {
  const previous = process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
  process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = "1";
  const originals = { live: bindingModule.selectContinuityCheckpoint, durable: continuationModule.selectRecoveryContinuation,
    carried: environmentModule.requestCarriedChatGptInstructionRevision, target: compactionModule.selectRecoveryCompactionTarget,
    prepare: compactionModule.prepareRecoveryCompaction, fresh: compactionModule.prepareFreshRecoveryCompaction };
  const output = spyOn(console, "error").mockImplementation(() => { throw new Error("Diagnostic output unavailable"); });
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [] });
  parsed._conversationPolicy = "task";
  const context = { scenario: "diagnostic-boundary", format: "v1" as const, round: 0, change: "none",
    threadId: "diagnostic-thread", statePath: join(tmpdir(), "cgw-diagnostic-unused"),
    submissions: () => { throw new Error("Diagnostic snapshot unavailable"); } };
  let runs = 0;
  try {
    const value = {};
    expect(await withContinuitySourceDiagnostics(parsed, context, async () => {
      runs++;
      expect(bindingModule.selectContinuityCheckpoint(parsed, {})).toBeUndefined();
      return value;
    })).toBe(value);
    expect(bindingModule.selectContinuityCheckpoint).toBe(originals.live);
    expect(continuationModule.selectRecoveryContinuation).toBe(originals.durable);
    expect(environmentModule.requestCarriedChatGptInstructionRevision).toBe(originals.carried);
    expect(compactionModule.selectRecoveryCompactionTarget).toBe(originals.target);
    expect(compactionModule.prepareRecoveryCompaction).toBe(originals.prepare);
    expect(compactionModule.prepareFreshRecoveryCompaction).toBe(originals.fresh);
    let selectorError: unknown;
    const result = await withContinuitySourceDiagnostics(parsed, context, async () => {
      runs++;
      try {
        // The observation cannot enumerate this rejected record. The selector must
        // still execute once and return its original continuity rejection.
        return continuationModule.selectRecoveryContinuation(parsed, { thread: "foreign" } as RecoveryThreadRecord,
          { threadId: context.threadId, turnId: "diagnostic-turn" });
      } catch (error) { selectorError = error; throw error; }
    }).catch(error => error);
    expect(selectorError).toMatchObject({ code: "continuity_source_unproven" });
    expect(result).toBe(selectorError);
    expect(runs).toBe(2);
    expect(bindingModule.selectContinuityCheckpoint).toBe(originals.live);
    expect(continuationModule.selectRecoveryContinuation).toBe(originals.durable);
    expect(environmentModule.requestCarriedChatGptInstructionRevision).toBe(originals.carried);
    expect(compactionModule.selectRecoveryCompactionTarget).toBe(originals.target);
    expect(compactionModule.prepareRecoveryCompaction).toBe(originals.prepare);
    expect(compactionModule.prepareFreshRecoveryCompaction).toBe(originals.fresh);
    expect(output).toHaveBeenCalledTimes(2);
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
    else process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = previous;
  }
});
