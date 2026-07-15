import { isObject, isPromiseLike } from "./reactivity.ts";
import { deployedPath, logicalPathname } from "./route-base.ts";
import { arrayIndex } from "./serialization.ts";
import { hasParser, parseValue, type Parser } from "./validation.ts";

const ENDPOINT = Symbol.for("sol.server.endpoint");
const REQUEST_ERROR_STATUS = Symbol("sol.request.error.status");
const RPC_PREFIX = "/api/rpc/";
const RPC_CONTENT_TYPE = "application/json";
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type RpcName = string;
export type RpcArgs = readonly unknown[];

export interface RpcConfig<Input extends RpcArgs, Parsed extends RpcArgs> {
  readonly schema: Parser<Input, Parsed>;
}

export type RpcFunction<Input extends RpcArgs, Data> = (...args: Input) => Promise<Data>;

export interface HttpRouteInput {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpRouteConfig<Input extends HttpRouteInput, Parsed> {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly schema: Parser<Input, Parsed>;
  readonly body?: "auto" | "bytes";
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface HttpRouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
}

interface RpcEndpoint extends Function {
  readonly [ENDPOINT]: true;
  readonly kind: "query" | "mutation";
  readonly name: string;
  readonly method: "POST";
  readonly path: string;
  invoke(args: unknown): Promise<unknown>;
}

interface HttpEndpoint extends HttpRouteDefinition {
  readonly [ENDPOINT]: true;
  readonly kind: "http";
  readonly body: "auto" | "bytes";
  readonly compiled: CompiledHttpPath;
  invoke(input: HttpRouteInput, request: Request): Promise<Response>;
}

export type ServerEndpoint = RpcEndpoint | HttpEndpoint;

interface CompiledHttpPath {
  readonly pattern: RegExp;
  readonly parameterNames: readonly string[];
  readonly specificity: readonly number[];
}

export interface ServerDispatchOptions {
  readonly development?: boolean;
  readonly maxBodyBytes?: number;
}

const rpcMetadata = new WeakMap<
  Function,
  { readonly kind: "query" | "mutation"; readonly name: string }
>();

function validateSchema(schema: unknown, label: string): void {
  if (!hasParser(schema)) {
    throw new TypeError(
      `${label} schema must be callable, expose parse() or parseAsync(), or implement Standard Schema`,
    );
  }
}

function validateRpcName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new TypeError("RPC name must be a non-empty URL-safe segment");
  }
}

function validationError(error: unknown): error is { readonly issues: readonly unknown[] } {
  try {
    return isObject(error) && Array.isArray((error as { issues?: unknown }).issues);
  } catch {
    return false;
  }
}

function requestError(message: string, status: 400 | 413 | 415): TypeError {
  return Object.assign(new TypeError(message), { [REQUEST_ERROR_STATUS]: status });
}

function requestErrorStatus(error: unknown): 400 | 413 | 415 | undefined {
  try {
    if (!isObject(error)) return undefined;
    const status = (error as { [REQUEST_ERROR_STATUS]?: unknown })[REQUEST_ERROR_STATUS];
    return status === 400 || status === 413 || status === 415 ? status : undefined;
  } catch {
    return undefined;
  }
}

