/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

/** Internal scheduling dependency. Each turn owns the returned cleanup function. */
export type ChatGptWebHeartbeatScheduler = (callback: () => void, intervalMs: number) => () => void;

export const scheduleChatGptWebHeartbeat: ChatGptWebHeartbeatScheduler = (callback, intervalMs) => {
  const interval = setInterval(callback, intervalMs);
  return () => clearInterval(interval);
};
