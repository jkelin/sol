import { describe, expect, test } from "bun:test";
import {
  dispatchServerEndpoint,
  httpRouteServer,
  rpcMutationServer,
  rpcQueryClient,
  rpcQueryServer,
  type HttpRouteInput,
  type ServerEndpoint,
} from "../src/server-functions.ts";

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
    try {
      const query = rpcQueryClient<readonly [number], number>("failure");
      const failure = await query(1).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "RangeError", message: "too far" });
      expect(requestedPath).toBe("/api/rpc/failure");
      expect(requestedInit?.method).toBe("POST");
      expect(new Headers(requestedInit?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(requestedInit?.body))).toEqual([1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("decodes structured HTTP input and passes through Responses", async () => {
    let received: HttpRouteInput | undefined;
    const route = httpRouteServer(
      {
        method: "POST",
        path: "/api/items/:id",
        schema: (input: HttpRouteInput) => input,
      },
      async (input) => {
        received = input;
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
