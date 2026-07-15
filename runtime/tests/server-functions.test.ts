import { describe, expect, test } from "bun:test";
import {
  dispatchServerEndpoint,
  httpRouteServer,
  rpcMutationServer,
  rpcQueryClient,
  rpcQueryServer,
  type HttpRouteInput,
  type ServerDispatchOptions,
  type ServerEndpoint,
} from "../src/server-functions.ts";
import { configureRouteBase } from "../src/route-base.ts";

function rpcRequest(name: string, args: readonly unknown[]): Request {
  return new Request(`https://example.test/api/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}

describe("server declarations", () => {
  test("validates RPC argument tuples and invokes parsed handlers directly", async () => {
    const query = rpcQueryServer(
      "double",
      { schema: (args: readonly [string]) => [Number(args[0])] as [number] },
      async (value) => value * 2,
    );
    expect(await query("4")).toBe(8);
    expect((query as unknown as { path: string }).path).toBe("/api/rpc/double");
    expect((query as unknown as { method: string }).method).toBe("POST");
  });

  test("snapshots server endpoint configs and rejects accessors", async () => {
    const rpcConfig = {
      schema: (args: readonly [string]) => [args[0]!.toUpperCase()] as [string],
    };
    const query = rpcQueryServer("stable-config", rpcConfig, async (value) => value);
    rpcConfig.schema = (args) => [args[0]!.toLowerCase()];
    expect(await query("Stable")).toBe("STABLE");

    const httpConfig: {
      method: "POST";
      path: "/stable-config";
      schema: (input: HttpRouteInput) => HttpRouteInput;
      body?: "auto" | "bytes";
    } = {
      method: "POST",
      path: "/stable-config",
      schema: (input) => ({ ...input, body: "original" }),
    };
    const route = httpRouteServer(httpConfig, async (input) =>
      Response.json(input.body),
    ) as unknown as ServerEndpoint;
    httpConfig.schema = (input) => ({ ...input, body: "changed" });
    httpConfig.body = "bytes";
    const response = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/stable-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(await response!.json()).toBe("original");

    let accessorReads = 0;
    const accessorRpcConfig = Object.defineProperty({}, "schema", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return (args: readonly []) => args;
      },
    });
    expect(() =>
      rpcQueryServer("accessor-config", accessorRpcConfig as never, async () => 1),
    ).toThrow("data property");
    const accessorHttpConfig = Object.defineProperties(
      {},
      {
        method: { enumerable: true, get: () => (accessorReads++, "GET") },
        path: { enumerable: true, get: () => (accessorReads++, "/accessor") },
        schema: {
          enumerable: true,
          get: () => (accessorReads++, (input: HttpRouteInput) => input),
        },
      },
    );
    expect(() => httpRouteServer(accessorHttpConfig as never, async () => new Response())).toThrow(
      "data property",
    );
    expect(accessorReads).toBe(0);

    const inheritedRpcConfig = Object.create({ schema: (args: readonly []) => args });
    expect(() => rpcQueryServer("inherited-config", inheritedRpcConfig, async () => 1)).toThrow(
      "schema must be callable",
    );
    const inheritedHttpConfig = Object.create({
      method: "GET",
      path: "/inherited",
      schema: (input: HttpRouteInput) => input,
    });
    expect(() => httpRouteServer(inheritedHttpConfig, async () => new Response())).toThrow(
      "method is invalid",
    );
  });

  test("enforces JSON arguments and results during direct server invocation", async () => {
    let invoked = false;
    const query = rpcQueryServer(
      "json-direct",
      { schema: (args: readonly [unknown]) => [...args] as [unknown] },
      async (_value) => {
        invoked = true;
        return 1n;
      },
    );
    const argumentError = await query(new Date()).catch((error: unknown) => error);
    expect(argumentError).toBeInstanceOf(TypeError);
    expect((argumentError as Error).message).toContain("JSON arrays, objects, and primitives");
    expect(invoked).toBe(false);
    const resultError = await query("valid input").catch((error: unknown) => error);
    expect(resultError).toBeInstanceOf(TypeError);
    expect((resultError as Error).message).toContain("JSON-serializable");
    expect(invoked).toBe(true);
  });

  test("rejects array accessors and every custom array property without invoking them", async () => {
    let accessorCalls = 0;
    const accessor = [] as unknown[];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "secret";
      },
    });
    const accessorQuery = rpcQueryServer(
      "accessor-result",
      { schema: (args: readonly []) => args as [] },
      async () => accessor,
    );
    const accessorFailure = await Promise.resolve(accessorQuery()).catch((error: unknown) => error);
    expect(accessorFailure).toBeInstanceOf(TypeError);
    expect((accessorFailure as Error).message).toContain("accessor");
    expect(accessorCalls).toBe(0);

    const customFailures = await Promise.all(
      ["01", "4294967295"].map(async (key) => {
        const custom = ["kept"] as unknown[];
        Object.defineProperty(custom, key, { enumerable: true, value: "dropped" });
        const customQuery = rpcQueryServer(
          "custom-result",
          { schema: (args: readonly []) => args as [] },
          async () => custom,
        );
        return Promise.resolve(customQuery()).catch((error: unknown) => error);
      }),
    );
    for (const customFailure of customFailures) {
      expect(customFailure).toBeInstanceOf(TypeError);
      expect((customFailure as Error).message).toContain("custom properties");
    }
  });

  test("rejects hidden RPC object properties without invoking toJSON hooks", async () => {
    await Promise.all(
      (["value", "accessor"] as const).map(async (kind) => {
        let hookCalls = 0;
        const hidden = Object.defineProperty({ safe: true }, "toJSON", {
          enumerable: false,
          ...(kind === "value"
            ? { value: () => (hookCalls++, { admin: true }) }
            : { get: () => (hookCalls++, () => ({ admin: true })) }),
        });
        let handlerCalls = 0;
        const argumentQuery = rpcQueryServer(
          `hidden-argument-${kind}`,
          { schema: (args: readonly [object]) => args as [object] },
          async (_value: object) => {
            handlerCalls += 1;
            return null;
          },
        );
        const argumentFailure = await Promise.resolve(argumentQuery(hidden)).catch(
          (error: unknown) => error,
        );
        expect(argumentFailure).toBeInstanceOf(TypeError);
        expect(handlerCalls).toBe(0);
        expect(hookCalls).toBe(0);

        const resultQuery = rpcQueryServer(
          `hidden-result-${kind}`,
          { schema: (args: readonly []) => args as [] },
          async () => hidden,
        );
        const resultFailure = await Promise.resolve(resultQuery()).catch((error: unknown) => error);
        expect(resultFailure).toBeInstanceOf(TypeError);
        expect(hookCalls).toBe(0);
      }),
    );
  });

  test("dispatches query and mutation POST requests with JSON values", async () => {
    const query = rpcQueryServer(
      "when",
      { schema: (args: readonly [string]) => [...args] as [string] },
      async (date) => ({ year: new Date(date).getUTCFullYear() }),
    ) as unknown as ServerEndpoint;
    const mutation = rpcMutationServer(
      "save",
      { schema: (args: readonly [number]) => [...args] as [number] },
      async (value) => value + 1,
    ) as unknown as ServerEndpoint;
    const queryResponse = await dispatchServerEndpoint(
      [query, mutation],
      rpcRequest("when", ["2026-01-01T00:00:00Z"]),
    );
    expect(queryResponse?.status).toBe(200);
    expect(await queryResponse!.json()).toEqual({ ok: true, value: { year: 2026 } });
    const mutationResponse = await dispatchServerEndpoint(
      [query, mutation],
      rpcRequest("save", [2]),
    );
    expect(await mutationResponse!.json()).toEqual({ ok: true, value: 3 });

    const getResponse = await dispatchServerEndpoint(
      [query, mutation],
      new Request("https://example.test/api/rpc/when"),
    );
    expect(getResponse?.status).toBe(405);
    expect(getResponse?.headers.get("allow")).toBe("POST");

    const mediaTypeResponse = await dispatchServerEndpoint(
      [query, mutation],
      new Request("https://example.test/api/rpc/when", {
        method: "POST",
        body: JSON.stringify(["2026-01-01T00:00:00Z"]),
      }),
    );
    expect(mediaTypeResponse?.status).toBe(415);

    const caseInsensitiveMediaType = await dispatchServerEndpoint(
      [query, mutation],
      new Request("https://example.test/api/rpc/when", {
        method: "POST",
        headers: { "content-type": "Application/JSON; Charset=UTF-8" },
        body: JSON.stringify(["2026-01-01T00:00:00Z"]),
      }),
    );
    expect(caseInsensitiveMediaType?.status).toBe(200);
  });

  test("creates browser RPC clients and reconstructs detailed errors", async () => {
    const originalFetch = globalThis.fetch;
    let requestedPath: string | undefined;
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedPath = String(input);
      requestedInit = init;
      return Response.json(
        { ok: false, error: { name: "RangeError", message: "too far" } },
        { status: 500 },
      );
    }) as typeof fetch;
    configureRouteBase("/sol/");
    try {
      const query = rpcQueryClient<readonly [number], number>("failure");
      const failure = await query(1).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "RangeError", message: "too far" });
      expect(requestedPath).toBe("/sol/api/rpc/failure");
      expect(requestedInit?.method).toBe("POST");
      expect(new Headers(requestedInit?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(requestedInit?.body))).toEqual([1]);
    } finally {
      configureRouteBase("/");
      globalThis.fetch = originalFetch;
    }
  });

  test("ignores inherited RPC error details", async () => {
    const originalFetch = globalThis.fetch;
    const objectPrototype = Object.prototype as {
      cause?: unknown;
      issues?: unknown;
      message?: unknown;
      name?: unknown;
      stack?: unknown;
    };
    globalThis.fetch = (async () =>
      Response.json({ ok: false, error: {} }, { status: 500 })) as unknown as typeof fetch;
    Object.assign(objectPrototype, {
      cause: "inherited cause",
      issues: "inherited issues",
      message: "inherited message",
      name: "InheritedError",
      stack: "inherited stack",
    });
    try {
      const query = rpcQueryClient<readonly [], unknown>("polluted");
      const failure = await query().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("Error");
      expect((failure as Error).message).toBe("RPC polluted failed (500)");
      expect(Object.hasOwn(failure as object, "cause")).toBe(false);
      expect(Object.hasOwn(failure as object, "issues")).toBe(false);
    } finally {
      delete objectPrototype.cause;
      delete objectPrototype.issues;
      delete objectPrototype.message;
      delete objectPrototype.name;
      delete objectPrototype.stack;
      globalThis.fetch = originalFetch;
    }
  });

  test("omits inherited issues from development RPC errors", async () => {
    const errorPrototype = Error.prototype as { issues?: unknown };
    Object.defineProperty(errorPrototype, "issues", {
      configurable: true,
      value: [{ message: "inherited issue" }],
    });
    const endpoint = rpcQueryServer(
      "inherited-issues",
      { schema: (args: readonly []) => args as [] },
      async () => {
        throw new Error("own message");
      },
    ) as unknown as ServerEndpoint;
    try {
      const response = await dispatchServerEndpoint(
        [endpoint],
        rpcRequest("inherited-issues", []),
        { development: true },
      );
      expect(await response!.json()).toEqual({
        ok: false,
        error: {
          name: "Error",
          message: "own message",
          stack: expect.any(String),
        },
      });
    } finally {
      delete errorPrototype.issues;
    }
  });

  test("dispatches RPC and HTTP endpoints beneath the configured route base", async () => {
    const query = rpcQueryServer(
      "based",
      { schema: (args: readonly []) => args as [] },
      async () => "rpc",
    ) as unknown as ServerEndpoint;
    const route = httpRouteServer(
      { method: "GET", path: "/status", schema: (input: HttpRouteInput) => input },
      async () => new Response("http"),
    ) as unknown as ServerEndpoint;

    configureRouteBase("/sol/");
    try {
      const rpc = await dispatchServerEndpoint(
        [query, route],
        new Request("https://example.test/sol/api/rpc/based", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        }),
      );
      const http = await dispatchServerEndpoint(
        [query, route],
        new Request("https://example.test/sol/status"),
      );
      const outside = await dispatchServerEndpoint(
        [query, route],
        new Request("https://example.test/api/rpc/based", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        }),
      );

      expect(await rpc?.json()).toEqual({ ok: true, value: "rpc" });
      expect(await http?.text()).toBe("http");
      expect(outside).toBeUndefined();
    } finally {
      configureRouteBase("/");
    }
  });

  test("matches equivalent percent-escape casing in the configured route base", async () => {
    const route = httpRouteServer(
      { method: "GET", path: "/status", schema: (input: HttpRouteInput) => input },
      async () => new Response("http"),
    ) as unknown as ServerEndpoint;

    configureRouteBase("/caf%c3%a9/");
    try {
      const response = await dispatchServerEndpoint(
        [route],
        new Request("https://example.test/caf%C3%A9/status"),
      );
      expect(await response?.text()).toBe("http");
    } finally {
      configureRouteBase("/");
    }
  });

  test("rejects RPC success envelopes without a JSON value", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    try {
      const query = rpcQueryClient<readonly [], unknown>("missing-value");
      const error = await query().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("RPC missing-value returned an invalid response (200)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("decodes structured HTTP input and passes through Responses", async () => {
    let received: HttpRouteInput | undefined;
    let rawBody: unknown;
    const route = httpRouteServer(
      {
        method: "POST",
        path: "/api/items/:id",
        schema: (input: HttpRouteInput) => input,
      },
      async (input, request) => {
        received = input;
        rawBody = await request.json();
        return Response.json({ id: input.params.id, body: input.body });
      },
    ) as unknown as ServerEndpoint;
    const response = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/api/items/one?tag=a&tag=b", {
        method: "POST",
        headers: { "content-type": "application/json", "x-example": "yes" },
        body: JSON.stringify({ ready: true }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(received?.params).toEqual({ id: "one" });
    expect(received?.query).toEqual({ tag: ["a", "b"] });
    expect(received?.body).toEqual({ ready: true });
    expect(rawBody).toEqual({ ready: true });
  });

  test("dispatches root HTTP routes and preserves special record keys", async () => {
    const root = httpRouteServer(
      {
        method: "GET",
        path: "/",
        schema: (input: HttpRouteInput) => input,
      },
      async (input) => Response.json(input.query),
    ) as unknown as ServerEndpoint;
    const rootResponse = await dispatchServerEndpoint(
      [root],
      new Request("https://example.test/?__proto__=one&__proto__=two&constructor=value"),
    );
    expect(rootResponse?.status).toBe(200);
    const rootBody = (await rootResponse!.json()) as Record<string, unknown>;
    expect(Object.hasOwn(rootBody, "__proto__")).toBe(true);
    expect(rootBody.__proto__).toEqual(["one", "two"]);
    expect(rootBody["constructor"] as unknown).toBe("value");

    const parameter = httpRouteServer(
      {
        method: "GET",
        path: "/:__proto__",
        schema: (input: HttpRouteInput) => input,
      },
      async (input) => Response.json(input.params),
    ) as unknown as ServerEndpoint;
    const parameterResponse = await dispatchServerEndpoint(
      [parameter],
      new Request("https://example.test/safe"),
    );
    const parameterBody = (await parameterResponse!.json()) as Record<string, unknown>;
    expect(Object.hasOwn(parameterBody, "__proto__")).toBe(true);
    expect(parameterBody.__proto__).toBe("safe");
  });

  test("returns 404 for unknown names in the reserved RPC namespace", async () => {
    const response = await dispatchServerEndpoint(
      [],
      new Request("https://example.test/api/rpc/missing"),
    );
    expect(response?.status).toBe(404);
    expect(await response!.text()).toBe("Not Found");
  });

  test("returns validation, media type, method, and production failure responses", async () => {
    const invalid = httpRouteServer(
      {
        method: "POST",
        path: "/api/value",
        schema: () => {
          throw { issues: [{ message: "invalid" }] };
        },
      },
      async () => new Response("unreachable"),
    ) as unknown as ServerEndpoint;
    const unsupported = await dispatchServerEndpoint(
      [invalid],
      new Request("https://example.test/api/value", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "value",
      }),
    );
    expect(unsupported?.status).toBe(415);
    const method = await dispatchServerEndpoint(
      [invalid],
      new Request("https://example.test/api/value"),
    );
    expect(method?.status).toBe(405);
  });

  test("rejects declared and streamed bodies above the configured limit", async () => {
    let invoked = false;
    const rpc = rpcQueryServer(
      "limited",
      { schema: (args: readonly []) => args as [] },
      async () => {
        invoked = true;
        return true;
      },
    ) as unknown as ServerEndpoint;
    const declared = await dispatchServerEndpoint(
      [rpc],
      new Request("https://example.test/api/rpc/limited", {
        method: "POST",
        headers: { "content-length": "100", "content-type": "application/json" },
        body: "[]",
      }),
      { maxBodyBytes: 5 },
    );
    expect(declared?.status).toBe(413);
    expect(await declared!.json()).toMatchObject({ ok: false, error: { name: "Error" } });
    expect(invoked).toBe(false);

    const route = httpRouteServer(
      {
        method: "POST",
        path: "/streamed",
        schema: (input: HttpRouteInput) => input,
      },
      async () => {
        invoked = true;
        return new Response("unreachable");
      },
    ) as unknown as ServerEndpoint;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
      duplex: "half",
    };
    const streamed = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/streamed", init),
      { maxBodyBytes: 5 },
    );
    expect(streamed?.status).toBe(413);
    expect(await streamed!.json()).toMatchObject({ error: { name: "Error" } });
    expect(invoked).toBe(false);

    let cancelled = false;
    const openBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcdef"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const openInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: openBody,
      duplex: "half",
    };
    const openResult = await Promise.race([
      dispatchServerEndpoint([route], new Request("https://example.test/streamed", openInit), {
        maxBodyBytes: 5,
      }),
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    expect(openResult).not.toBe("timeout");
    expect((openResult as Response).status).toBe(413);
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
  });

  test("treats user-thrown status fields as logged production failures", async () => {
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await Promise.all(
        [201, 700].map(async (status) => {
          const route = httpRouteServer(
            {
              method: "GET",
              path: `/status-${status}`,
              schema: (input: HttpRouteInput) => input,
            },
            async () => {
              throw Object.assign(new Error(`failure ${status}`), { status });
            },
          ) as unknown as ServerEndpoint;
          const response = await dispatchServerEndpoint(
            [route],
            new Request(`https://example.test/status-${status}`),
          );
          expect(response?.status).toBe(500);
          expect(await response!.json()).toEqual({
            error: { name: "Error", message: "Internal Server Error" },
          });
        }),
      );

      const rpc = rpcQueryServer(
        "status-failure",
        { schema: (args: readonly []) => args as [] },
        async () => {
          throw Object.assign(new Error("RPC failure"), { status: 400 });
        },
      ) as unknown as ServerEndpoint;
      const rpcResponse = await dispatchServerEndpoint([rpc], rpcRequest("status-failure", []));
      expect(rpcResponse?.status).toBe(500);
      expect(logged).toHaveLength(3);
    } finally {
      console.error = originalError;
    }
  });

  test("supports raw bytes and rejects malformed automatic JSON", async () => {
    let bytes: ArrayBuffer | undefined;
    const raw = httpRouteServer(
      {
        method: "POST",
        path: "/api/raw",
        body: "bytes",
        schema: (input: HttpRouteInput) => input,
      },
      async (input) => {
        bytes = input.body as ArrayBuffer;
        return new Response("ok");
      },
    ) as unknown as ServerEndpoint;
    const rawResponse = await dispatchServerEndpoint(
      [raw],
      new Request("https://example.test/api/raw", { method: "POST", body: new Uint8Array([1, 2]) }),
    );
    expect(rawResponse?.status).toBe(200);
    expect([...new Uint8Array(bytes!)]).toEqual([1, 2]);

    const json = httpRouteServer(
      {
        method: "POST",
        path: "/api/json",
        schema: (input: HttpRouteInput) => input,
      },
      async () => new Response("ok"),
    ) as unknown as ServerEndpoint;
    const malformed = await dispatchServerEndpoint(
      [json],
      new Request("https://example.test/api/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed?.status).toBe(400);

    let httpInvoked = false;
    const strictJson = httpRouteServer(
      {
        method: "POST",
        path: "/api/strict-json",
        schema: (input: HttpRouteInput) => input,
      },
      async () => {
        httpInvoked = true;
        return new Response("ok");
      },
    ) as unknown as ServerEndpoint;
    const malformedUtf8 = await dispatchServerEndpoint(
      [strictJson],
      new Request("https://example.test/api/strict-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      }),
    );
    expect(malformedUtf8?.status).toBe(400);
    expect(httpInvoked).toBe(false);

    let rpcInvoked = false;
    const strictRpc = rpcQueryServer(
      "strict-utf8",
      { schema: (args: readonly [string]) => [args[0]] as [string] },
      async (_value: string) => {
        rpcInvoked = true;
        return true;
      },
    ) as unknown as ServerEndpoint;
    const malformedRpcUtf8 = await dispatchServerEndpoint(
      [strictRpc],
      new Request("https://example.test/api/rpc/strict-utf8", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]),
      }),
    );
    expect(malformedRpcUtf8?.status).toBe(400);
    expect(rpcInvoked).toBe(false);
  });

  test("keeps validation and development error details JSON-safe", async () => {
    const invalid = rpcQueryServer(
      "unsafe-issues",
      {
        schema: () => {
          throw { issues: [Symbol("unsafe")] };
        },
      },
      async () => true,
    ) as unknown as ServerEndpoint;
    const validation = await dispatchServerEndpoint([invalid], rpcRequest("unsafe-issues", []));
    expect(validation?.status).toBe(400);
    expect(await validation!.json()).toEqual({
      ok: false,
      error: {
        name: "ValidationError",
        message: "Input validation failed",
        issues: "Unserializable error details",
      },
    });

    const cause = {
      [Symbol.toPrimitive]() {
        throw new Error("coercion failed");
      },
    };
    const failed = rpcQueryServer(
      "unsafe-cause",
      { schema: (args: readonly []) => args as [] },
      async () => {
        throw new Error("failed", { cause });
      },
    ) as unknown as ServerEndpoint;
    const development = await dispatchServerEndpoint([failed], rpcRequest("unsafe-cause", []), {
      development: true,
    });
    expect(development?.status).toBe(500);
    expect(await development!.json()).toMatchObject({
      error: { message: "failed", cause: "Unserializable error details" },
    });

    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("getter failed");
        },
      },
    );
    const proxyFailure = rpcQueryServer(
      "hostile-proxy",
      { schema: (args: readonly []) => args as [] },
      async () => {
        throw hostileProxy;
      },
    ) as unknown as ServerEndpoint;
    const proxyResponse = await dispatchServerEndpoint(
      [proxyFailure],
      rpcRequest("hostile-proxy", []),
      { development: true },
    );
    expect(proxyResponse?.status).toBe(500);
    expect(await proxyResponse!.json()).toMatchObject({
      error: { name: "Error", message: "Uninspectable thrown value" },
    });

    const hostileValue = {
      [Symbol.toPrimitive]() {
        throw new Error("coercion failed");
      },
    };
    const hostileRoute = httpRouteServer(
      {
        method: "GET",
        path: "/hostile-error",
        schema: (input: HttpRouteInput) => input,
      },
      async () => {
        throw hostileValue;
      },
    ) as unknown as ServerEndpoint;
    const hostileResponse = await dispatchServerEndpoint(
      [hostileRoute],
      new Request("https://example.test/hostile-error"),
      { development: true },
    );
    expect(hostileResponse?.status).toBe(500);
    expect(await hostileResponse!.json()).toMatchObject({
      error: { name: "Error", message: "Uninspectable thrown value" },
    });
  });

  test("canonicalizes static HTTP paths and rejects unreachable syntax", async () => {
    const route = httpRouteServer(
      {
        method: "GET",
        path: "/café au lait",
        schema: (input: HttpRouteInput) => input,
      },
      async () => new Response("matched"),
    ) as unknown as ServerEndpoint;
    const response = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/café au lait"),
    );
    expect(await response!.text()).toBe("matched");

    for (const path of ["/query?value", "/fragment#value", "/back\\slash", "/./value", "/%2e"])
      expect(() =>
        httpRouteServer(
          { method: "GET", path: path as `/${string}`, schema: (input: HttpRouteInput) => input },
          async () => new Response("unreachable"),
        ),
      ).toThrow();
  });

  test("matches canonical-equivalent HTTP request path encodings", async () => {
    const route = httpRouteServer(
      { method: "GET", path: "/a!", schema: (input: HttpRouteInput) => input },
      async () => new Response("matched"),
    ) as unknown as ServerEndpoint;

    const bodies = await Promise.all(
      ["/a!", "/a%21", "/%61!"].map(async (path) => {
        const response = await dispatchServerEndpoint(
          [route],
          new Request(`https://example.test${path}`),
        );
        return response?.text();
      }),
    );
    expect(bodies).toEqual(["matched", "matched", "matched"]);

    configureRouteBase("/sol/");
    try {
      const response = await dispatchServerEndpoint(
        [route],
        new Request("https://example.test/sol/%61%21"),
      );
      expect(await response?.text()).toBe("matched");
    } finally {
      configureRouteBase("/");
    }
  });

  test("preserves encoded slashes and safely rejects malformed HTTP request paths", async () => {
    const route = httpRouteServer(
      { method: "GET", path: "/files/:name", schema: (input: HttpRouteInput) => input },
      async (input) => new Response(input.params.name),
    ) as unknown as ServerEndpoint;

    const encodedSlash = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/files/a%2fb"),
    );
    expect(await encodedSlash?.text()).toBe("a/b");
    const malformed = await dispatchServerEndpoint(
      [route],
      new Request("https://example.test/files/%zz"),
    );
    expect(malformed?.status).toBe(400);
  });

  test("includes RPC failure details only in development", async () => {
    const endpoint = rpcQueryServer(
      "explode",
      { schema: (args: readonly []) => args as [] },
      async () => {
        throw new Error("database secret");
      },
    ) as unknown as ServerEndpoint;
    const development = await dispatchServerEndpoint([endpoint], rpcRequest("explode", []), {
      development: true,
    });
    const developmentBody = (await development!.json()) as {
      error: { name: string; message: string; stack?: string };
    };
    expect(developmentBody.error.message).toBe("database secret");
    expect(developmentBody.error.stack).toContain("database secret");

    const production = await dispatchServerEndpoint([endpoint], rpcRequest("explode", []));
    const productionBody = (await production!.json()) as {
      error: { name: string; message: string; stack?: string };
    };
    expect(productionBody.error).toEqual({ name: "Error", message: "Internal Server Error" });
  });

  test("validates dispatch options before handling a request", async () => {
    let invoked = false;
    const endpoint = rpcQueryServer(
      "secret",
      { schema: (args: readonly []) => args as [] },
      async () => {
        invoked = true;
        throw new Error("SECRET_DIAGNOSTIC");
      },
    ) as unknown as ServerEndpoint;
    const request = rpcRequest("secret", []);
    const failures = await Promise.all(
      (
        [
          null,
          [],
          Object.create({}),
          { development: "yes" },
          { maxBodyBytes: "5" },
          { maxBodyBytes: -1 },
          { extra: true },
        ] as unknown as ServerDispatchOptions[]
      ).map((options) =>
        dispatchServerEndpoint([endpoint], request.clone(), options).catch(
          (error: unknown) => error,
        ),
      ),
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).not.toBeInstanceOf(Response);
    }
    let reads = 0;
    const changingDevelopment = Object.defineProperty({}, "development", {
      enumerable: true,
      get() {
        reads++;
        return reads < 3 ? false : "bypassed";
      },
    }) as ServerDispatchOptions;
    const accessorFailure = await dispatchServerEndpoint(
      [endpoint],
      request.clone(),
      changingDevelopment,
    ).catch((error: unknown) => error);
    expect(accessorFailure).toBeInstanceOf(TypeError);
    expect(invoked).toBe(false);

    const objectPrototype = Object.prototype as { development?: unknown };
    Object.defineProperty(objectPrototype, "development", {
      configurable: true,
      value: { value: true },
    });
    try {
      const polluted = await dispatchServerEndpoint([endpoint], request.clone());
      const body = (await polluted!.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Internal Server Error");
    } finally {
      delete objectPrototype.development;
    }
  });

  test("rejects non-JSON RPC arguments and results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;
    try {
      const query = rpcQueryClient<readonly [unknown], unknown>("json-only");
      const failure = await query(undefined).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toContain("JSON-serializable");
      const dateFailure = await query(new Date()).catch((error: unknown) => error);
      expect((dateFailure as Error).message).toContain("JSON arrays, objects, and primitives");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const endpoint = rpcQueryServer(
      "bad-result",
      { schema: (args: readonly []) => args as [] },
      async () => 1n,
    ) as unknown as ServerEndpoint;
    const response = await dispatchServerEndpoint([endpoint], rpcRequest("bad-result", []), {
      development: true,
    });
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: { name: "TypeError", message: expect.stringContaining("JSON-serializable") },
    });
  });
});
