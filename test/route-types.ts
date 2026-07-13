import type { RouteDefinition } from "../src/runtime.ts";

declare const blogDetailRoute: RouteDefinition<"/blog/:id">;
declare const todoRoute: RouteDefinition<"/">;

const id: string = blogDetailRoute.params.id;
void id;
blogDetailRoute.navigate({ id: "first" });
blogDetailRoute.navigate({ id: 2 }, { replace: true });
todoRoute.navigate();
todoRoute.navigate({ replace: true });

// @ts-expect-error The path requires an id parameter.
blogDetailRoute.navigate({});
// @ts-expect-error Unknown parameters are rejected.
blogDetailRoute.navigate({ id: "first", slug: "extra" });
// @ts-expect-error Only inferred path parameters are exposed.
void blogDetailRoute.params.slug;
// @ts-expect-error Static routes do not accept route parameters.
todoRoute.navigate({ id: 1 });
