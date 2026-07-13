import { $route, Link, type Component, type RouteDefinition } from "../src/runtime.ts";
import type { JSX } from "../src/jsx-runtime.ts";

declare const blogDetailRoute: RouteDefinition<"/blog/:id?from=:from">;
declare const todoRoute: RouteDefinition<"/">;
declare const Page: Component;
declare const parsedRoute: RouteDefinition<
  "/blog/:id?filter=:filter&page=:page",
  { readonly id: number; readonly filter: string; readonly page: number }
>;

const id: string = blogDetailRoute.params.id;
const from: string = blogDetailRoute.params.from;
const parsedId: number = parsedRoute.params.id;
const page: number = parsedRoute.query.page;
void id;
void from;
void parsedId;
void page;
blogDetailRoute.navigate({ params: { id: "first", from: "index" } });
parsedRoute.navigate({ params: { id: 2, filter: "all", page: 1 } }, { replace: true });
todoRoute.navigate({});
Link({
  route: parsedRoute,
  params: { id: 2, filter: "all", page: 1 },
  children: {} as JSX.Element,
});

$route(
  {
    path: "/blog/:id?filter=:filter",
    // @ts-expect-error Route schema values must exactly match route parameter names.
    schema: () => ({ slug: "wrong", filter: "all" }),
  },
  Page,
);

// @ts-expect-error The route requires both path and query parameters.
blogDetailRoute.navigate({ params: { id: "first" } });
// @ts-expect-error Unknown parameters are rejected.
blogDetailRoute.navigate({ params: { id: "first", from: "index", slug: "extra" } });
// @ts-expect-error Parsed parameters retain their output type.
parsedRoute.navigate({ params: { id: "2", filter: "all", page: 1 } });
Link({
  route: parsedRoute,
  // @ts-expect-error Link params are inferred from its route handle.
  params: { id: "2", filter: "all", page: 1 },
  children: {} as JSX.Element,
});
// @ts-expect-error Link requires every declared route parameter.
Link({ route: parsedRoute, params: { id: 2, filter: "all" }, children: {} as JSX.Element });
// @ts-expect-error Only inferred route parameters are exposed.
void blogDetailRoute.params.slug;