function serializeJson(value: unknown, label: string): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      return;
    }
    if (typeof item !== "object") {
      throw new TypeError(`${label} must contain only JSON-serializable values`);
    }
    if (ancestors.has(item)) {
      throw new TypeError(`${label} must not contain cyclic values`);
    }
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only JSON arrays, objects, and primitives`);
    }
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new TypeError(`${label} must not contain symbol-keyed properties`);
    }
    if (Array.isArray(item)) {
      let indexedValues = 0;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (key === "length") continue;
        if (arrayIndex(key, item.length) === undefined) {
          throw new TypeError(`${label} arrays must not contain custom properties`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(`${label} must not contain accessor properties`);
        }
        if (!descriptor.enumerable) {
          throw new TypeError(`${label} arrays must contain enumerable indexed values`);
        }
        visit(descriptor.value);
        indexedValues += 1;
      }
      if (indexedValues !== item.length) {
        throw new TypeError(`${label} must not contain sparse arrays`);
      }
    } else {
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) {
          throw new TypeError(`${label} must not contain accessor properties`);
        }
        visit(descriptor.value);
      }
    }
    ancestors.delete(item);
  };
  try {
    visit(value);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`${label} must be JSON-serializable`);
    }
    return serialized;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
}

function jsonErrorValue(value: unknown): unknown {
  try {
    return JSON.parse(serializeJson(value, "RPC error details"));
  } catch {
    try {
      return String(value);
    } catch {
      return "Unserializable error details";
    }
  }
}

async function parse<Input, Output>(schema: Parser<Input, Output>, input: Input): Promise<Output> {
  return await parseValue(schema, input);
}

function rpcEndpoint<Input extends RpcArgs, Parsed extends RpcArgs, Data>(
  kind: "query" | "mutation",
  name: string,
  config: RpcConfig<Input, Parsed>,
  handler: (...args: Parsed) => PromiseLike<Data>,
): RpcFunction<Input, Data> & RpcEndpoint {
  validateRpcName(name);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(
      `$rpc${kind === "query" ? "Query" : "Mutation"}() config must be an object`,
    );
  }
  validateSchema(config.schema, `$rpc${kind === "query" ? "Query" : "Mutation"}()`);
  if (typeof handler !== "function") throw new TypeError("RPC handler must be a function");
  const unexpected = Object.keys(config).find((key) => key !== "schema");
  if (unexpected) throw new TypeError(`RPC config contains unknown property ${unexpected}`);
  const callable = async (...args: Input): Promise<Data> => {
    serializeJson(args, `RPC ${name} arguments`);
    const parsed = await parse(config.schema, args);
    if (!Array.isArray(parsed)) throw new TypeError("RPC schema output must be an argument tuple");
    const result = handler(...(parsed as unknown as Parsed));
    if (!isPromiseLike(result)) throw new TypeError("RPC handler must return a promise-like value");
    const data = await result;
    serializeJson(data, `RPC ${name} result`);
    return data;
  };
  Object.defineProperties(callable, {
    [ENDPOINT]: { value: true },
    kind: { value: kind },
    name: { value: name },
    method: { value: "POST" },
    path: { value: `${RPC_PREFIX}${name}` },
    invoke: { value: (args: unknown) => callable(...(args as Input)) },
  });
  rpcMetadata.set(callable, { kind, name });
  return Object.freeze(callable) as RpcFunction<Input, Data> & RpcEndpoint;
}

export function rpcQueryServer<Input extends RpcArgs, Parsed extends RpcArgs, Data>(
  name: string,
  config: RpcConfig<Input, Parsed>,
  handler: (...args: Parsed) => PromiseLike<Data>,
): RpcFunction<Input, Data> {
  return rpcEndpoint("query", name, config, handler);
}

export function rpcMutationServer<Input extends RpcArgs, Parsed extends RpcArgs, Data>(
  name: string,
  config: RpcConfig<Input, Parsed>,
  handler: (...args: Parsed) => PromiseLike<Data>,
): RpcFunction<Input, Data> {
  return rpcEndpoint("mutation", name, config, handler);
}

function clientRpc<Input extends RpcArgs, Data>(
  kind: "query" | "mutation",
  name: string,
): RpcFunction<Input, Data> {
  validateRpcName(name);
  const callable = async (...args: Input): Promise<Data> => {
    const payload = serializeJson(args, `RPC ${name} arguments`);
    const path = deployedPath(`${RPC_PREFIX}${name}`);
    const response = await fetch(path, {
      method: "POST",
      headers: { accept: RPC_CONTENT_TYPE, "content-type": RPC_CONTENT_TYPE },
      body: payload,
    });
    const text = await response.text();
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`RPC ${name} returned an invalid response (${response.status})`);
    }
    if (!isObject(envelope) || typeof (envelope as { ok?: unknown }).ok !== "boolean") {
      throw new Error(`RPC ${name} returned an invalid response (${response.status})`);
    }
    if ((envelope as { ok: boolean }).ok) {
      if (!response.ok) throw new Error(`RPC ${name} failed (${response.status})`);
      if (!Object.prototype.hasOwnProperty.call(envelope, "value")) {
        throw new Error(`RPC ${name} returned an invalid response (${response.status})`);
      }
      return (envelope as { value: Data }).value;
    }
    const detail = (envelope as { error?: unknown }).error;
    const record = (isObject(detail) ? detail : {}) as Record<string, unknown>;
    const error = new Error(
      typeof record.message === "string"
        ? record.message
        : `RPC ${name} failed (${response.status})`,
    );
    if (typeof record.name === "string") error.name = record.name;
    if (typeof record.stack === "string") error.stack = record.stack;
    if ("cause" in record) Object.defineProperty(error, "cause", { value: record.cause });
    if ("issues" in record) Object.defineProperty(error, "issues", { value: record.issues });
    throw error;
  };
  rpcMetadata.set(callable, { kind, name });
  return Object.freeze(callable);
}

export function rpcQueryClient<Input extends RpcArgs, Data>(
  name: string,
): RpcFunction<Input, Data> {
  return clientRpc("query", name);
}

export function rpcMutationClient<Input extends RpcArgs, Data>(
  name: string,
): RpcFunction<Input, Data> {
  return clientRpc("mutation", name);
}

export function rpcFunctionMetadata(
  value: unknown,
): { readonly kind: "query" | "mutation"; readonly name: string } | undefined {
  return typeof value === "function" ? rpcMetadata.get(value) : undefined;
}

function compileHttpPath(path: string): CompiledHttpPath {
  if (!path.startsWith("/") || (path.length > 1 && path.endsWith("/"))) {
    throw new TypeError("HTTP route path must start with one slash and have no trailing slash");
  }
  let containsControl = false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsControl = true;
      break;
    }
  }
  if (/[?#\\]/.test(path) || containsControl) {
    throw new TypeError(
      "HTTP route path cannot contain query, fragment, backslash, or control syntax",
    );
  }
  const names: string[] = [];
  const specificity: number[] = [];
  if (path === "/") {
    return { pattern: /^\/$/, parameterNames: names, specificity };
  }
  const pattern = path
    .split("/")
    .map((segment, index) => {
      if (index === 0) return "";
      if (!segment) throw new TypeError("HTTP route path cannot contain empty segments");
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || names.includes(name)) {
          throw new TypeError(`Invalid HTTP route parameter ${name}`);
        }
        names.push(name);
        specificity.push(0);
        return "([^/]+)";
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new TypeError("HTTP route path contains malformed percent encoding");
      }
      if (decoded === "." || decoded === "..") {
        throw new TypeError("HTTP route path cannot contain dot segments");
      }
      specificity.push(1);
      const canonical = new URL(`/sol/${segment}`, "http://sol.invalid").pathname
        .slice("/sol/".length)
        .replaceAll(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
      return canonical.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${pattern}$`), parameterNames: names, specificity };
}

