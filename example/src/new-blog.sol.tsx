import { $component, $route } from "sol";
import { BlogList } from "./BlogList.tsx";
import { blogDetailRoute } from "./blog-detail.sol.tsx";
import { blogEntries, createBlogEntry } from "./blog-store.ts";
import { pageTransition } from "./transitions.ts";

const NewBlogPage = $component(function NewBlogPage() {
  let name = "";
  let content = "";
  let submitted = false;
  const nameError = submitted && !name.trim();
  const contentError = submitted && !content.trim();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    const cleanName = name.trim();
    const cleanContent = content.trim();
    if (!cleanName || !cleanContent) return;
    const entry = createBlogEntry(cleanName, cleanContent);
    blogDetailRoute.navigate({ params: { id: entry.id, from: "new" } });
  }

  return (
    <section
      class="col-start-1 row-start-1 w-full overflow-hidden rounded-[6px_14px_10px_5px] border border-rule-strong bg-paper shadow-ledger max-sm:rounded-none max-sm:border-x-0"
      $transition={pageTransition}
      aria-labelledby="new-entry-title"
    >
      <header class="border-b border-rule-strong px-6 py-8 sm:px-11 sm:py-10">
        <p class="mb-4 font-mono text-[0.6875rem] tracking-[0.11em] text-faint">
          FIELD NOTES / NEW ENTRY
        </p>
        <h1
          id="new-entry-title"
          class="max-w-2xl font-serif text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-[-0.04em]"
        >
          Put the thought on paper.
        </h1>
        <p class="mt-5 max-w-xl leading-relaxed text-pencil">
          Draft a durable note, then file it into the shared entry index.
        </p>
      </header>
      <div class="grid gap-10 px-6 py-8 sm:px-11 lg:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)] lg:py-11">
        <form class="space-y-6" onSubmit={submit} novalidate>
          <div>
            <label
              class="mb-2 block text-xs font-semibold tracking-[0.08em] text-pencil uppercase"
              htmlFor="blog-name"
            >
              Entry name
            </label>
            <input
              classNames={[
                "w-full rounded border bg-control px-4 py-3.5 font-serif text-lg placeholder:text-faint focus-visible:outline-3 focus-visible:outline-focus/50",
                { "border-correction": nameError, "border-rule-strong": !nameError },
              ]}
              id="blog-name"
              name="name"
              $bind={name}
              aria-invalid={nameError}
              aria-describedby={nameError ? "blog-name-error" : undefined}
              placeholder="A precise title"
              autocomplete="off"
            />
            {nameError && (
              <p id="blog-name-error" class="mt-2 text-sm text-correction">
                Give the entry a name.
              </p>
            )}
          </div>
          <div>
            <label
              class="mb-2 block text-xs font-semibold tracking-[0.08em] text-pencil uppercase"
              htmlFor="blog-content"
            >
              Content
            </label>
            <textarea
              classNames={[
                "min-h-56 w-full resize-y rounded border bg-control px-4 py-3.5 font-serif text-[1.0625rem] leading-relaxed placeholder:text-faint focus-visible:outline-3 focus-visible:outline-focus/50",
                { "border-correction": contentError, "border-rule-strong": !contentError },
              ]}
              id="blog-content"
              name="content"
              $bind={content}
              aria-invalid={contentError}
              aria-describedby={contentError ? "blog-content-error" : undefined}
              placeholder="Write the observation while it is still sharp..."
            ></textarea>
            {contentError && (
              <p id="blog-content-error" class="mt-2 text-sm text-correction">
                Add some content before filing.
              </p>
            )}
          </div>
          <button
            class="rounded border border-graphite bg-graphite px-6 py-3 font-semibold text-paper hover:bg-ink focus-visible:outline-3 focus-visible:outline-focus/50"
            type="submit"
          >
            File entry
          </button>
        </form>
        <BlogList entries={blogEntries.value} />
      </div>
    </section>
  );
});

export const newBlogRoute = $route({ path: "/blog/new" }, NewBlogPage);
