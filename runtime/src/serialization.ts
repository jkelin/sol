type EncodedPrimitive = null | boolean | string | number;

type EncodedValue = EncodedPrimitive | { readonly $: string; readonly v?: unknown };

interface EncodedGraph {
  readonly root: EncodedValue;
  readonly objects: readonly EncodedObject[];
}

type EncodedObject =
  | {
      readonly type: "array";
      readonly length: number;
      readonly values: readonly [number, EncodedValue][];
    }
  | { readonly type: "object" | "null-object"; readonly values: readonly [string, EncodedValue][] }
  | { readonly type: "date"; readonly value: EncodedValue }
  | {
      readonly type: "regexp";
      readonly source: string;
      readonly flags: string;
      readonly lastIndex: EncodedValue;
    }
  | { readonly type: "url"; readonly value: string }
  | { readonly type: "map"; readonly values: readonly [EncodedValue, EncodedValue][] }
  | { readonly type: "set"; readonly values: readonly EncodedValue[] }
  | {
      readonly type: "error";
      readonly name: string;
      readonly message: string;
      readonly cause?: EncodedValue;
    };

function unsupported(value: unknown, detail: string): never {
  const type = value === null ? "null" : typeof value;
  throw new TypeError(`Cannot serialize ${detail} (${type})`);
}

export function arrayIndex(key: string, length: number): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  const index = Number(key);
  return index < length && index < 0xffffffff ? index : undefined;
}

function rejectAccessors(value: object): void {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      unsupported(value, `accessor property ${JSON.stringify(key)}`);
    }
  }
}

function ownDataEntries(value: object): [string, unknown][] {
  rejectAccessors(value);
  return Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
      unsupported(value, `non-default property descriptor ${JSON.stringify(key)}`);
    }
    return [key, descriptor.value];
  });
}

function isBuiltInError(value: Error): boolean {
  const prototypes = [
    Error.prototype,
    EvalError.prototype,
    RangeError.prototype,
    ReferenceError.prototype,
    SyntaxError.prototype,
    TypeError.prototype,
    URIError.prototype,
    ...(typeof AggregateError === "undefined" ? [] : [AggregateError.prototype]),
  ];
  return prototypes.includes(Object.getPrototypeOf(value) as Error);
}

