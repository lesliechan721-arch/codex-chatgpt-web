import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bindingModule from "../src/adapters/chatgpt-web/continuity-binding";
import * as continuationModule from "../src/adapters/chatgpt-web/continuity-recovery-continuation";
import * as environmentModule from "../src/adapters/chatgpt-web/environment";
import type { RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { parseRequest } from "../src/responses/parser";
import { withContinuitySourceDiagnostics } from "./helpers/continuity-source-diagnostics";

test("source diagnostics preserve results and selector exceptions when observation and output fail", async () => {
  const previous = process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
  process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = "1";
  const originals = { live: bindingModule.selectContinuityCheckpoint, durable: continuationModule.selectRecoveryContinuation,
    carried: environmentModule.requestCarriedChatGptInstructionRevision };
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
    expect(output).toHaveBeenCalledTimes(2);
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
    else process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS = previous;
  }
});
