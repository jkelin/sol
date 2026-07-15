---
title: Queries and Mutations
description: Share JSON-keyed async data, control freshness and polling, and run imperative mutations with reactive state.
section: Systems
order: 7
---

`$query()` and `$mutation()` are component-owned async controllers. Create them during component setup so Sol can stop polling, release cache observers, and finish Suspense work when that component leaves.

Async operations that belong on the server can be declared beside routes in a `.sol.ts` or
`.sol.tsx` module. Their required schemas validate the complete argument tuple, while the exported
value remains directly callable by the controllers:

```tsx
import { $rpcMutation, $rpcQuery } from "sol";
import * as v from "valibot";

export const loadPosts = $rpcQuery("load-posts", { schema: v.tuple([v.number()]) }, async (page) =>
  database.posts.page(page),
);

export const savePost = $rpcMutation(
  "save-post",
  { schema: v.tuple([v.object({ title: v.string() })]) },
  async (post) => database.posts.save(post),
);
```

Server rendering invokes these definitions directly. Browser queries and mutations both use `POST`
under `/api/rpc/:name`. The complete argument tuple, result, and exposed error details use JSON, so
RPC inputs and outputs must be JSON-serializable. Devtools uses the declared name instead of
displaying an anonymous mutation.

## Cached queries

The first argument to `$query()` contains the async function, its JSON cache key, and lifecycle options. Remaining arguments are forwarded to the automatic request.

```tsx
const posts = $query(
  {
    queryKey: ["posts", { scope: "recent" }],
    query: loadPosts,
    enabled: true,
    staleTime: 10_000,
    cacheTime: 5 * 60_000,
    pollingInterval: 30_000,
    suspense: { initial: true, refetch: false },
  },
  1,
);
```

Query keys accept only JSON values and use their exact `JSON.stringify()` output as cache identity. Object property order therefore matters. Function arguments do not extend the key automatically; include every resource-defining value in `queryKey` when different arguments represent different cache entries.

Observers with the same key share successful data, errors, and one in-flight promise. A second request made while that promise is pending returns the existing promise. Its new arguments are remembered for the next `refetch()` call, but they do not replace the running request.

The controller exposes:

- `data`: the latest successful result.
- `lastData`: the successful result replaced by `data`.
- `error` and `isFailed`: the latest failure without clearing successful data.
- `isFetching`: any active request for the shared key.
- `isRefetching`: an active request that began with cached data available.
- `refetch(options, ...args)`: a forced request returning `Promise<Data>`.

Calling `refetch()` without arguments reuses the controller's most recently requested argument tuple. When supplying arguments, pass a call-options object first: `refetch({ suspense: false }, page)`. This keeps object-valued function arguments unambiguous.

## Freshness, retention, and polling

`enabled` defaults to `true`. A mounted query fetches automatically unless fresh data already exists. `staleTime` defaults to `0`; `Infinity` keeps successful data fresh indefinitely.

Unused cache entries remain for `cacheTime`, which defaults to five minutes. `0` evicts immediately and `Infinity` retains the entry. When multiple observers share a key, the longest cache time registered during that mounted subscription cycle controls final eviction. Remounting before eviction reuses the entry and cancels its timer.

Set a positive `pollingInterval` to refetch while the observer is mounted, enabled, and the document is visible. Polling pauses in hidden tabs, resumes after one complete interval, and skips ticks while the key already has a request in flight.

## Suspense and failures

An uncached initial request participates in the nearest parent `Suspense` by default. Cached refetches do not, so stale data remains visible. Configure those phases independently with `suspense.initial` and `suspense.refetch`, then override a manual request with its call option.

Opted-in failures select the parent Suspense error renderer. Without a participating boundary, automatic failures remain in controller state. Manual `refetch()` and `mutate()` calls always reject, so event handlers should await them or deliberately handle the returned promise.

```sol live preview=QueryWorkbench title="Cached query and explicit mutation"
import { $component, $mutation, $query, Suspense } from "sol";

let serverRevision = 1;

function wait<T>(value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), 250));
}

function fetchRevision(page: number): Promise<{ page: number; revision: number }> {
  return wait({ page, revision: serverRevision });
}

function saveRevision(): Promise<number> {
  serverRevision += 1;
  return wait(serverRevision);
}

const QueryPanel = $component(function QueryPanel() {
  let nextPage = 2;
  const revision = $query({
    queryKey: ["docs", "revision"],
    query: fetchRevision,
    cacheTime: 0,
  }, 1);
  const save = $mutation({ mutation: saveRevision });

  async function refetch() {
    const page = nextPage;
    nextPage = page === 1 ? 2 : 1;
    await revision.refetch({ suspense: false }, page);
  }

  async function mutate() {
    await save.mutate({});
    await revision.refetch({ suspense: false }, 1);
  }

  return <section class="grid gap-4">
    <div class="border-[3px] border-ink bg-mint p-5 shadow-block-sm">
      <p class="font-mono text-xs font-bold uppercase">Shared cache</p>
      <strong class="mt-2 block font-display text-3xl uppercase">Page {revision.data?.page ?? "—"} / revision {revision.data?.revision ?? "—"}</strong>
      <p class="mt-2">{revision.isRefetching ? "Refetching while data stays visible…" : "Latest successful data"}</p>
    </div>
    <div class="flex flex-wrap gap-3">
      <button class="border-[3px] border-ink bg-solar px-4 py-3 font-mono text-xs font-bold uppercase shadow-block-sm disabled:opacity-50" disabled={revision.isFetching} onClick={refetch}>Refetch page {nextPage}</button>
      <button class="border-[3px] border-ink bg-cobalt px-4 py-3 font-mono text-xs font-bold uppercase text-white shadow-block-sm disabled:opacity-50" disabled={save.isMutating} onClick={mutate}>{save.isMutating ? "Saving…" : "Mutate + refresh"}</button>
    </div>
  </section>;
});

const QueryWorkbench = $component(function QueryWorkbench() {
  return <Suspense fallback={<p class="border-[3px] border-ink bg-solar p-5 font-mono font-bold uppercase shadow-block-sm">Loading initial query…</p>}><QueryPanel /></Suspense>;
});
```

## Imperative mutations

`$mutation({ mutation, suspense? })` never runs automatically. Call `mutate(options, ...args)` to start it. The controller exposes `data`, `lastData`, `error`, `isFailed`, and `isMutating`.

Mutations may overlap and every returned promise settles independently. Only the latest invocation updates controller state; an older request settling later cannot overwrite newer data or failure state. Mutations do not invalidate query keys automatically—await the mutation and explicitly refetch the affected query as shown above.