export function serializeGraph(value: unknown): string {
  const references = new Map<object, number>();
  const objects: EncodedObject[] = [];
  const encode = (candidate: unknown): EncodedValue => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (Number.isNaN(candidate)) return { $: "nan" };
      if (candidate === Infinity) return { $: "infinity" };
      if (candidate === -Infinity) return { $: "-infinity" };
      if (Object.is(candidate, -0)) return { $: "-0" };
      return candidate;
    }
    if (candidate === undefined) return { $: "undefined" };
    if (typeof candidate === "bigint") return { $: "bigint", v: String(candidate) };
    if (typeof candidate === "function") return unsupported(candidate, "function data");
    if (typeof candidate === "symbol") return unsupported(candidate, "symbol data");
    if (typeof candidate !== "object") return unsupported(candidate, "data");
    if (Object.getOwnPropertySymbols(candidate).length > 0) {
      return unsupported(candidate, "symbol-keyed data");
    }

    const existing = references.get(candidate);
    if (existing !== undefined) return { $: "ref", v: existing };
    const index = objects.length;
    references.set(candidate, index);
    objects.push(undefined as never);
    rejectAccessors(candidate);

    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      const values: [number, EncodedValue][] = [];
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
        if (key === "length") {
          if (!descriptor.writable || descriptor.enumerable || descriptor.configurable) {
            unsupported(candidate, `non-default property descriptor ${JSON.stringify(key)}`);
          }
          continue;
        }
        const position = arrayIndex(key, candidate.length);
        if (position === undefined) unsupported(candidate, "array with custom properties");
        if (!descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
          unsupported(candidate, `non-default property descriptor ${JSON.stringify(key)}`);
        }
        values.push([position, encode(descriptor.value)]);
      }
      objects[index] = { type: "array", length: candidate.length, values };
    } else if (candidate instanceof Date) {
      if (Object.getPrototypeOf(candidate) !== Date.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = { type: "date", value: encode(candidate.getTime()) };
    } else if (candidate instanceof RegExp) {
      if (Object.getPrototypeOf(candidate) !== RegExp.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = {
        type: "regexp",
        source: candidate.source,
        flags: candidate.flags,
        lastIndex: encode(candidate.lastIndex),
      };
    } else if (typeof URL !== "undefined" && candidate instanceof URL) {
      if (Object.getPrototypeOf(candidate) !== URL.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = { type: "url", value: candidate.href };
    } else if (candidate instanceof Map) {
      if (Object.getPrototypeOf(candidate) !== Map.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = {
        type: "map",
        values: [...candidate].map(([key, entry]) => [encode(key), encode(entry)]),
      };
    } else if (candidate instanceof Set) {
      if (Object.getPrototypeOf(candidate) !== Set.prototype) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = { type: "set", values: [...candidate].map(encode) };
    } else if (candidate instanceof Error) {
      if (!isBuiltInError(candidate)) return unsupported(candidate, "custom-prototype data");
      const cause = Object.getOwnPropertyDescriptor(candidate, "cause");
      objects[index] = {
        type: "error",
        name: candidate.name,
        message: candidate.message,
        ...(cause ? { cause: encode(cause.value) } : {}),
      };
    } else {
      if (ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
        return unsupported(candidate, "typed buffer data");
      }
      if (typeof Node !== "undefined" && candidate instanceof Node) {
        return unsupported(candidate, "DOM node data");
      }
      const prototype = Object.getPrototypeOf(candidate) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        return unsupported(candidate, "custom-prototype data");
      }
      objects[index] = {
        type: prototype === null ? "null-object" : "object",
        values: ownDataEntries(candidate).map(([key, entry]) => [key, encode(entry)]),
      };
    }
    return { $: "ref", v: index };
  };

  return JSON.stringify({ root: encode(value), objects } satisfies EncodedGraph)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function invalidPayload(detail: string): never {
  throw new TypeError(`Invalid Sol hydration payload: ${detail}`);
}

function payloadRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidPayload(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) invalidPayload(`${path} contains unexpected property ${unexpected}`);
}

function validateEncodedValue(value: unknown, objectCount: number, path: string): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return;
  }
  const encoded = payloadRecord(value, path);
  validateKeys(encoded, ["$", "v"], path);
  if (typeof encoded.$ !== "string") invalidPayload(`${path} is missing a value tag`);
  if (["undefined", "nan", "infinity", "-infinity", "-0"].includes(encoded.$)) {
    if (Object.prototype.hasOwnProperty.call(encoded, "v")) {
      invalidPayload(`${path} tag ${encoded.$} cannot contain a value`);
    }
    return;
  }
  if (encoded.$ === "bigint") {
    if (typeof encoded.v !== "string") invalidPayload(`${path} bigint must contain a string`);
    try {
      BigInt(encoded.v);
    } catch {
      invalidPayload(`${path} contains an invalid bigint`);
    }
    return;
  }
  if (encoded.$ === "ref") {
    if (
      !Number.isInteger(encoded.v) ||
      (encoded.v as number) < 0 ||
      (encoded.v as number) >= objectCount
    ) {
      invalidPayload(`${path} contains an invalid reference`);
    }
    return;
  }
  invalidPayload(`${path} contains unknown value tag ${encoded.$}`);
}

function payloadTuples(value: unknown, path: string): unknown[][] {
  if (!Array.isArray(value)) invalidPayload(`${path} must be an array`);
  for (const [index, tuple] of value.entries()) {
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      invalidPayload(`${path}[${index}] must be a pair`);
    }
  }
  return value as unknown[][];
}