export function httpRouteServer<Input extends HttpRouteInput, Parsed>(
  config: HttpRouteConfig<Input, Parsed>,
  handler: (input: Parsed, request: Request) => Response | PromiseLike<Response>,
): HttpRouteDefinition {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("$httpRoute() config must be an object");
  }
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(config.method)) {
    throw new TypeError("$httpRoute() method is invalid");
  }
  if (typeof config.path !== "string") throw new TypeError("$httpRoute() path must be a string");
  if (config.path.startsWith(RPC_PREFIX)) {
    throw new TypeError("$httpRoute() path uses the reserved /api/rpc namespace");
  }
  validateSchema(config.schema, "$httpRoute()");
  if (config.body !== undefined && config.body !== "auto" && config.body !== "bytes") {
    throw new TypeError('$httpRoute() body must be "auto" or "bytes"');
  }
  if (typeof handler !== "function") throw new TypeError("HTTP route handler must be a function");
  const unexpected = Object.keys(config).find(
    (key) => key !== "method" && key !== "path" && key !== "schema" && key !== "body",
  );
  if (unexpected) throw new TypeError(`HTTP route config contains unknown property ${unexpected}`);
  const definition: HttpEndpoint = {
    [ENDPOINT]: true,
    kind: "http",
    method: config.method,
    path: config.path,
    body: config.body ?? "auto",
    compiled: compileHttpPath(config.path),
    async invoke(input, request) {
      const parsed = await parse(config.schema, input as Input);
      const response = await handler(parsed, request);
      if (!(response instanceof Response))
        throw new TypeError("HTTP route handler must return a Response");
      return response;
    },
  };
  return Object.freeze(definition);
}

