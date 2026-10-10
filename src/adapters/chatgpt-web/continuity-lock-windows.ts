import { win32 } from "node:path";

function loadMoveApi() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  return ffi.dlopen(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "kernel32.dll"), {
    MoveFileExW: { args: ["buffer", "buffer", "u32"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
}

let moveApi: ReturnType<typeof loadMoveApi> | undefined;

/** Publish a prepared lock without replacing any concurrently created entry. */
export function moveContinuityLockWithoutReplacement(source: string, destination: string): void {
  if (source.includes("\0") || destination.includes("\0")) throw new Error("Invalid continuity lock path");
  const from = Buffer.from(`${win32.toNamespacedPath(win32.resolve(source))}\0`, "utf16le");
  const to = Buffer.from(`${win32.toNamespacedPath(win32.resolve(destination))}\0`, "utf16le");
  // Load only on Windows. Node's rename uses MOVEFILE_REPLACE_EXISTING, which
  // can erase a legacy file lock that appears after the caller's inspection.
  const api = moveApi ??= loadMoveApi();
  if (api.symbols.MoveFileExW(from, to, 0) !== 0) return;
  const win32Error = api.symbols.GetLastError();
  const code = win32Error === 80 || win32Error === 183 ? "EEXIST"
    : win32Error === 5 ? "EACCES" : win32Error === 2 || win32Error === 3 ? "ENOENT"
    : win32Error === 32 ? "EBUSY" : "EIO";
  throw Object.assign(new Error(`MoveFileExW ${code} (${win32Error}): ${destination}`), {
    code, win32Error, syscall: "MoveFileExW", path: source, dest: destination,
  });
}
