export interface TaskInputIdentity { thread: string; scope: string; taskId: string }
export interface SavedTaskInput {
  messageId: string; digest: string; bytes: number; receivedSequence: number;
  status: "reserved" | "accepted" | "stopped" | "discarded" | "completed";
  payload: "reserved" | "ready" | "missing" | "released";
  intentGeneration: number; deliveryIds: string[];
}
export interface SavedTask extends TaskInputIdentity {
  version: number; intentGeneration: number; receivedSequence: number;
  state: "active" | "stopped" | "completed";
  messages: SavedTaskInput[];
  deliveries: { deliveryId: string; cancelled?: true; acknowledgedMessageIds: string[] }[];
  waitReason?: "manual-send" | "observer" | "compaction" | "recovery";
}
export interface TaskInputsSnapshot {
  tasks: SavedTask[];
  usage: { tasks: number; pendingMessages: number; pendingBytes: number; bodyBytes: number; reservedBytes: number;
    globalUsedBytes?: number; globalLimitBytes?: number };
  recoveryLimitBytes: number;
}
interface Mutation {
  identity: TaskInputIdentity; expectedVersion: number; expectedIntentGeneration: number;
}
export type TaskInputRequest = { action: "snapshot" }
  | { action: "read" | "copy"; identity: TaskInputIdentity; messageId: string }
  | Mutation & ({ action: "retry"; messageIds: string[] } | { action: "discard"; messageId: string }
    | { action: "repair"; messageId: string; text: string } | { action: "cleanup" | "delete-task" });
export type TaskInputResult = { ok: true; value: unknown } | { ok: false; code: string; receiveStatus?: "unknown" };
export interface TaskInputsApi { taskInputs(request: TaskInputRequest): Promise<TaskInputResult> }
