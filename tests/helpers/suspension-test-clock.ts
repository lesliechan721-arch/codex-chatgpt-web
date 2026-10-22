import { spyOn } from "bun:test";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../../src/adapters/chatgpt-web/suspension-clock";
import { controlledClock } from "./controlled-clock";

/** Keep the production suspension algorithm; isolate its state and external timer sources. */
export function suspensionTestClock() {
  const time = controlledClock({ intervals: true, abortSignals: true });
  const clock = new ChatGptSuspensionClock();
  const spies = [
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => clock.start()),
    spyOn(chatGptSuspensionClock, "tick").mockImplementation(now => clock.tick(now)),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(() => clock.suspendedMs()),
    spyOn(chatGptSuspensionClock, "recentSuspension").mockImplementation(() => clock.recentSuspension()),
  ];
  clock.start();
  let restored = false;
  return {
    ...time,
    sleep(milliseconds: number) {
      time.suspend(milliseconds);
      time.tick(0);
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const spy of spies.reverse()) spy.mockRestore();
      time.restore();
    },
  };
}
