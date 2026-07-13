import { $component, $route } from "frontend-framework";
import * as v from "valibot";
import { BlogList } from "./BlogList.tsx";
import { blogEntries } from "./blog-store.ts";
import { pageTransition } from "./transitions.ts";

const BlogDetailPage = $component(function BlogDetailPage() {
  const entry = blogEntries.value.find((candidate) => candidate.id === blogDetailRoute.params.id);

  return (
    <section
      class="col-start-1 row-start-1 w-full overflow-hidden rounded-[6px_14px_10px_5px] border border-rule-strong bg-paper shadow-ledger max-sm:rounded-none max-sm:border-x-0"
      $transition={pageTransition}
      aria-labelledby="blog-detail-title"
    >
      <div class="grid gap-10 px-6 py-8 sm:px-11 sm:py-11 lg:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)]">
        {entry ? (
          <article>
            <p class="mb-5 font-mono text-[0.6875rem] tracking-[0.11em] text-correction">
              FIELD NOTE / {String(entry.id).padStart(2, "0")}
            </p>
            {blogDetailRoute.params.from && (
              <p class="sr-only" data-testid="route-query-source">
                {"Opened from "}
                {blogDetailRoute.params.from}
              </p>
            )}
            <h1
              id="blog-detail-title"
              class="font-serif text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-[-0.04em]"
            >
              {entry.name}
            </h1>
            <div class="mt-8 min-h-64 border-y border-rule-strong bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_31px,var(--color-rule)_31px,var(--color-rule)_32px)] py-1 font-serif text-lg leading-8 text-graphite">
              <p>{entry.content}</p>
            </div>
          </article>
        ) : (
          <div class="grid min-h-72 place-content-center border-y border-rule-strong text-center">
            <p class="font-mono text-xs tracking-widest text-correction">
              UNFILED / {blogDetailRoute.params.id}
            </p>
            <h1 id="blog-detail-title" class="mt-4 font-serif text-4xl">
              This entry is missing.
            </h1>
            <p class="mt-3 text-pencil">Choose another note from the index.</p>
          </div>
        )}
        <BlogList entries={blogEntries.value} />
      </div>
    </section>
  );
});

export const blogDetailRoute = $route(
  {
    path: "/blog/:id?from=:from",
    schema: v.objectAsync({
      id: v.pipeAsync(
        v.string(),
        v.transform(Number),
        v.checkAsync(async (id) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return Number.isInteger(id) && id >= 1;
        }, "Entry id must be a positive integer"),
      ),
      from: v.string(),
    }),
  },
  BlogDetailPage,
);
