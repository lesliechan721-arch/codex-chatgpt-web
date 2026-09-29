import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { continuityError } from "./continuity-errors";

export const MAX_CONTINUITY_REGISTRATIONS = 10_000;
export const MAX_CONTINUITY_REGISTRATION_BYTES = 4 * 1024 * 1024;

export interface ContinuityRegistration {
  scope: string;
  owner: string;
  state: "entered" | "lost" | "ended";
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

  constructor(private readonly directory: string) {
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
        return;
      }
      if (existsSync(this.file)) throw invalid("Continuity registration initialization is incomplete; refusing to replace it.");
      const installation = randomBytes(32).toString("hex");
      // Record the initialization intent first. A crash cannot turn a previously initialized
      // but absent registry into a silently empty installation on the next setup or request.
      atomicWriteFile(this.marker, JSON.stringify({ version: 1, installation }));
      this.write({ version: 1, installation, entries: {} });
    });
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

  private read(): RegistrationDocument {
    if (!existsSync(this.marker)) throw invalid("Continuity registration storage is not initialized; run setup or upgrade.");
    try {
      const marker = this.readJson(this.marker, 1024);
      const document = this.readJson(this.file, MAX_CONTINUITY_REGISTRATION_BYTES);
      if (!object(marker) || !keys(marker, ["version", "installation"])
        || marker.version !== 1 || typeof marker.installation !== "string" || !hash.test(marker.installation)
        || !object(document) || !keys(document, ["version", "installation", "entries"])
        || document.version !== 1 || document.installation !== marker.installation || !object(document.entries)
        || Object.keys(document.entries).length > MAX_CONTINUITY_REGISTRATIONS) throw new Error("invalid format");
      for (const [thread, entry] of Object.entries(document.entries)) {
        if (!hash.test(thread) || !object(entry) || !keys(entry, ["scope", "owner", "state"])
          || typeof entry.scope !== "string" || !hash.test(entry.scope)
          || typeof entry.owner !== "string" || !hash.test(entry.owner)
          || !["entered", "lost", "ended"].includes(String(entry.state))) throw new Error("invalid entry");
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
    try { atomicWriteFile(this.file, encoded); }
    catch { throw invalid("Continuity registration could not be saved; no new page may be created."); }
  }

  private exclusive<T>(operation: () => T): T {
    let descriptor: number;
    try { descriptor = openSync(this.lock, "wx", 0o600); }
    catch { throw invalid("Continuity registration storage is busy or not writable; no existing lock was removed."); }
    try { return operation(); }
    finally {
      closeSync(descriptor);
      unlinkSync(this.lock);
    }
  }

  private validateIdentity(value: string): void {
    if (!hash.test(value)) throw invalid("Continuity registration identity is invalid.");
  }
}
