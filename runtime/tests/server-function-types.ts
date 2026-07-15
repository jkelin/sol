import { $httpRoute, $rpcMutation, $rpcQuery, type HttpRouteInput } from "@soljs/sol";
import * as v from "valibot";

const load = $rpcQuery(
  "load",
  { schema: v.tuple([v.string(), v.optional(v.number())]) },
  async (name, page) => ({ name, page }),
);

void load("post", 2);
// @ts-expect-error RPC input is inferred from the tuple schema.
void load(2);

const save = $rpcMutation(
  "save",
  { schema: (args: readonly [{ title: string }]) => args as [{ title: string }] },
  async (post) => post.title,
);

void save({ title: "Ready" });
// @ts-expect-error Mutation payload must match the schema input tuple.
void save({ name: "Wrong" });

$httpRoute(
  {
    method: "POST",
    path: "/api/posts/:id",
    schema: (input: HttpRouteInput) => ({ id: Number(input.params.id) }),
  },
  async (input, request) => {
    input.id satisfies number;
    request satisfies Request;
    return new Response(null, { status: 204 });
  },
);

$httpRoute(
  {
    // @ts-expect-error HTTP methods must use the supported uppercase union.
    method: "post",
    path: "/api",
    schema: (input: HttpRouteInput) => input,
  },
  async () => new Response(),
);
