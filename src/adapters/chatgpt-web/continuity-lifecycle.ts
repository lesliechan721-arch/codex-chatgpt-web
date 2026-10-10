import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { expandUserPath } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import { continuityDigest, existingContinuityBindings, type ContinuityBinding } from "./continuity-binding";
import { continuityError } from "./continuity-errors";
import { chatGptTurnSessions } from "./turn-execution";
import { ContinuityRecoveryStore } from "./continuity-recovery-store";
import { ContinuityRegistrationStore } from "./continuity-registration";

const exits = new WeakMap<ContinuityBinding, Promise<void>>();

/** Called only by an authenticated stop or an explicit route change, never disconnect cleanup. */
export function stopDurableContinuity(
  directory: string | undefined, nativeThreadId: string | undefined,
  nativeTurnId?: string, reason: "user-stop" | "mode-exit" | "native-interrupt" = "user-stop",
): boolean {
  if (!directory || !nativeThreadId) return false;
  const resolved = resolve(expandUserPath(directory));
  if (!existsSync(resolved)) return false;
  const files = ["initialized.json", "threads.json", "recovery-initialized.json", "recovery.json"];
  if (!files.some(file => existsSync(join(resolved, file)))) return false;
  // Ordinary routes can use an older installation that never entered continuity.
  // A registered thread or an initialized recovery journal still fails closed if lost.
  const registration = new ContinuityRegistrationStore(resolved).get(continuityDigest(nativeThreadId));
  if (!registration && !existsSync(join(resolved, "recovery-initialized.json")) && !existsSync(join(resolved, "recovery.json"))) {
    // Registration.get above has validated this bounded installation marker.
    const marker = JSON.parse(readFileSync(join(resolved, "initialized.json"), "utf8"));
    if (marker.recoveryVersion !== 2) return false;
  }
  const store = new ContinuityRecoveryStore(resolved);
  const record = store.get(continuityDigest(nativeThreadId));
  if (!record || record.legacyUnproven) return false;
  // Compression can have its own native turn, and a completed ordinary source can
  // still have unfinished compression on the same lineage. Select the lineage by
  // the actual request/current work, then stop only its unfinished members.
  const works = Object.values(record.works);
  const candidates = works.filter(work => nativeTurnId
    ? work.nativeTurnId === nativeTurnId : work.logicalWorkId === record.currentWorkId);
  const lineages = new Set<string>();
  for (const work of candidates) {
    if (lineages.has(work.workLineageId)) continue;
    const unfinished = works.find(value => value.workLineageId === work.workLineageId
      && !["completed", "stopped"].includes(value.state));
    if (!unfinished) continue;
    store.stopWork(record.thread, { scope: record.scope }, unfinished.logicalWorkId, reason);
    lineages.add(work.workLineageId);
  }
  return lineages.size > 0;
}

/** Native interrupt can retire a claimed first creation even when its pre-page runtime was discarded. */
export function cancelAbandonedContinuityCreation(
  directory: string | undefined,
  nativeThreadId: string,
  nativeTurnId: string,
): boolean {
  if (!directory) return false;
  const bindings = existingContinuityBindings(resolve(expandUserPath(directory)));
  const binding = bindings?.observed(continuityDigest(nativeThreadId));
  if (!bindings || !binding || binding.state !== "creating"
    || binding.initialNativeTurnId !== nativeTurnId || binding.lease) return false;
  chatGptTurnSessions.assertContinuityCanLeave(binding);
  bindings.end(binding);
  return true;
}

/** A real ordinary route selection ends continuity; inspection and auxiliary requests do not. */
export function leaveContinuityMode(directory: string | undefined, nativeThreadId: string | undefined): Promise<void> {
  if (!directory || !nativeThreadId) return Promise.resolve();
  const bindings = existingContinuityBindings(resolve(expandUserPath(directory)));
  const binding = bindings?.observed(continuityDigest(nativeThreadId));
  if (!bindings || !binding) {
    stopDurableContinuity(directory, nativeThreadId, undefined, "mode-exit");
    return Promise.resolve();
  }
  const previous = exits.get(binding);
  if (previous) return previous;
  // Check synchronously and end before the first await. A concurrent retained request can no
  // longer claim this page while another route waits for exact capability/page retirement.
  chatGptTurnSessions.assertContinuityCanLeave(binding);
  stopDurableContinuity(directory, nativeThreadId, undefined, "mode-exit");
  bindings.end(binding);
  const lease = binding.lease ? { ...binding.lease } : undefined;
  const conversation = binding.conversation;
  const retirement = Promise.resolve().then(async () => {
    await chatGptTurnSessions.detachContinuityBinding(binding);
    if (lease && conversation) {
      await releaseLauncherRetainedConversation(conversation.descriptor, conversation.key, undefined, lease);
    }
  }).catch(() => {
    throw continuityError("continuity_session_lost", "The old continuity owner could not be retired safely. Its task was not restarted.");
  });
  exits.set(binding, retirement);
  return retirement;
}
