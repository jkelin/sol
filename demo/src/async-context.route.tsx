import { $component, $context, $route, Await, ErrorBoundary, Suspense } from "frontend-framework";

interface ShowcaseContextData {
  accent: string;
  visits: number;
}

const showcaseContext = $context<ShowcaseContextData>();

function delayed<T>(value: T, milliseconds: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
}

const OptionalContextStatus = $component(function OptionalContextStatus() {
  const context = showcaseContext.useOptional();
  return (
    <p class="font-mono text-xs text-pencil" data-testid="optional-context">
      Optional context outside the provider: {context ? "available" : "undefined"}
    </p>
  );
});

const ContextConsumer = $component(function ContextConsumer() {
  const context = showcaseContext.use();
  return (
    <button
      class="rounded border border-rule-strong bg-control px-3 py-2 font-mono text-xs uppercase hover:bg-paper-inset"
      data-testid="context-consumer"
      onClick={() => (context.visits += 1)}
    >
      {context.accent} context · visits {context.visits}
    </button>
  );
});

const AsyncNote = $component(async function AsyncNote() {
  const context = showcaseContext.use();
  const note = await delayed(
    { title: "Async component", body: "Its setup awaited data before producing this block." },
    450,
  );
  return (
    <article class="rounded border border-rule bg-paper-inset p-5" data-testid="async-component">
      <p class="font-mono text-[0.625rem] tracking-[0.16em] text-correction uppercase">
        {context.accent}
      </p>
      <h2 class="mt-2 font-serif text-2xl text-ink">{note.title}</h2>
      <p class="mt-2 text-sm leading-6 text-pencil">{note.body}</p>
    </article>
  );
});

const AsyncContextPage = $component(function AsyncContextPage() {
  const shared = { accent: "Provider-backed", visits: 0 };
  const awaitedNote = delayed(
    { title: "Await render function", body: "The resolved value is passed into JSX children." },
    650,
  );

  return (
    <section class="w-full px-6 sm:px-0" data-testid="async-context-page">
      <header class="border-b border-rule-strong pb-6">
        <p class="font-mono text-xs tracking-[0.14em] text-correction uppercase">
          Runtime composition
        </p>
        <h1 class="mt-2 font-serif text-4xl font-normal tracking-tight text-ink">
          Context and async rendering
        </h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-pencil">
          One Suspense boundary waits for an async component and an Await block while both retain
          the nearest context provider.
        </p>
        <div class="mt-4">
          <OptionalContextStatus />
        </div>
      </header>

      <showcaseContext.Provider data={shared}>
        <ErrorBoundary
          fallback={(error) => (
            <p class="mt-6 rounded border border-correction p-4 text-correction" role="alert">
              Boundary: {String(error)}
            </p>
          )}
        >
          <div class="mt-6">
            <ContextConsumer />
          </div>
          <Suspense
            fallback={
              <div
                class="mt-6 rounded border border-rule-strong bg-paper p-8 font-mono text-sm text-pencil"
                data-testid="async-loading"
              >
                Loading both async regions…
              </div>
            }
            error={(error) => (
              <p class="mt-6 rounded border border-correction p-4 text-correction" role="alert">
                Suspense: {String(error)}
              </p>
            )}
          >
            <div class="mt-6 grid gap-4 md:grid-cols-2" data-testid="async-results">
              <AsyncNote />
              <Await
                $promise={awaitedNote}
                error={(error) => (
                  <p class="rounded border border-correction p-4 text-correction" role="alert">
                    Await: {String(error)}
                  </p>
                )}
              >
                {(note) => (
                  <article
                    class="rounded border border-rule bg-paper-inset p-5"
                    data-testid="await-result"
                  >
                    <p class="font-mono text-[0.625rem] tracking-[0.16em] text-correction uppercase">
                      {shared.accent}
                    </p>
                    <h2 class="mt-2 font-serif text-2xl text-ink">{note.title}</h2>
                    <p class="mt-2 text-sm leading-6 text-pencil">{note.body}</p>
                  </article>
                )}
              </Await>
            </div>
          </Suspense>
        </ErrorBoundary>
      </showcaseContext.Provider>
    </section>
  );
});

export const asyncContextRoute = $route({ path: "/async-context" }, AsyncContextPage);
