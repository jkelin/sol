import { $component, $route } from "sol";
import { DocsContent, docs } from "virtual:sol-docs";
import { Badge, buttonClass } from "./components/ui/index.ts";
import { siteHref } from "./urls.ts";

const DocsPage = $component(function DocsPage() {
  let sidebarOpen = false;
  let returnFocus: HTMLElement | null = null;

  function openSidebar(event: MouseEvent): void {
    returnFocus = event.currentTarget as HTMLElement;
    sidebarOpen = true;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#mobile-docs-close")?.focus());
  }

  function closeSidebar(): void {
    sidebarOpen = false;
    document.body.style.removeProperty("overflow");
    requestAnimationFrame(() => returnFocus?.focus());
  }

  function handleSheetKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebar();
      return;
    }
    if (event.key !== "Tab") return;
    const sheet = event.currentTarget as HTMLElement;
    const focusable = [...sheet.querySelectorAll<HTMLElement>("button, a[href]")].filter(
      (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const slug = docsDetailRoute.isActive ? docsDetailRoute.params.slug : docs[0]!.slug;
  const currentIndex = docs.findIndex((document) => document.slug === slug);
  const current = currentIndex >= 0 ? docs[currentIndex] : undefined;
  const previous = currentIndex > 0 ? docs[currentIndex - 1] : undefined;
  const next =
    currentIndex >= 0 && currentIndex < docs.length - 1 ? docs[currentIndex + 1] : undefined;

  return (
    <main id="main" class="sunblock-container py-8 sm:py-12" data-testid="docs-shell">
      <div class="mb-7 flex items-center justify-between gap-4 border-[3px] border-ink bg-solar p-4 shadow-block-sm lg:hidden">
        <div>
          <p class="font-mono text-[0.625rem] font-bold uppercase text-cobalt">Field manual</p>
          <strong class="font-display text-lg uppercase">{current?.title ?? "Not found"}</strong>
        </div>
        <button
          type="button"
          class={buttonClass("outline", "sm")}
          aria-expanded={sidebarOpen}
          aria-controls="mobile-docs-sidebar"
          onClick={openSidebar}
        >
          Browse pages
        </button>
      </div>

      <div class="grid gap-10 lg:grid-cols-[17rem_minmax(0,1fr)] xl:gap-16">
        <aside
          class="sticky top-24 hidden max-h-[calc(100vh-7rem)] self-start overflow-y-auto border-[3px] border-ink bg-paper p-4 shadow-block-sm lg:block"
          aria-label="Documentation sidebar"
        >
          <p class="font-mono text-[0.625rem] font-bold uppercase tracking-[.18em] text-cobalt">
            Documentation / index
          </p>
          <nav class="mt-5 grid gap-2" aria-label="Documentation pages">
            {docs.map((document) => (
              <a
                key={document.slug}
                href={siteHref(
                  document.slug === docs[0]!.slug ? "/docs" : `/docs/${document.slug}`,
                )}
                classNames={[
                  "group border-2 border-ink p-3 transition",
                  {
                    "bg-solar shadow-block-sm": document.slug === slug,
                    "bg-cream hover:bg-mint": document.slug !== slug,
                  },
                ]}
                aria-current={document.slug === slug ? "page" : undefined}
              >
                <span class="block font-mono text-[0.5625rem] font-bold uppercase tracking-wider text-cobalt">
                  {document.section} / {String(document.order).padStart(2, "0")}
                </span>
                <span class="mt-1 block font-bold leading-tight">{document.title}</span>
              </a>
            ))}
          </nav>
        </aside>

        <section class="min-w-0">
          {current ? (
            <header class="mb-12 border-b-[4px] border-ink pb-8">
              <div class="flex flex-wrap items-center gap-3">
                <Badge label={current.section} tone="cobalt" />
                <span class="font-mono text-xs font-bold uppercase">
                  Page {String(current.order).padStart(2, "0")}
                </span>
              </div>
              <h1 class="mt-5 max-w-5xl font-display text-5xl uppercase leading-[.9] sm:text-7xl">
                {current.title}
              </h1>
              <p class="mt-5 max-w-3xl text-xl font-medium leading-relaxed">
                {current.description}
              </p>
            </header>
          ) : null}

          <DocsContent slug={slug} />

          {current ? (
            <nav
              class="mt-16 grid gap-5 border-t-[4px] border-ink pt-8 sm:grid-cols-2"
              aria-label="Adjacent documentation pages"
            >
              {previous ? (
                <a
                  class="border-[3px] border-ink bg-paper p-5 shadow-block-sm transition hover:-translate-y-1"
                  href={siteHref(
                    previous.slug === docs[0]!.slug ? "/docs" : `/docs/${previous.slug}`,
                  )}
                >
                  <span class="font-mono text-[0.625rem] font-bold uppercase text-cobalt">
                    ← Previous block
                  </span>
                  <strong class="mt-2 block font-display text-xl uppercase">
                    {previous.title}
                  </strong>
                </a>
              ) : (
                <span></span>
              )}
              {next ? (
                <a
                  class="border-[3px] border-ink bg-solar p-5 text-right shadow-block-sm transition hover:-translate-y-1"
                  href={siteHref(`/docs/${next.slug}`)}
                >
                  <span class="font-mono text-[0.625rem] font-bold uppercase text-cobalt">
                    Next block →
                  </span>
                  <strong class="mt-2 block font-display text-xl uppercase">{next.title}</strong>
                </a>
              ) : null}
            </nav>
          ) : null}
        </section>
      </div>

      <div
        classNames={["fixed inset-0 z-[70] lg:hidden", { hidden: !sidebarOpen }]}
        id="mobile-docs-sidebar"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-docs-title"
        onKeyDown={handleSheetKeyDown}
      >
        <button
          type="button"
          class="absolute inset-0 bg-ink/60"
          aria-label="Close documentation navigation"
          onClick={closeSidebar}
        ></button>
        <aside
          class="absolute inset-y-0 left-0 w-[min(88vw,22rem)] overflow-y-auto border-r-[3px] border-ink bg-cream p-5 shadow-[12px_0_0_#171711]"
          aria-label="Mobile documentation sidebar"
        >
          <div class="flex items-center justify-between gap-4 border-b-[3px] border-ink pb-4">
            <strong id="mobile-docs-title" class="font-display text-xl uppercase">
              Field manual
            </strong>
            <button
              id="mobile-docs-close"
              type="button"
              class={buttonClass("solar", "sm")}
              onClick={closeSidebar}
            >
              Close ×
            </button>
          </div>
          <nav class="mt-5 grid gap-2" aria-label="Mobile documentation pages">
            {docs.map((document) => (
              <a
                key={document.slug}
                href={siteHref(
                  document.slug === docs[0]!.slug ? "/docs" : `/docs/${document.slug}`,
                )}
                classNames={[
                  "border-2 border-ink p-3",
                  {
                    "bg-solar shadow-block-sm": document.slug === slug,
                    "bg-paper": document.slug !== slug,
                  },
                ]}
                aria-current={document.slug === slug ? "page" : undefined}
                onClick={closeSidebar}
              >
                <span class="block font-mono text-[0.5625rem] font-bold uppercase text-cobalt">
                  {document.section} / {String(document.order).padStart(2, "0")}
                </span>
                <span class="mt-1 block font-bold">{document.title}</span>
              </a>
            ))}
          </nav>
        </aside>
      </div>
    </main>
  );
});

export const docsIndexRoute = $route({ path: "/docs" }, DocsPage);
export const docsDetailRoute = $route({ path: "/docs/:slug" }, DocsPage);