export function httpRouteClient(config: {
  readonly method: HttpMethod;
  readonly path: string;
}): HttpRouteDefinition {
  return Object.freeze({ method: config.method, path: config.path });
}

export function isServerEndpoint(value: unknown): value is ServerEndpoint {
  return (
    (typeof value === "function" || isObject(value)) &&
    (value as { [ENDPOINT]?: unknown })[ENDPOINT] === true
  );
}

function queryRecord(
  search: URLSearchParams,
): Readonly<Record<string, string | readonly string[]>> {
  const output: Record<string, string | readonly string[]> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: values.length === 1 ? values[0]! : Object.freeze(values),
      writable: true,
    });
  }
  return Object.freeze(output);
}

function headerRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(headers));
}

function bodyLimit(options: ServerDispatchOptions): number {
  const value = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative safe integer");
  }
  return value;
}

function cancelRequestBody(request: Request): void {
  if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
}

function assertDeclaredBodyLimit(request: Request, limit: number): void {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    cancelRequestBody(request);
    throw requestError(`Request body exceeds the ${limit} byte limit`, 413);
  }
}

async function bodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  assertDeclaredBodyLimit(request, limit);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // Stream chunks must be consumed sequentially to enforce the cumulative limit.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        throw requestError(`Request body exceeds the ${limit} byte limit`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function decodedBody(
  request: Request,
  mode: "auto" | "bytes",
  limit: number,
): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  assertDeclaredBodyLimit(request, limit);
  let bytes: Uint8Array;
  try {
    bytes = await bodyBytes(request.clone(), limit);
  } catch (error) {
    if (requestErrorStatus(error) === 413) cancelRequestBody(request);
    throw error;
  }
  if (bytes.byteLength === 0) return undefined;
  if (mode === "bytes") return bytes.buffer;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const text = new TextDecoder().decode(bytes);
  if (contentType === "application/json" || contentType?.endsWith("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw requestError("Malformed JSON request body", 400);
    }
  }
  if (contentType?.startsWith("text/")) return text;
  throw requestError("Unsupported request body media type", 415);
}

function errorDetail(error: unknown, development: boolean): Record<string, unknown> {
  if (validationError(error)) {
    try {
      return {
        name: "ValidationError",
        message: "Input validation failed",
        issues: jsonErrorValue(error.issues),
      };
    } catch {
      return { name: "ValidationError", message: "Input validation failed" };
    }
  }
  if (!development) return { name: "Error", message: "Internal Server Error" };
  try {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        ...(Object.prototype.hasOwnProperty.call(error, "cause")
          ? { cause: jsonErrorValue(error.cause) }
          : {}),
        ...(isObject(error) && "issues" in error ? { issues: jsonErrorValue(error.issues) } : {}),
      };
    }
    return { name: "Error", message: String(error) };
  } catch {
    return { name: "Error", message: "Uninspectable thrown value" };
  }
}

function rpcResponse(value: unknown, status = 200): Response {
  return new Response(serializeJson(value, "RPC response"), {
    status,
    headers: { "content-type": `${RPC_CONTENT_TYPE}; charset=utf-8` },
  });
}

