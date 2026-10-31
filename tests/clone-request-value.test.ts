import { expect, test } from "bun:test";
import { cloneRequestValue } from "../src/lib/clone-request-value";

test("request copies detach nested metadata and preserve JSON fields, holes and aliases", () => {
  const result = JSON.parse('{"type":"function_call_output","_meta":{"raw":"large result","__proto__":{"value":1}}}');
  const input = { results: [result, , result], missing: undefined, empty: null };
  const copy = cloneRequestValue(input);
  expect(copy).toEqual(structuredClone(input));
  expect(copy.results[0]).toBe(copy.results[2]);
  expect(1 in copy.results).toBe(false);
  expect(Object.hasOwn(copy, "missing")).toBe(true);
  expect(Object.hasOwn(copy.results[0]._meta, "__proto__")).toBe(true);
  input.results[0]._meta.raw = "changed source";
  copy.results[0]._meta.__proto__.value = 2;
  expect(copy.results[0]._meta.raw).toBe("large result");
  expect(input.results[0]._meta.__proto__.value).toBe(1);
  expect(Object.getPrototypeOf(copy.results[0]._meta)).toBe(Object.prototype);
});

test("request copies preserve cycles and normalize null prototypes like structuredClone", () => {
  const input = Object.assign(Object.create(null), { count: 1n, value: NaN });
  input.self = input;
  const copy = cloneRequestValue(input);
  expect(copy).toEqual(structuredClone(input));
  expect(copy.self).toBe(copy);
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
});

test("non-JSON request values use a whole-graph clone without losing cross-boundary aliases", () => {
  const shared = { text: "value" };
  const input = { shared, map: new Map([["shared", shared]]), date: new Date(0), bytes: new Uint8Array([1, 2]) };
  const copy = cloneRequestValue(input);
  expect(copy).toEqual(structuredClone(input));
  expect(copy.map.get("shared")).toBe(copy.shared);
  expect(copy.shared).not.toBe(shared);
  copy.bytes[0] = 3;
  expect(input.bytes[0]).toBe(1);
});

test("request copy fallback reads accessors once and keeps uncloneable values rejected", () => {
  let reads = 0;
  const input = { nested: { get value() { reads++; return { text: "value" }; } } };
  expect(cloneRequestValue(input)).toEqual({ nested: { value: { text: "value" } } });
  expect(reads).toBe(1);
  expect(() => cloneRequestValue({ callback() {} })).toThrow();
  expect(() => cloneRequestValue({ value: Symbol() })).toThrow();
  expect(() => cloneRequestValue(new Proxy({ value: 1 }, {}))).toThrow();
});
