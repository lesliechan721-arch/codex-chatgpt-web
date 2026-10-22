import { afterEach, expect, spyOn, test } from "bun:test";
import { createSessionContinuityFixtures } from "./helpers/session-continuity-fixture";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const fails of [false, true]) test(`Native compaction retires its original runtime with explicit purpose (failure=${fails})`, async () => {
  const f = fixture(false, { waitForRetirement: true });
  const first = f.request();
  await f.run(first);
  const registration = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), registration.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  // Record the real adapter callback without replacing its implementation. The
  // production compaction entry, Native handoff and retirement all still execute.
  const retired = spyOn(source.runtime, "retireCapability");
  if (fails) f.automatic.mockImplementationOnce(async () => { throw new Error("Browser compaction transport failed"); });
  const compact = structuredClone(first); compact._compactionRequest = true;
  try {
    if (fails) await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    else await f.run(compact);
    // Before Native handoff, and again at successful retirement or failed cleanup.
    expect(retired.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const args of retired.mock.calls) expect(args[0]).toEqual({ compaction: true });
  } finally { retired.mockRestore(); }
}, 20_000);