function matcherCompare(left: HttpEndpoint, right: HttpEndpoint): number {
  const length = Math.max(left.compiled.specificity.length, right.compiled.specificity.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (right.compiled.specificity[index] ?? -1) - (left.compiled.specificity[index] ?? -1);
    if (difference) return difference;
  }
  return right.compiled.specificity.length - left.compiled.specificity.length;
}

export async function dispatchServerEndpoint(
  endpoints: readonly ServerEndpoint[],
  request: Request,
  options: ServerDispatchOptions = {},
): Promise<Response | undefined> {
  const maxBodyBytes = bodyLimit(options);
  const url = new URL(request.url);
  const pathname = logicalPathname(url.pathname);
  if (pathname === undefined) return undefined;
  const rpcPath = endpoints.filter(
    (endpoint): endpoint is RpcEndpoint => endpoint.kind !== "http" && endpoint.path === pathname,
  );
  const rpc = rpcPath.find((endpoint) => endpoint.method === request.method);
  if (rpcPath.length === 0 && pathname.startsWith(RPC_PREFIX)) {
    cancelRequestBody(request);
    return new Response("Not Found", { status: 404 });
  }
  if (!rpc && rpcPath.length > 0) {
    cancelRequestBody(request);
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (rpc) {
    try {
      const contentType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== RPC_CONTENT_TYPE) {
        throw requestError("RPC requests must use application/json", 415);
      }
      const payload = new TextDecoder().decode(await bodyBytes(request, maxBodyBytes));
      if (payload === "") throw requestError("Missing RPC input", 400);
      let args: unknown;
      try {
        args = JSON.parse(payload);
      } catch {
        throw requestError("Malformed JSON RPC input", 400);
      }
      if (!Array.isArray(args)) throw requestError("RPC input must be an argument tuple", 400);
      return rpcResponse({ ok: true, value: await rpc.invoke(args) });
    } catch (error) {
      cancelRequestBody(request);
      const status = validationError(error) ? 400 : (requestErrorStatus(error) ?? 500);
      if (status === 500 && !options.development) console.error(error);
      return rpcResponse(
        { ok: false, error: errorDetail(error, options.development ?? false) },
        status,
      );
    }
  }
  const matchingPath = endpoints
    .filter((endpoint): endpoint is HttpEndpoint => endpoint.kind === "http")
    .map((endpoint) => ({ endpoint, match: endpoint.compiled.pattern.exec(pathname) }))
    .filter((candidate): candidate is { endpoint: HttpEndpoint; match: RegExpExecArray } =>
      Boolean(candidate.match),
    )
    .toSorted((left, right) => matcherCompare(left.endpoint, right.endpoint));
  const selected = matchingPath.find(({ endpoint }) => endpoint.method === request.method);
  if (!selected) {
    if (matchingPath.length === 0) return undefined;
    cancelRequestBody(request);
    const allow = [...new Set(matchingPath.map(({ endpoint }) => endpoint.method))]
      .toSorted()
      .join(", ");
    return new Response("Method Not Allowed", { status: 405, headers: { allow } });
  }
  try {
    const params: Record<string, string> = {};
    selected.endpoint.compiled.parameterNames.forEach((name, index) => {
      try {
        Object.defineProperty(params, name, {
          configurable: true,
          enumerable: true,
          value: decodeURIComponent(selected.match[index + 1]!),
          writable: true,
        });
      } catch {
        throw requestError(`Malformed HTTP route parameter ${name}`, 400);
      }
    });
    const input: HttpRouteInput = Object.freeze({
      params: Object.freeze(params),
      query: queryRecord(url.searchParams),
      headers: headerRecord(request.headers),
      body: await decodedBody(request, selected.endpoint.body, maxBodyBytes),
    });
    return await selected.endpoint.invoke(input, request);
  } catch (error) {
    cancelRequestBody(request);
    const status = validationError(error) ? 400 : (requestErrorStatus(error) ?? 500);
    if (status === 500) console.error(error);
    const detail = errorDetail(error, options.development ?? false);
    return Response.json({ error: detail }, { status });
  }
}