function validateEncodedObject(value: unknown, objectCount: number, index: number): void {
  const path = `object ${index}`;
  const object = payloadRecord(value, path);
  if (typeof object.type !== "string") invalidPayload(`${path} is missing a type`);
  switch (object.type) {
    case "array": {
      validateKeys(object, ["type", "length", "values"], path);
      if (
        !Number.isInteger(object.length) ||
        (object.length as number) < 0 ||
        (object.length as number) > 0xffff_ffff
      ) {
        invalidPayload(`${path} has an invalid array length`);
      }
      const positions = new Set<number>();
      for (const [tupleIndex, tuple] of payloadTuples(object.values, `${path}.values`).entries()) {
        const [position, entry] = tuple;
        if (
          !Number.isInteger(position) ||
          (position as number) < 0 ||
          (position as number) >= (object.length as number) ||
          positions.has(position as number)
        ) {
          invalidPayload(`${path}.values[${tupleIndex}] has an invalid array position`);
        }
        positions.add(position as number);
        validateEncodedValue(entry, objectCount, `${path}.values[${tupleIndex}][1]`);
      }
      return;
    }
    case "object":
    case "null-object":
      validateKeys(object, ["type", "values"], path);
      for (const [tupleIndex, tuple] of payloadTuples(object.values, `${path}.values`).entries()) {
        if (typeof tuple[0] !== "string") {
          invalidPayload(`${path}.values[${tupleIndex}] has a non-string key`);
        }
        validateEncodedValue(tuple[1], objectCount, `${path}.values[${tupleIndex}][1]`);
      }
      return;
    case "date":
      validateKeys(object, ["type", "value"], path);
      if (!Object.prototype.hasOwnProperty.call(object, "value")) {
        invalidPayload(`${path} is missing its Date value`);
      }
      validateEncodedValue(object.value, objectCount, `${path}.value`);
      return;
    case "regexp":
      validateKeys(object, ["type", "source", "flags", "lastIndex"], path);
      if (typeof object.source !== "string" || typeof object.flags !== "string") {
        invalidPayload(`${path} has invalid RegExp fields`);
      }
      validateEncodedValue(object.lastIndex, objectCount, `${path}.lastIndex`);
      try {
        RegExp(object.source, object.flags);
      } catch {
        invalidPayload(`${path} contains an invalid RegExp`);
      }
      return;
    case "url":
      validateKeys(object, ["type", "value"], path);
      if (typeof object.value !== "string") invalidPayload(`${path} has an invalid URL value`);
      try {
        const parsed = new URL(object.value);
        void parsed;
      } catch {
        invalidPayload(`${path} contains an invalid URL`);
      }
      return;
    case "map":
      validateKeys(object, ["type", "values"], path);
      for (const [tupleIndex, tuple] of payloadTuples(object.values, `${path}.values`).entries()) {
        validateEncodedValue(tuple[0], objectCount, `${path}.values[${tupleIndex}][0]`);
        validateEncodedValue(tuple[1], objectCount, `${path}.values[${tupleIndex}][1]`);
      }
      return;
    case "set":
      validateKeys(object, ["type", "values"], path);
      if (!Array.isArray(object.values)) invalidPayload(`${path}.values must be an array`);
      for (const [valueIndex, entry] of object.values.entries()) {
        validateEncodedValue(entry, objectCount, `${path}.values[${valueIndex}]`);
      }
      return;
    case "error":
      validateKeys(object, ["type", "name", "message", "cause"], path);
      if (typeof object.name !== "string" || typeof object.message !== "string") {
        invalidPayload(`${path} has invalid Error fields`);
      }
      if (Object.prototype.hasOwnProperty.call(object, "cause")) {
        validateEncodedValue(object.cause, objectCount, `${path}.cause`);
      }
      return;
    default:
      invalidPayload(`${path} has unknown type ${object.type}`);
  }
}

