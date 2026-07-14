import { $component, Link } from "solix";
import { blogDetailRoute } from "./blog-detail.sol.tsx";
import type { BlogEntry } from "./blog-store.ts";

export const BlogList = $component(function BlogList(props: { entries: BlogEntry[] }) {
  return (
    <aside
      class="border-t border-rule-strong pt-7 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8"
      aria-labelledby="entry-index-title"
    >
      <div class="mb-5 flex items-baseline justify-between gap-4">
        <h2 id="entry-index-title" class="font-serif text-2xl tracking-tight">
          Entry index
        </h2>
        <span class="font-mono text-[0.6875rem] tracking-widest text-faint uppercase">
          {props.entries.length} filed
        </span>
      </div>
      <ol class="space-y-1">
        {props.entries.map((entry) => (
          <li key={entry.id}>
            <Link route={blogDetailRoute} params={{ id: entry.id, from: "index" }}>
              <a class="group grid grid-cols-[2rem_1fr] gap-3 border-b border-rule py-4 text-graphite">
                <span class="pt-1 font-mono text-[0.6875rem] text-correction">
                  {String(entry.id).padStart(2, "0")}
                </span>
                <span>
                  <strong class="block font-serif text-lg font-normal group-hover:underline group-hover:decoration-correction/60 group-hover:underline-offset-4">
                    {entry.name}
                  </strong>
                  <span class="mt-1 block line-clamp-2 text-sm leading-relaxed text-pencil">
                    {entry.content}
                  </span>
                </span>
              </a>
            </Link>
          </li>
        ))}
      </ol>
    </aside>
  );
});
