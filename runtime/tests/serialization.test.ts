import { describe, expect, test } from "bun:test";
import { deserializeGraph, serializeGraph } from "../src/serialization.ts";

function encodedGraph(object: unknown, root: unknown = null): string {
  return JSON.stringify({ root, objects: [object] });
}

describe("SSR graph serialization", () => {
  test("round trips cycles, aliases, sparse arrays, and null prototypes", () => {
    const shared = { label: "shared" };
    const sparse: unknown[] = [];
    sparse.length = 4;
    sparse[1] = undefined;
    sparse[3] = shared;
    const nullObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullObject, "__proto__", {
      value: "safe",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const value: Record<string, unknown> = { shared, alias: shared, sparse, nullObject };
    value.self = value;

    const restored = deserializeGraph(serializeGraph(value)) as typeof value;
    expect(restored.self).toBe(restored);
    expect(restored.shared).toBe(restored.alias);
    expect(0 in (restored.sparse as unknown[])).toBe(false);
    expect(1 in (restored.sparse as unknown[])).toBe(true);
    expect(Object.getPrototypeOf(restored.nullObject)).toBeNull();
    expect((restored.nullObject as Record<string, unknown>).__proto__).toBe("safe");
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });

  test("round trips supported scalar and built-in values", () => {
    const expression = /sol/giu;
    expression.lastIndex = 1.5;
    const error = new TypeError("failed", { cause: { code: 42 } });
    const values = {
      undefined,
      nan: NaN,
      infinity: Infinity,
      negativeInfinity: -Infinity,
      negativeZero: -0,
      bigint: 12345678901234567890n,
      date: new Date("2026-07-14T00:00:00.000Z"),
      invalidDate: new Date(NaN),
      expression,
      url: new URL("https://example.com/path?q=1"),
      map: new Map<unknown, unknown>([[{ key: true }, new Set([1, 2])]]),
      error,
    };
    const serialized = serializeGraph(values);
    expect(serialized).not.toContain(error.stack ?? "__missing_stack__");
    const restored = deserializeGraph(serialized) as typeof values;
    expect(restored.undefined).toBeUndefined();
    expect(Number.isNaN(restored.nan)).toBe(true);
    expect(restored.infinity).toBe(Infinity);
    expect(restored.negativeInfinity).toBe(-Infinity);
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
    expect(restored.bigint).toBe(values.bigint);
    expect(restored.date.toISOString()).toBe(values.date.toISOString());
    expect(Number.isNaN(restored.invalidDate.getTime())).toBe(true);
    expect(restored.expression.source).toBe("sol");
    expect(restored.expression.flags).toBe("giu");
    expect(restored.expression.lastIndex).toBe(1.5);
    expect(restored.url.href).toBe(values.url.href);
    expect([...(restored.map.values().next().value as Set<number>)]).toEqual([1, 2]);
    expect(restored.error).toBeInstanceOf(Error);
    expect(restored.error).toBeInstanceOf(TypeError);
    expect(restored.error.name).toBe("TypeError");
    expect(restored.error.message).toBe("failed");
    expect(restored.error.cause).toEqual({ code: 42 });
  });

  test("preserves every supported built-in Error prototype and custom name", () => {
    const constructors = [
      Error,
      EvalError,
      RangeError,
      ReferenceError,
      SyntaxError,
      TypeError,
      URIError,
    ];
    for (const Constructor of constructors) {
      const error = new Constructor("failure");
      error.name = "AuthoredName";
      const restored = deserializeGraph(serializeGraph(error));
      expect(restored).toBeInstanceOf(Constructor);
      expect((restored as Error).name).toBe("AuthoredName");
    }
  });

  test("escapes script-closing and Unicode separator data", () => {
    const serialized = serializeGraph("</script><script>&\u2028\u2029");
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("&");
    expect(deserializeGraph(serialized)).toBe("</script><script>&\u2028\u2029");
  });

  test("rejects executable and custom-prototype values", () => {
    class Custom {
      value = 1;
    }
    expect(() => serializeGraph(() => undefined)).toThrow("function");
    expect(() => serializeGraph(Symbol("value"))).toThrow("symbol");
    expect(() => serializeGraph(new Custom())).toThrow("custom-prototype");
    expect(() => serializeGraph(new Uint8Array([1]))).toThrow("typed buffer");
  });

  test("rejects accessors, symbol keys, and custom array properties", () => {
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const symbolKey = { [Symbol("key")]: true };
    const array = [1] as unknown[] & { extra?: boolean };
    array.extra = true;
    const numericCustom = [1];
    Object.defineProperty(numericCustom, "4294967295", { enumerable: true, value: 2 });
    expect(() => serializeGraph(accessor)).toThrow("accessor");
    expect(() => serializeGraph(symbolKey)).toThrow("symbol-keyed");
    expect(() => serializeGraph(array)).toThrow("custom properties");
    expect(() => serializeGraph(numericCustom)).toThrow("custom properties");
  });

  test("rejects plain-object descriptors that cannot round trip", () => {
    for (const descriptor of [
      { value: 1, enumerable: false, configurable: true, writable: true },
      { value: 1, enumerable: true, configurable: false, writable: true },
      { value: 1, enumerable: true, configurable: true, writable: false },
    ]) {
      const value = Object.defineProperty({}, "field", descriptor);
      expect(() => serializeGraph(value)).toThrow("property descriptor");
    }
  });

  test("rejects array index descriptors that cannot round trip", () => {
    const frozen = Object.freeze([1]);
    const frozenEmpty = Object.freeze([]);
    const hidden = Object.defineProperty([1], "0", { enumerable: false });
    expect(() => serializeGraph(frozen)).toThrow("property descriptor");
    expect(() => serializeGraph(frozenEmpty)).toThrow("property descriptor");
    expect(() => serializeGraph(hidden)).toThrow("property descriptor");
  });

  test("rejects symbol keys on every supported built-in", () => {
    const values: object[] = [
      new Date(),
      /value/g,
      new URL("https://example.com"),
      new Map(),
      new Set(),
      new Error("failure"),
    ];
    for (const value of values) {
      Object.defineProperty(value, Symbol("custom"), { value: true });
      expect(() => serializeGraph(value)).toThrow("symbol-keyed");
    }
  });

  test("rejects built-in state that cannot round trip", () => {
    const values: object[] = [
      new Date(),
      /value/g,
      new URL("https://example.com"),
      new Map(),
      new Set(),
      new Error("failure"),
    ];
    for (const value of values) {
      Object.defineProperty(value, "custom", {
        configurable: true,
        enumerable: true,
        value: "lost",
        writable: true,
      });
      expect(() => serializeGraph(value)).toThrow("custom properties");
    }
    expect(() => serializeGraph(new AggregateError([new Error("nested")], "failure"))).toThrow(
      "custom-prototype",
    );
  });

  test("rejects non-enumerable accessors and subclassed built-ins", () => {
    const hiddenAccessor = {};
    Object.defineProperty(hiddenAccessor, "secret", { get: () => "hidden" });
    class CustomDate extends Date {}
    class CustomMap extends Map {}
    class CustomError extends Error {}
    class CustomArray<T> extends Array<T> {}

    expect(() => serializeGraph(hiddenAccessor)).toThrow("accessor");
    expect(() => serializeGraph(new CustomDate())).toThrow("custom-prototype");
    expect(() => serializeGraph(new CustomMap())).toThrow("custom-prototype");
    expect(() => serializeGraph(new CustomError("custom"))).toThrow("custom-prototype");
    expect(() => serializeGraph(new CustomArray(1, 2))).toThrow("custom-prototype");
  });

  test("rejects accessor Error causes without invoking them", () => {
    const error = new Error("failure");
    let invoked = false;
    Object.defineProperty(error, "cause", {
      get() {
        invoked = true;
        return "cause";
      },
    });

    expect(() => serializeGraph(error)).toThrow("accessor");
    expect(invoked).toBe(false);
  });

  test("rejects malformed graphs and references", () => {
    expect(() => deserializeGraph("{")).toThrow("payload JSON");
    expect(() => deserializeGraph("{}")).toThrow("payload graph");
    expect(() =>
      deserializeGraph(JSON.stringify({ root: { $: "ref", v: 2 }, objects: [] })),
    ).toThrow("reference");
    expect(() => deserializeGraph(JSON.stringify({ root: { $: "mystery" }, objects: [] }))).toThrow(
      "value tag",
    );
  });

  test("validates every record field, including unreachable records", () => {
    expect(() => deserializeGraph(encodedGraph({ type: "array", length: -1, values: [] }))).toThrow(
      "array length",
    );
    expect(() =>
      deserializeGraph(encodedGraph({ type: "array", length: 1, values: [[1, null]] })),
    ).toThrow("array position");
    expect(() => deserializeGraph(encodedGraph({ type: "date" }))).toThrow("Date value");
    expect(() =>
      deserializeGraph(encodedGraph({ type: "regexp", source: "[", flags: "", lastIndex: 0 })),
    ).toThrow("invalid RegExp");
    expect(() =>
      deserializeGraph(
        encodedGraph({ type: "regexp", source: "valid", flags: "g", lastIndex: "bad" }),
      ),
    ).toThrow("RegExp lastIndex is not a number");
    expect(() => deserializeGraph(encodedGraph({ type: "url", value: "not a URL" }))).toThrow(
      "invalid URL",
    );
    expect(() =>
      deserializeGraph(encodedGraph({ type: "map", values: [[{ $: "ref", v: 4 }, null]] })),
    ).toThrow("invalid reference");
    expect(() =>
      deserializeGraph(
        JSON.stringify({
          root: null,
          objects: [{ type: "set", values: [{ $: "unknown" }] }],
        }),
      ),
    ).toThrow("unknown value tag");
    expect(() =>
      deserializeGraph(
        encodedGraph({
          type: "error",
          kind: "AggregateError",
          name: "Error",
          message: "failure",
        }),
      ),
    ).toThrow("invalid Error fields");
  });
});
