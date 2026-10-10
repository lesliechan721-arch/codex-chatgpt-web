import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskRevision, type TaskUpdateState } from "./task-update-protocol";

export function createTaskOutputControlSource(): string {
  const directory = mkdtempSync(join(tmpdir(), "cgw-task-ack-"));
  try {
    publishTaskOutputVersion(directory, 0, 0);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Readers see one complete version pair. Continuity reconciles publication after durable acceptance. */
export function publishTaskOutputVersion(directory: string, acceptedRevision: number, driverGeneration: number): void {
  const pending = join(directory, "version.next");
  writeFileSync(pending, JSON.stringify({ acceptedRevision, driverGeneration }), { mode: 0o600 });
  renameSync(pending, join(directory, "version.json"));
}

/** Read before starting the DOM observation, never after it to upgrade an in-flight read. */
export function observedTaskOutputVersion(state: TaskUpdateState): Pick<TaskUpdateState, "acceptedRevision" | "driverGeneration"> {
  if (!state.acknowledgementDirectory) return state;
  const version = JSON.parse(readFileSync(join(state.acknowledgementDirectory, "version.json"), "utf8"));
  if (!version || !isTaskRevision(version.acceptedRevision) || !isTaskRevision(version.driverGeneration)
    || version.acceptedRevision < state.acceptedRevision || version.driverGeneration < state.driverGeneration
    || version.driverGeneration > version.acceptedRevision) throw new Error("Invalid task output version publication");
  return { acceptedRevision: version.acceptedRevision, driverGeneration: version.driverGeneration };
}

export function taskUpdateAckPath(directory: string, revision: number): string {
  return join(directory, `${revision}.ack`);
}

/**
 * Same-host owner/helper readers observe the Broker's immutable ACK publication synchronously.
 * The control-state mirror can lag behind a successful ACK RPC, so it is not negative evidence.
 * Read once with the first text projection; later transport must retain that result.
 */
export function observedTaskAcknowledgement(state: TaskUpdateState): number {
  if (!state.acknowledgementDirectory || state.acceptedRevision === 0) return state.acknowledgedRevision;
  const marker = statSync(taskUpdateAckPath(state.acknowledgementDirectory, state.acceptedRevision), { throwIfNoEntry: false });
  if (marker) {
    if (!marker.isFile() || marker.size !== 0) throw new Error("Invalid task update acknowledgment publication");
    return state.acceptedRevision;
  }
  // Distinguish a genuinely absent ACK from a lost publication source; the latter cannot prove
  // that text preceded ACK. Neither case may be repaired with a later mirrored snapshot.
  if (!statSync(state.acknowledgementDirectory).isDirectory()) throw new Error("Task update acknowledgment source is unavailable");
  if (state.acknowledgedRevision === state.acceptedRevision) throw new Error("Task update acknowledgment publication was lost");
  return Math.min(state.acknowledgedRevision, state.acceptedRevision - 1);
}
