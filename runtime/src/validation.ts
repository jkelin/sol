import { isObject, isPromiseLike } from "./reactivity.ts";

export interface StandardSchema<TInput, TOutput> {
  readonly "~standard": {
    readonly validate: (
      input: unknown,
    ) =>
      | { readonly value: TOutput; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] }
      | PromiseLike<
          | { readonly value: TOutput; readonly issues?: undefined }
          | { readonly issues: readonly unknown[] }
        >;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export type Parser<TInput, TOutput> =
  | ((input: TInput) => TOutput | PromiseLike<TOutput>)
  | { parse(input: TInput): TOutput; parseAsync?: never }
  | { parseAsync(input: TInput): PromiseLike<TOutput>; parse?: (input: TInput) => TOutput }
  | StandardSchema<TInput, TOutput>;

function isStandardSchema<TInput, TOutput>(
  schema: Parser<TInput, TOutput>,
): schema is StandardSchema<TInput, TOutput> {
  if (!isObject(schema) || !("~standard" in schema)) return false;
  const standard = (schema as { "~standard"?: unknown })["~standard"];
  return isObject(standard) && typeof (standard as { validate?: unknown }).validate === "function";
}

export function hasParser(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (isObject(value) &&
      (typeof (value as { parse?: unknown }).parse === "function" ||
        typeof (value as { parseAsync?: unknown }).parseAsync === "function" ||
        ("~standard" in value &&
          isObject((value as { "~standard"?: unknown })["~standard"]) &&
          typeof (value as { "~standard": { validate?: unknown } })["~standard"].validate ===
            "function")))
  );
}

function standardOutput<T>(
  result: { readonly value: T } | { readonly issues: readonly unknown[] },
): T {
  if (!isObject(result) || Array.isArray(result)) {
    throw new TypeError("Standard Schema returned an invalid result");
  }
  const issues = Object.getOwnPropertyDescriptor(result, "issues");
  if (issues && !("value" in issues)) {
    throw new TypeError("Standard Schema result fields must be data properties");
  }
  if (issues && issues.value !== undefined) {
    if (!Array.isArray(issues.value)) {
      throw new TypeError("Standard Schema returned invalid issues");
    }
    throw { issues: issues.value };
  }
  const value = Object.getOwnPropertyDescriptor(result, "value");
  if (!value || !("value" in value)) {
    throw new TypeError("Standard Schema result must contain a value data property");
  }
  return value.value as T;
}

export function parseValue<TInput, TOutput>(
  schema: Parser<TInput, TOutput>,
  input: TInput,
): TOutput | PromiseLike<TOutput> {
  if (typeof schema === "function") return schema(input);
  if (isStandardSchema(schema)) {
    const result = schema["~standard"].validate(input);
    return isPromiseLike(result)
      ? Promise.resolve(result).then(standardOutput<TOutput>)
      : standardOutput(result);
  }
  if (typeof schema.parseAsync === "function") return schema.parseAsync(input);
  return schema.parse(input);
}