export function deserializeGraph(serialized: string): unknown {
  let graph: EncodedGraph;
  try {
    graph = JSON.parse(serialized) as EncodedGraph;
  } catch {
    throw new TypeError("Invalid Sol hydration payload JSON");
  }
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.objects) || !("root" in graph)) {
    throw new TypeError("Invalid Sol hydration payload graph");
  }
  validateKeys(graph as unknown as Record<string, unknown>, ["root", "objects"], "graph");

  validateEncodedValue(graph.root, graph.objects.length, "root");
  for (let index = 0; index < graph.objects.length; index += 1) {
    validateEncodedObject(graph.objects[index], graph.objects.length, index);
  }

  const decoded: unknown[] = Array.from({ length: graph.objects.length });
  for (let index = 0; index < graph.objects.length; index += 1) {
    const object = graph.objects[index];
    if (!object || typeof object !== "object" || typeof object.type !== "string") {
      throw new TypeError(`Invalid Sol hydration object ${index}`);
    }
    switch (object.type) {
      case "array":
        decoded[index] = [];
        (decoded[index] as unknown[]).length = object.length;
        break;
      case "object":
        decoded[index] = {};
        break;
      case "null-object":
        decoded[index] = Object.create(null) as object;
        break;
      case "date":
        decoded[index] = new Date(0);
        break;
      case "regexp":
        decoded[index] = new RegExp(object.source, object.flags);
        break;
      case "url":
        decoded[index] = new URL(object.value);
        break;
      case "map":
        decoded[index] = new Map();
        break;
      case "set":
        decoded[index] = new Set();
        break;
      case "error": {
        const error = new Error(object.message);
        error.name = object.name;
        decoded[index] = error;
        break;
      }
      default:
        throw new TypeError(`Invalid Sol hydration object type at ${index}`);
    }
  }

  const decode = (value: EncodedValue): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (typeof value.$ !== "string") throw new TypeError("Invalid Sol hydration value");
    switch (value.$) {
      case "undefined":
        return undefined;
      case "nan":
        return NaN;
      case "infinity":
        return Infinity;
      case "-infinity":
        return -Infinity;
      case "-0":
        return -0;
      case "bigint":
        return BigInt(String(value.v));
      case "ref": {
        const index = Number(value.v);
        if (!Number.isInteger(index) || index < 0 || index >= decoded.length) {
          throw new TypeError("Invalid Sol hydration reference");
        }
        return decoded[index];
      }
      default:
        throw new TypeError(`Invalid Sol hydration value tag ${value.$}`);
    }
  };

  for (let index = 0; index < graph.objects.length; index += 1) {
    const source = graph.objects[index]!;
    const target = decoded[index];
    switch (source.type) {
      case "array":
        for (const [position, value] of source.values)
          (target as unknown[])[position] = decode(value);
        break;
      case "object":
      case "null-object":
        for (const [key, value] of source.values) {
          Object.defineProperty(target, key, {
            value: decode(value),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        break;
      case "date":
        {
          const value = decode(source.value);
          if (typeof value !== "number")
            invalidPayload(`object ${index} Date value is not a number`);
          (target as Date).setTime(value);
        }
        break;
      case "regexp":
        {
          const lastIndex = decode(source.lastIndex);
          if (typeof lastIndex !== "number") {
            invalidPayload(`object ${index} RegExp lastIndex is not a number`);
          }
          (target as RegExp).lastIndex = lastIndex;
        }
        break;
      case "map":
        for (const [key, value] of source.values)
          (target as Map<unknown, unknown>).set(decode(key), decode(value));
        break;
      case "set":
        for (const value of source.values) (target as Set<unknown>).add(decode(value));
        break;
      case "error":
        if (source.cause !== undefined) {
          Object.defineProperty(target, "cause", {
            value: decode(source.cause),
            configurable: true,
          });
        }
        break;
      case "url":
        break;
    }
  }
  return decode(graph.root);
}
