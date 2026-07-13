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
  if ("issues" in result) throw { issues: [...result.issues] };
  return result.value;
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
