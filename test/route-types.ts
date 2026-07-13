import { $route, Link, type Component, type RouteDefinition } from "../src/runtime.ts";
import type { JSX } from "../src/jsx-runtime.ts";

declare const blogDetailRoute: RouteDefinition<"/blog/:id">;
declare const todoRoute: RouteDefinition<"/">;
declare const Page: Component;
declare const parsedRoute: RouteDefinition<
  "/blog/:id",
  {
    readonly params: { readonly id: number };
    readonly query: { readonly page?: number; readonly filter: string };
  }
>;

const id: string = blogDetailRoute.params.id;
const parsedId: number = parsedRoute.params.id;
const page: number | undefined = parsedRoute.query.page;
void id;
void parsedId;
void page;
blogDetailRoute.navigate({ params: { id: "first" } });
parsedRoute.navigate({ params: { id: 2 }, query: { filter: "all" } }, { replace: true });
todoRoute.navigate({});
Link({
  route: parsedRoute,
  params: { id: 2 },
  query: { filter: "all" },
  children: {} as JSX.Element,
});

$route(
  {
    path: "/blog/:id",
    // @ts-expect-error Route schema params must exactly match path parameter names.
    schema: () => ({ params: { slug: "wrong" }, query: {} }),
  },
  Page,
);

// @ts-expect-error The path requires an id parameter.
blogDetailRoute.navigate({});
// @ts-expect-error Unknown parameters are rejected.
blogDetailRoute.navigate({ params: { id: "first", slug: "extra" } });
// @ts-expect-error Parsed parameters retain their output type.
parsedRoute.navigate({ params: { id: "2" }, query: { filter: "all" } });
// @ts-expect-error A declared query object is required.
parsedRoute.navigate({ params: { id: 2 } });
Link({
  route: parsedRoute,
  // @ts-expect-error Link params are inferred from its route handle.
  params: { id: "2" },
  query: { filter: "all" },
  children: {} as JSX.Element,
});
// @ts-expect-error Link requires declared query values.
Link({ route: parsedRoute, params: { id: 2 }, children: {} as JSX.Element });
// @ts-expect-error Only inferred path parameters are exposed.
void blogDetailRoute.params.slug;
// @ts-expect-error Schema-free routes expose no typed query properties.
void blogDetailRoute.query.page;
