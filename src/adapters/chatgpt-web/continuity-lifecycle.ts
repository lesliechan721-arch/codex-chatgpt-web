import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import { continuityDigest, existingContinuityBindings, type ContinuityBinding } from "./continuity-binding";
import { continuityError } from "./continuity-errors";
import { chatGptTurnSessions } from "./turn-execution";

const exits = new WeakMap<ContinuityBinding, Promise<void>>();

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
  if (!bindings || !binding) return Promise.resolve();
  const previous = exits.get(binding);
  if (previous) return previous;
  // Check synchronously and end before the first await. A concurrent retained request can no
  // longer claim this page while another route waits for exact capability/page retirement.
  chatGptTurnSessions.assertContinuityCanLeave(binding);
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
