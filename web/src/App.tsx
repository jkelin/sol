import { $component, Route } from "sol";
import { siteHref } from "./urls.ts";

const RoutePending = $component(function RoutePending() {
  return (
    <main class="sunblock-container py-24" aria-live="polite">
      <div class="border-[3px] border-ink bg-solar p-6 font-mono text-sm font-bold uppercase shadow-block">
        Aligning route blocks…
      </div>
    </main>
  );
});

export const App = $component(function App() {
  let menuOpen = false;

  return (
    <div class="min-h-screen">
      <a
        href="#main"
        class="fixed left-4 top-4 z-[100] -translate-y-24 border-[3px] border-ink bg-solar px-4 py-3 font-mono text-xs font-bold uppercase shadow-block-sm transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <header class="sticky top-0 z-50 border-b-[3px] border-ink bg-cream/95 backdrop-blur-sm">
        <nav
          class="sunblock-container flex items-center justify-between gap-4 py-3"
          aria-label="Primary navigation"
        >
          <a href={siteHref("/")} class="group flex items-center gap-3" aria-label="Sol home">
            <span
              class="grid size-10 place-items-center rounded-full border-[3px] border-ink bg-solar transition-transform group-hover:rotate-12"
              aria-hidden="true"
            >
              <span class="size-2.5 bg-ink"></span>
            </span>
            <span class="font-display text-xl uppercase tracking-tight sm:text-2xl">Sol</span>
            <span class="hidden -rotate-2 border-2 border-ink bg-tomato px-2 py-0.5 font-mono text-[0.625rem] font-bold uppercase text-white lg:inline">
              experimental / v0
            </span>
          </a>
          <button
            type="button"
            class="border-[3px] border-ink bg-solar px-3 py-2 font-mono text-xs font-bold uppercase shadow-block-sm md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => (menuOpen = !menuOpen)}
          >
            {menuOpen ? "Close ×" : "Menu +"}
          </button>
          <div class="hidden items-center gap-6 font-mono text-xs font-bold uppercase md:flex">
            <a
              class="border-b-2 border-transparent py-2 hover:border-ink"
              href={siteHref("/#mechanism")}
            >
              How it works
            </a>
            <a
              class="border-b-2 border-transparent py-2 hover:border-ink"
              href={siteHref("/#examples")}
            >
              Examples
            </a>
            <a
              class="border-[3px] border-ink bg-cobalt px-4 py-2.5 text-white shadow-block-sm transition hover:-translate-y-0.5 hover:shadow-block"
              href={siteHref("/docs")}
            >
              Read docs →
            </a>
          </div>
        </nav>
        <nav
          id="mobile-navigation"
          classNames={["border-t-[3px] border-ink bg-solar p-4 md:hidden", { hidden: !menuOpen }]}
          aria-label="Mobile navigation"
        >
          <div class="grid gap-2 font-mono text-sm font-bold uppercase">
            <a
              class="border-2 border-ink bg-cream p-3"
              href={siteHref("/#mechanism")}
              onClick={() => (menuOpen = false)}
            >
              How it works
            </a>
            <a
              class="border-2 border-ink bg-cream p-3"
              href={siteHref("/#examples")}
              onClick={() => (menuOpen = false)}
            >
              Examples
            </a>
            <a
              class="border-2 border-ink bg-cobalt p-3 text-white"
              href={siteHref("/docs")}
              onClick={() => (menuOpen = false)}
            >
              Read docs →
            </a>
          </div>
        </nav>
      </header>
      <Route pending={RoutePending} />
      <footer class="border-t-[3px] border-ink bg-cream">
        <div class="sunblock-container flex flex-col gap-5 py-8 md:flex-row md:items-center md:justify-between">
          <div class="flex items-center gap-3">
            <span class="grid size-9 place-items-center rounded-full border-[3px] border-ink bg-solar">
              <span class="size-2 bg-ink"></span>
            </span>
            <span class="font-display text-xl uppercase">Sol</span>
          </div>
          <p class="font-mono text-[0.625rem] font-bold uppercase tracking-wider">
            Experimental JSX framework / Sunblock system
          </p>
          <p class="font-mono text-[0.625rem] uppercase">Static blocks + precise motion</p>
        </div>
      </footer>
    </div>
  );
});
