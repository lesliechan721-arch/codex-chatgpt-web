import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, resolve } from "node:path";

// Proof of completed I/O, never a cached read, owner check or execution permit.
// Recovery writers hold the storage lock while checking or publishing a proof.
// Bound memory across short-lived stores and temporary test installations.
const proofs = new Map<string, string>();
const MAX_PROOFS = 64;

function fileIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode, stat.uid].join(":");
}

function hasFileIdentity(stat: BigIntStats): boolean {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode, stat.uid]
    .every(value => typeof value === "bigint") && stat.ino > 0n;
}

function directoryIdentity(path: string): string | undefined {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory() || !hasFileIdentity(stat)) return undefined;
  // Lock creation changes directory mtime/ctime on every transaction.
  return [canonical, stat.dev, stat.ino, stat.birthtimeNs].join(":");
}

function proofOf(path: string, expected: string): string | undefined {
  let fd: number | undefined;
  try {
    const parent = directoryIdentity(dirname(path));
    if (!parent) return undefined;
    fd = openSync(path, "r");
    const before = fstatSync(fd, { bigint: true });
    const bytes = Buffer.from(expected);
    if (!before.isFile() || !hasFileIdentity(before) || before.size !== BigInt(bytes.length)) return undefined;
    const actual = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!actual.equals(bytes) || !named.isFile() || fileIdentity(before) !== fileIdentity(after)
      || fileIdentity(after) !== fileIdentity(named) || parent !== directoryIdentity(dirname(path))) return undefined;
    return `${parent}:${fileIdentity(after)}:${createHash("sha256").update(actual).digest("hex")}`;
  } catch {
    // Missing or unreliable file identity disables this optimization.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* A diagnostic proof must not change the commit result. */ }
    }
  }
}

export function forgetRecoveryDurability(path: string): void {
  proofs.delete(resolve(path));
}

/** Call only after the complete file/rename/directory commit has succeeded. */
export function rememberRecoveryDurability(path: string, encoded: string): void {
  const key = resolve(path);
  proofs.delete(key);
  const proof = proofOf(path, encoded);
  if (!proof) return;
  if (proofs.size >= MAX_PROOFS) proofs.delete(proofs.keys().next().value!);
  proofs.set(key, proof);
}

/** The caller must first freshly validate the document and its authority guard. */
export function reuseRecoveryDurability(path: string, encoded: string): boolean {
  const key = resolve(path);
  const known = proofs.get(key);
  if (known && proofOf(path, encoded) === known) return true;
  proofs.delete(key);
  return false;
}
