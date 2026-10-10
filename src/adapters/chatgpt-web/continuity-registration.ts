import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { continuityError } from "./continuity-errors";
import { ContinuityRecoveryStore, withContinuityStorageLock } from "./continuity-recovery-store";

export const MAX_CONTINUITY_REGISTRATIONS = 10_000;
export const MAX_CONTINUITY_REGISTRATION_BYTES = 4 * 1024 * 1024;

export interface ContinuityRegistration {
  scope: string;
  owner: string;
  state: "entered" | "lost" | "ended";
  epoch?: number;
  transactionId?: string;
}

interface RegistrationDocument {
  version: 1;
  installation: string;
  entries: Record<string, ContinuityRegistration>;
}

const hash = /^[a-f0-9]{64}$/;
function invalid(reason: string): Error {
  return continuityError("continuity_configuration_conflict", reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}

/** Durable tombstones only. A registration is never a browser recovery credential. */
export class ContinuityRegistrationStore {
  private readonly marker: string;
  private readonly file: string;
  private readonly lock: string;

  constructor(readonly directory: string) {
    this.marker = join(directory, "initialized.json");
    this.file = join(directory, "threads.json");
    this.lock = join(directory, "write.lock");
  }

  /** Called by controlled setup/upgrade, never as a request-time recovery fallback. */
  initialize(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.exclusive(() => {
      if (existsSync(this.marker)) {
        this.read();
      } else {
        if (existsSync(this.file)) throw invalid("Continuity registration initialization is incomplete; refusing to replace it.");
        const installation = randomBytes(32).toString("hex");
        // Persist intent before registry creation; incomplete initialization cannot become empty.
        atomicWriteFile(this.marker, JSON.stringify({ version: 1, installation }), { durable: true });
        this.write({ version: 1, installation, entries: {} });
      }
    });
    // The public journal entry owns registration -> recovery locking and reads the
    // complete registry under that lock. A claim in this setup gap is included.
    new ContinuityRecoveryStore(this.directory).initialize();
  }

  get(thread: string): ContinuityRegistration | undefined {
    this.validateIdentity(thread);
    return this.read().entries[thread];
  }

  /** Cross-process serialization ensures two first requests cannot overwrite each other's entry. */
  claim(thread: string, scope: string, owner: string): ContinuityRegistration {
    for (const identity of [thread, scope, owner]) this.validateIdentity(identity);
    if (!existsSync(this.marker)) throw invalid("Continuity registration storage is not initialized; run setup or upgrade.");
    return this.exclusive(() => {
      const document = this.read();
      const existing = document.entries[thread];
      if (existing) return existing;
      if (Object.keys(document.entries).length >= MAX_CONTINUITY_REGISTRATIONS) {
        throw continuityError("continuity_resource_capacity", "Continuity registration capacity is 10,000 threads.");
      }
      const registration: ContinuityRegistration = { scope, owner, state: "entered" };
      document.entries[thread] = registration;
      this.write(document);
      return registration;
    });
  }

  finish(thread: string, owner: string, state: "lost" | "ended"): void {
    this.validateIdentity(thread);
    this.validateIdentity(owner);
    this.exclusive(() => {
      const document = this.read();
      const registration = document.entries[thread];
      if (!registration || registration.owner !== owner) throw invalid("Continuity registration owner does not match.");
      if (registration.state !== "entered") return;
      document.entries[thread] = { ...registration, state };
      this.write(document);
    });
  }

  /** Explicit coordination CAS. A changed owner alone never grants a new epoch. */
  compareAndSwap(
    thread: string,
    expected: { scope: string; owner: string; state: ContinuityRegistration["state"]; epoch?: number },
    next: { owner: string; state: ContinuityRegistration["state"]; epoch: number; transactionId?: string },
  ): ContinuityRegistration {
    for (const value of [thread, expected.scope, expected.owner, next.owner]) this.validateIdentity(value);
    if (!Number.isSafeInteger(next.epoch) || next.epoch < 0 || next.transactionId !== undefined && !hash.test(next.transactionId)) throw invalid("Continuity registration epoch or transaction is invalid.");
    return this.exclusive(() => {
      const document = this.read(); const current = document.entries[thread];
      if (!current || current.scope !== expected.scope || current.owner !== expected.owner || current.state !== expected.state
        || (current.epoch ?? 0) !== (expected.epoch ?? 0) || next.epoch < (current.epoch ?? 0)) throw invalid("Continuity registration compare-and-swap observation is stale.");
      // The journal is the authority for admission. Registration can only publish its exact
      // already persisted owner/epoch/transaction; a CAS cannot invent retirement evidence.
      return withContinuityStorageLock(join(this.directory, "recovery.write.lock"), () => {
        const recovery = new ContinuityRecoveryStore(this.directory).get(thread);
        if (!recovery || recovery.legacyUnproven || recovery.scope !== current.scope || recovery.owner.id !== next.owner
          || recovery.epoch !== next.epoch || next.transactionId !== undefined && recovery.transaction?.transactionId !== next.transactionId) throw invalid("Continuity registration takeover has no matching durable admission evidence.");
        const registration: ContinuityRegistration = { scope: current.scope, owner: next.owner, state: next.state, epoch: next.epoch,
          ...(next.transactionId ? { transactionId: next.transactionId } : {}) };
        document.entries[thread] = registration; this.write(document); return registration;
      });
    });
  }

  private read(): RegistrationDocument {
    if (!existsSync(this.marker)) throw invalid("Continuity registration storage is not initialized; run setup or upgrade.");
    try {
      const marker = this.readJson(this.marker, 1024);
      const document = this.readJson(this.file, MAX_CONTINUITY_REGISTRATION_BYTES);
      if (!object(marker) || Object.keys(marker).some(key => !["version", "installation", "recoveryVersion"].includes(key))
        || !["version", "installation"].every(key => Object.hasOwn(marker, key)) || marker.recoveryVersion !== undefined && marker.recoveryVersion !== 2
        || marker.version !== 1 || typeof marker.installation !== "string" || !hash.test(marker.installation)
        || !object(document) || !keys(document, ["version", "installation", "entries"])
        || document.version !== 1 || document.installation !== marker.installation || !object(document.entries)
        || Object.keys(document.entries).length > MAX_CONTINUITY_REGISTRATIONS) throw new Error("invalid format");
      for (const [thread, entry] of Object.entries(document.entries)) {
        if (!hash.test(thread) || !object(entry) || Object.keys(entry).some(key => !["scope", "owner", "state", "epoch", "transactionId"].includes(key))
          || !["scope", "owner", "state"].every(key => Object.hasOwn(entry, key))
          || typeof entry.scope !== "string" || !hash.test(entry.scope)
          || typeof entry.owner !== "string" || !hash.test(entry.owner)
          || !["entered", "lost", "ended"].includes(String(entry.state))
          || entry.epoch !== undefined && (!Number.isSafeInteger(entry.epoch) || Number(entry.epoch) < 0)
          || entry.transactionId !== undefined && (typeof entry.transactionId !== "string" || !hash.test(entry.transactionId))) throw new Error("invalid entry");
      }
      return document as unknown as RegistrationDocument;
    } catch {
      throw invalid("Continuity registration storage is missing, unreadable or invalid; it was not reset.");
    }
  }

  private readJson(path: string, maxBytes: number): unknown {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid registration file");
    const encoded = readFileSync(path);
    if (encoded.byteLength > maxBytes) throw new Error("oversized registration file");
    return JSON.parse(encoded.toString("utf8"));
  }

  private write(document: RegistrationDocument): void {
    const encoded = JSON.stringify(document);
    if (Buffer.byteLength(encoded) > MAX_CONTINUITY_REGISTRATION_BYTES) {
      throw continuityError("continuity_resource_capacity", "Continuity registration capacity is 4 MiB.");
    }
    try { atomicWriteFile(this.file, encoded, { durable: true }); }
    catch { throw invalid("Continuity registration could not be saved; no new page may be created."); }
  }

  private exclusive<T>(operation: () => T): T {
    return withContinuityStorageLock(this.lock, operation);
  }

  private validateIdentity(value: string): void {
    if (!hash.test(value)) throw invalid("Continuity registration identity is invalid.");
  }
}
