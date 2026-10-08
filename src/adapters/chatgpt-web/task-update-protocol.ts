import type { ChatGptTurnCapability } from "./environment";
import type { BrokerToolResult } from "./turn-broker";

export const TASK_UPDATE_PROTOCOL_VERSION = 1;
export const TASK_UPDATE_LIMIT = 128;
export const TASK_UPDATE_TOTAL_BYTES = 1_024 * 1_024;
export const TASK_UPDATE_TRANSFER_LIMIT = 128;
export const TASK_UPDATE_DELIVERY_LIMIT = 128;
export const TASK_UPDATE_BATCH_LIMIT_BYTES = 32 * 1_024 * 1_024;

export interface TaskUpdateOwnerContext {
  expectedDriverGeneration: number;
  taskRevision: number;
  /** Final candidates retain the ACK head observed with their first text projection. */
  acknowledgedRevision?: number;
}

export interface TaskUpdateRegistrationOptions { taskUpdateProtocol?: 1 }

export interface TaskUpdateState {
  /** Private, turn-scoped same-host ACK publications, supplied only to owner/helper control readers. */
  acknowledgementDirectory?: string;
  acceptedRevision: number;
  deliveredRevision: number;
  acknowledgedRevision: number;
  driverGeneration: number;
  finalOutputRevision: number | null;
}

export interface UserUpdate {
  revision: number;
  sourceMessageId: string;
  payloadDigest: string;
  content: string;
}

export interface UpdateDelivery {
  protocolVersion: 1;
  deliveryId: string;
  fromRevision: number;
  throughRevision: number;
  updates: UserUpdate[];
}
export type TaskUpdateDelivery = UpdateDelivery;

export interface TaskUpdateAckResult {
  acknowledgedRevision: number;
  acceptedRevision: number;
  taskUpdate?: UpdateDelivery;
  ignored?: "final_output_started";
}

export interface TaskUpdateTransfer {
  transferId: string;
  payloadDigest: string;
  expectedDriverGeneration: number;
  expectedRevision: number;
  environment: ChatGptTurnCapability;
  updates: UserUpdate[];
  results: { callId: string; result: BrokerToolResult }[];
  batchFingerprint: string;
  mode: "results" | "replay" | "continuity";
}

export type TaskUpdateTransferOutcome =
  | { status: "unknown"; transferId: string }
  | { status: "not_committed"; transferId: string; code: string; message: string }
  | { status: "committed"; transferId: string; state: TaskUpdateState; batchFingerprint: string };

export interface TaskOutputReceipt {
  taskRevision: number;
  driverGeneration: number;
  kind: "output_started" | "completed";
  fenceRevision?: number;
}

export function isTaskRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
