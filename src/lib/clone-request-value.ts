import { types } from "node:util";

/**
 * Detach request containers without copying the backing storage of large strings.
 * The fast path is for JSON request data. If it encounters a non-plain prototype,
 * proxy or accessor, structuredClone handles cloning and errors for the whole graph.
 */
export function cloneRequestValue<T>(value: T): T {
  const copies = new Map<object, object>();
  const unsupported = Symbol();
  const copy = (input: unknown): unknown => {
    if (typeof input === "function" || typeof input === "symbol") throw unsupported;
    if (input === null || typeof input !== "object") return input;
    if (types.isProxy(input)) throw unsupported;
    const previous = copies.get(input);
    if (previous) return previous;
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw unsupported;
    const output = array ? new Array(input.length) : {};
    copies.set(input, output);
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in descriptor)) throw unsupported;
      Object.defineProperty(output, key, {
        value: copy(descriptor.value), enumerable: true, configurable: true, writable: true,
      });
    }
    return output;
  };
  try { return copy(value) as T; }
  catch { return structuredClone(value); }
}
