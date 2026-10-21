import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityBindings } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import * as storeModule from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryIdentity, retireRecoveryWriter } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import type { TurnBrokerOwner } from "../src/adapters/chatgpt-web/turn-broker";
import * as launcher from "../src/launcher-browser-host";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cgw-retirement-"));
  const registrations = new ContinuityRegistrationStore(directory); registrations.initialize();
  const bindings = new ContinuityBindings(registrations);
  const observed = bindings.recoveryStore.admitWork({ thread: "1".repeat(64), scope: "2".repeat(64),
    owner: storeModule.continuityProcessInstance(bindings.owner), logicalWorkId: "work", instructionIdentity: "instruction",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true });
  return { directory, bindings, observed };
}

test("Broker fencing avoids process probing and still requires durable and page retirement", async () => {
  const f = fixture(), events: string[] = [];
  const status = spyOn(storeModule, "continuityProcessInstanceStatus").mockImplementation(() => { throw new Error("unnecessary identity probe"); });
  let pageRetired = true;
  const page = spyOn(launcher, "retireLauncherContinuityWriter").mockImplementation(async (_descriptor, recovery) => {
    events.push("page");
    expect(f.bindings.recoveryStore.get(f.observed.thread)!.works.work!.attempts[0]!.writerRetired).toBe(true);
    return { recovery, state: "retired", writerRetired: pageRetired, toolsSettled: false, physicalCleanup: "destroyed" };
  });
  f.bindings.broker = { assertRecoveryFencing: async () => { events.push("fence"); },
    retireRecoveryWriter: async () => { events.push("broker"); return true; } } as unknown as TurnBrokerOwner;
  try {
    const retired = await retireRecoveryWriter(f.bindings, f.observed, "unused-launcher-descriptor");
    expect(retired.works.work!.attempts[0]!.writerRetired).toBe(true);
    expect(events).toEqual(["fence", "broker", "page"]);
    expect(status).not.toHaveBeenCalled();
    // Repeated retirement still verifies the page even when the durable writer is fenced.
    pageRetired = false;
    await expect(retireRecoveryWriter(f.bindings, retired, "unused-launcher-descriptor"))
      .rejects.toMatchObject({ code: "continuity_unverified" });
    expect(page).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
  } finally { status.mockRestore(); page.mockRestore(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("a failed fencing assertion cannot fall back to an exited process", async () => {
  const f = fixture(), failure = new Error("fencing unavailable");
  const status = spyOn(storeModule, "continuityProcessInstanceStatus").mockReturnValue("exited");
  f.bindings.broker = { assertRecoveryFencing: async () => { throw failure; } } as unknown as TurnBrokerOwner;
  try {
    await expect(retireRecoveryWriter(f.bindings, f.observed, "unused-launcher-descriptor")).rejects.toBe(failure);
    expect(status).not.toHaveBeenCalled();
    expect(f.bindings.recoveryStore.get(f.observed.thread)).toEqual(f.observed);
  } finally { status.mockRestore(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const cleanup of ["compaction", "explicit-exit"] as const) test(`cold retirement protects the journal until ${cleanup} cleanup`, async () => {
  const f = fixture();
  const binding = f.bindings.installRecovered(f.observed, "source", "5".repeat(64));
  const expected = { ownerId: f.observed.owner.id, identity: recoveryIdentity(f.observed, f.bindings.recoveryStore.installationId()) };
  const page = spyOn(launcher, "retireLauncherContinuityWriter").mockImplementation(async (_descriptor, recovery) => {
    // Page retirement can trigger cleanup before the compaction reserves an attempt.
    expect(() => f.bindings.forgetPage(binding, "source", expected)).toThrow();
    expect(f.bindings.recoveryStore.get(f.observed.thread)).toBeDefined();
    return { recovery, state: "retired", writerRetired: true, toolsSettled: false, physicalCleanup: "destroyed" };
  });
  f.bindings.broker = { assertRecoveryFencing: async () => {} } as unknown as TurnBrokerOwner;
  try {
    const retired = await retireRecoveryWriter(f.bindings, f.observed, "unused-launcher-descriptor", undefined,
      { executionKey: "compaction" });
    expect(retired.works.work!.attempts).toHaveLength(1);
    expect(retired.works.work!.retryBudget).toEqual(f.observed.works.work!.retryBudget);
    expect(() => f.bindings.forgetPage(binding, "source", expected)).toThrow();
    expect(f.bindings.recoveryStore.get(f.observed.thread)).toEqual(retired);
    expect(f.bindings.observed(f.observed.thread)).toBe(binding);
    f.bindings.forgetPage(binding, cleanup === "compaction" ? "compaction" : undefined, expected);
    expect(f.bindings.recoveryStore.get(f.observed.thread)).toBeUndefined();
    expect(f.bindings.registrations.get(f.observed.thread)).toBeUndefined();
    expect(f.bindings.observed(f.observed.thread)).toBeUndefined();
  } finally { page.mockRestore(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const identity of ["live", "unverified", "exited"] as const) test(`without Broker fencing retirement still checks the original process (${identity})`, async () => {
  const f = fixture();
  const status = spyOn(storeModule, "continuityProcessInstanceStatus").mockReturnValue(identity);
  const page = spyOn(launcher, "retireLauncherContinuityWriter").mockImplementation(async (_descriptor, recovery) =>
    ({ recovery, state: "retired", writerRetired: true, toolsSettled: false, physicalCleanup: "destroyed" }));
  try {
    const retiring = retireRecoveryWriter(f.bindings, f.observed, "unused-launcher-descriptor");
    if (identity === "exited") {
      expect((await retiring).works.work!.attempts[0]!.writerRetired).toBe(true);
      expect(page).toHaveBeenCalledTimes(1);
    } else {
      await expect(retiring).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
      expect(f.bindings.recoveryStore.get(f.observed.thread)).toEqual(f.observed);
      expect(page).not.toHaveBeenCalled();
    }
    expect(status).toHaveBeenCalledWith(f.observed.owner);
  } finally { status.mockRestore(); page.mockRestore(); rmSync(f.directory, { recursive: true, force: true }); }
});
