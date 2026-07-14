---
title: Routing
description: Discover route declarations at compile time and navigate with typed parameters and browser history.
section: Systems
order: 6
---

Routes are exported top-level constants in files ending with `.route.js`, `.route.jsx`, `.route.ts`, or `.route.tsx`. The Vite plugin discovers them below the project root.

## Declare a typed route

```tsx
import { $component, $route } from "solix";
import * as v from "valibot";

const BlogDetail = $component(function BlogDetail() {
  return <article>Entry</article>;
});

export const blogDetailRoute = $route(
  {
    path: "/blog/:id?page=:page",
    schema: v.object({
      id: v.pipe(v.string(), v.transform(Number)),
      page: v.pipe(v.string(), v.transform(Number)),
    }),
  },
  BlogDetail,
);
```

Path matches are exact and case-sensitive. Static routes outrank parameter routes, so `/blog/new` matches before `/blog/:id`. Repeated query keys use their final value.

## Read and navigate

```tsx
const id = blogDetailRoute.params.id;
blogDetailRoute.navigate({ params: { id: 42, page: 2 } });

<Link route={blogDetailRoute} params={{ id: 42, page: 2 }}>
  <a>Open entry</a>
</Link>;
```

`Link` requires one anchor child, supplies its `href`, and preserves native behavior for modified, targeted, downloaded, or prevented clicks.

## Route outlet and global router

Render `<Route />` in the application shell. The optional `pending` component appears while an async route schema resolves. The global `router` exposes pathname, search, hash, parsed parameters, the matched route, and `navigate(path, { replace? })` for destinations without a typed handle.

Reading params from an inactive, pending, or invalid typed route throws instead of returning stale data.
