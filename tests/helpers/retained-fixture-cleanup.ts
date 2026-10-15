import { spyOn } from "bun:test";
import * as launcherHost from "../../src/launcher-browser-host";
import { chatGptTurnSessions } from "../../src/adapters/chatgpt-web/turn-execution";
import { measureRuntimeAsync } from "../../src/runtime-performance";

/** Observe the actual release Promise, including fire-and-forget cancellation releases. */
export function retainedFixtureCleanup(descriptorPath: string) {
  const release = launcherHost.releaseLauncherRetainedConversation;
  const pending = new Set<Promise<number>>();
  const errors: unknown[] = [];
  const observed = spyOn(launcherHost, "releaseLauncherRetainedConversation").mockImplementation((...args) => {
    const result = measureRuntimeAsync("cleanup.release", () => release(...args));
    if (args[0] === descriptorPath) {
      pending.add(result);
      void result.then(() => pending.delete(result), error => { pending.delete(result); errors.push(error); });
    }
    return result;
  });
  let disposed = false;
  return async (conversationKeys: Iterable<string>) => {
    if (disposed) return;
    disposed = true;
    const keys = [...new Set(conversationKeys)];
    const collect = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    };
    try {
      collect(await Promise.allSettled(keys.map(key => chatGptTurnSessions.retireConversationAndWait(key))));
      chatGptTurnSessions.clear();
      // clear() tracks physical/logical settlement separately from page release.
      collect(await Promise.allSettled(keys.map(key => chatGptTurnSessions.waitForConversationRetirement(key))));
      while (pending.size) await Promise.allSettled([...pending]);
    } finally {
      observed.mockRestore();
    }
    if (errors.length) throw new AggregateError(errors, "Retained fixture retirement failed");
  };
}
