import { chmodSync, closeSync } from "node:fs";
import type { Server } from "node:net";
import { getSystemErrorName } from "node:util";

function loadSocketApi() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Safe Unix broker listeners require macOS or Linux");
  }
  // Load lazily: Windows named pipes must not load a Unix FFI library.
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const darwin = process.platform === "darwin";
  const errnoSymbol = darwin ? "__error" : "__errno_location";
  const library = ffi.dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    bind: { args: ["i32", "buffer", "u32"], returns: "i32" },
    ioctl: { args: ["i32", "u64"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  });
  const errnoAddress = library.symbols[errnoSymbol] as () => import("bun:ffi").Pointer;
  return {
    library,
    failure(syscall: string, path: string): Error {
      const errno = ffi.read.i32(errnoAddress());
      const code = getSystemErrorName(-errno);
      return Object.assign(new Error(`${syscall} ${code}: ${path}`), { code, errno: -errno, syscall, path });
    },
  };
}

let socketApi: ReturnType<typeof loadSocketApi> | undefined;

/** Adopt a bound fd so Bun never owns a pathname to unlink, including during VM teardown. */
export function listenOnUnixBrokerSocket(server: Server, path: string, onListening: () => void): void {
  const encoded = Buffer.from(path);
  if (encoded.length > 103 || encoded.includes(0)) throw new Error("Invalid Unix broker listener path");
  const address = Buffer.alloc(2 + encoded.length + 1);
  // sockaddr_un uses a native-endian sa_family_t on Linux, and sun_len/sun_family on macOS.
  Buffer.from(new Uint16Array([1]).buffer).copy(address); // AF_UNIX
  if (process.platform === "darwin") {
    address[0] = address.length;
    address[1] = 1;
  }
  encoded.copy(address, 2);
  const api = socketApi ??= loadSocketApi();
  const { socket, bind, ioctl } = api.library.symbols;
  const fd = socket(1, 1, 0); // AF_UNIX, SOCK_STREAM
  if (fd < 0) throw api.failure("socket", path);
  let adopted = false;
  try {
    // FIOCLEX takes no variadic argument. Unlike fcntl(F_SETFD, flags), this is safe to call
    // through a fixed-argument FFI signature on macOS arm64 as well as Linux.
    if (ioctl(fd, process.platform === "darwin" ? 0x20006601 : 0x5451) < 0) throw api.failure("ioctl", path);
    if (bind(fd, address, address.length) < 0) throw api.failure("bind", path);
    chmodSync(path, 0o600);
    // Bun 1.4 adopts this fd synchronously. On failure it leaves the fd with the caller.
    // Do not fall back to listen(path): that restores Bun's pathname-based unlink race.
    server.listen({ fd, exclusive: true }, onListening);
    adopted = server.listening;
  } finally {
    if (!adopted) closeSync(fd);
  }
}
