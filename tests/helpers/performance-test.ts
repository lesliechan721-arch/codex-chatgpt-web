import { test as bunTest } from "bun:test";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { beginRuntimeAsyncMeasurement, markRuntimePerformanceIncomplete, runtimePerformanceEnabled, withRuntimePerformanceContext } from "../../src/runtime-performance";

interface StaticRow { values: unknown[] | null; argumentCount: number | null; index: number }
function staticRows(table: unknown[]): StaticRow[] {
  // Read data descriptors only. Do not serialize objects or invoke their getters.
  try {
    const descriptors = Object.getOwnPropertyDescriptors(table) as unknown as Record<string, PropertyDescriptor>;
    return Array.from({ length: descriptors.length!.value as number }, (_, index) => {
      const entry = descriptors[String(index)];
      if (!entry || !("value" in entry)) return { index, values: null, argumentCount: null };
      if (!Array.isArray(entry.value)) return { index, values: [entry.value], argumentCount: 1 };
      const fields = Object.getOwnPropertyDescriptors(entry.value) as unknown as Record<string, PropertyDescriptor>;
      const count = fields.length!.value as number;
      const values: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const field = fields[String(i)];
        if (!field || !("value" in field)) return { index, values: null, argumentCount: count };
        values.push(field.value);
      }
      return { index, values, argumentCount: count };
    });
  } catch { return []; }
}

/** Static test labels identify scenarios. Request bodies and temporary paths are never labels. */
export function performanceTest(file: string): typeof bunTest {
  if (!runtimePerformanceEnabled()) return bunTest;
  const path = relative(resolve(import.meta.dir, "../.."), file).replaceAll("\\", "/");
  const wrap = (register: Function, receiver: unknown = register, rows?: StaticRow[]): typeof bunTest => new Proxy(register, {
    apply(target, _receiver, args: unknown[]) {
      if (typeof args[0] !== "string" || typeof args[1] !== "function") {
        const value = Reflect.apply(target, receiver, args);
        return typeof value === "function" ? wrap(value, value, rows) : value;
      }
      const label = args[0];
      const action = args[1] as (...parameters: unknown[]) => unknown;
      const scenarioId = createHash("sha256").update(`${path}:${label}`).digest("hex");
      const rowIds = rows?.map(row => createHash("sha256").update(`${label}:row:${row.index}`).digest("hex"));
      const noParameters = createHash("sha256").update(`${label}:no-parameters`).digest("hex");
      const rowCounts = rows ? new Set(rows.map(row => row.argumentCount)) : undefined;
      const commonCount = rowCounts?.size === 1 ? rows?.[0]?.argumentCount : null;
      // Bun requires an ordinary function and uses its length to supply done.
      const measured = function(this: unknown, ...parameters: unknown[]) {
        const matches = (row: StaticRow, count: number) => row.values?.length === count
          && row.values.every((value, i) => Object.is(value, parameters[i]));
        // Prefer the complete parameter row. A function in a longer row is user data.
        const plainRow = rows?.find(row => matches(row, parameters.length));
        const callbackRow = !plainRow && typeof parameters.at(-1) === "function"
          ? rows?.find(row => row.argumentCount !== null && action.length > row.argumentCount && matches(row, parameters.length - 1)) : undefined;
        const row = plainRow ?? callbackRow;
        const parameterCount = rows ? row?.argumentCount ?? commonCount ?? parameters.length : 0;
        const done = action.length > parameterCount && parameters.length === parameterCount + 1
          && typeof parameters.at(-1) === "function" ? parameters.at(-1) as Function : undefined;
        if (rows && !row && commonCount == null && action.length > 0 && typeof parameters.at(-1) === "function") {
          markRuntimePerformanceIncomplete("unknown-callback-boundary");
        }
        return withRuntimePerformanceContext({ file: path, scenarioId,
          parameterId: rows ? row ? rowIds![row.index]! : null : noParameters, fixtureMode: null }, () => {
          const finish = beginRuntimeAsyncMeasurement("test.total");
          if (done) parameters[parameters.length - 1] = (...values: unknown[]) => {
            finish(Boolean(values[0]));
            return Reflect.apply(done, undefined, values);
          };
          try {
            const result = Reflect.apply(action, this, parameters);
            if (!done) {
              if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).then(() => finish(), () => finish(true));
              else finish();
            }
            return result;
          } catch (error) { finish(true); throw error; }
        });
      };
      Object.defineProperty(measured, "length", { value: action.length });
      args[1] = measured;
      return Reflect.apply(target, receiver, args);
    },
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "each") {
        return (table: unknown[]) => {
          const register = Reflect.apply(value, target, [table]) as Function;
          return wrap(register, register, staticRows(table));
        };
      }
      return wrap(value, target, rows);
    },
  }) as unknown as typeof bunTest;
  return wrap(bunTest);
}
