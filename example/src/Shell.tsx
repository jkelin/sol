import { $component, Route } from "sol";
import "./Shell.css";
import { blogDetailRoute } from "./blog-detail.sol.tsx";
import { asyncContextRoute } from "./async-context.sol.tsx";
import { todoRoute } from "./todo.sol.tsx";
import { queriesRoute } from "./queries.sol.tsx";

const Header = $component(function Header() {
  return (
    <header
      class="solkit-child-style-probe border-b border-rule-strong bg-parchment/95"
      data-testid="global-header"
    >
      <div class="mx-auto flex w-full max-w-6xl items-end justify-between gap-6 px-6 py-5 max-sm:items-start max-sm:flex-col sm:px-8">
        <a class="group" href="/" aria-label="Margin home">
          <span class="block font-mono text-[0.625rem] tracking-[0.18em] text-correction uppercase">
            Compiled notes
          </span>
          <strong class="mt-1 block font-serif text-2xl font-normal tracking-tight group-hover:underline group-hover:decoration-correction/50 group-hover:underline-offset-4">
            Margin
          </strong>
        </a>
        <nav
          class="flex gap-2 font-mono text-xs tracking-[0.05em] uppercase"
          aria-label="Primary navigation"
        >
          <a
            classNames={[
              "rounded px-3 py-2 transition-colors hover:bg-paper-inset",
              {
                "bg-paper text-graphite shadow-[inset_0_0_0_1px_var(--color-rule-strong)]":
                  todoRoute.isActive,
                "text-pencil": !todoRoute.isActive,
              },
            ]}
            href="/"
          >
            Todo
          </a>
          <a
            classNames={[
              "rounded px-3 py-2 transition-colors hover:bg-paper-inset",
              {
                "bg-paper text-graphite shadow-[inset_0_0_0_1px_var(--color-rule-strong)]":
                  blogDetailRoute.isActivePrefix,
                "text-pencil": !blogDetailRoute.isActivePrefix,
              },
            ]}
            href="/blog/new"
          >
            New entry
          </a>
          <a
            classNames={[
              "rounded px-3 py-2 transition-colors hover:bg-paper-inset",
              {
                "bg-paper text-graphite shadow-[inset_0_0_0_1px_var(--color-rule-strong)]":
                  asyncContextRoute.isActive,
                "text-pencil": !asyncContextRoute.isActive,
              },
            ]}
            href="/async-context"
          >
            Async
          </a>
          <a
            classNames={[
              "rounded px-3 py-2 transition-colors hover:bg-paper-inset",
              {
                "bg-paper text-graphite shadow-[inset_0_0_0_1px_var(--color-rule-strong)]":
                  queriesRoute.isActive,
                "text-pencil": !queriesRoute.isActive,
              },
            ]}
            href="/queries"
          >
            Queries
          </a>
        </nav>
      </div>
    </header>
  );
});

const RoutePending = $component(function RoutePending() {
  return (
    <p class="font-mono text-xs tracking-widest text-pencil uppercase" data-testid="route-pending">
      Reading route parameters…
    </p>
  );
});

export const Shell = $component(function Shell() {
  return (
    <div class="min-h-screen">
      <Header />
      <main class="mx-auto grid min-h-[calc(100vh-5.5rem)] w-full max-w-6xl place-items-start px-0 py-8 sm:px-8 sm:py-12">
        <Route pending={RoutePending} />
      </main>
    </div>
  );
});
