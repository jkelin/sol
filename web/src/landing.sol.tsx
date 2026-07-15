import { $component, $route } from "sol";
import {
  counterLines,
  counterSource,
  formLines,
  formSource,
  listLines,
  listSource,
} from "virtual:sol-code-tokens";
import { Badge, CodePanel, ExampleViewToggle, type ExampleMode } from "./components/ui/index.ts";
import { CounterExample } from "./examples/CounterExample.tsx";
import { FormExample } from "./examples/FormExample.tsx";
import { ListExample } from "./examples/ListExample.tsx";
import { siteHref } from "./urls.ts";

const CounterExampleCard = $component(function CounterExampleCard() {
  let mode = "both" as ExampleMode;

  return (
    <article class="border-[3px] border-ink bg-paper shadow-block" data-testid="counter-example">
      <header class="flex flex-col gap-4 border-b-[3px] border-ink bg-solar p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge label="01 / Reactivity" tone="neutral" />
          <h3 class="mt-3 font-display text-2xl uppercase">Normal reads. Direct updates.</h3>
        </div>
        <ExampleViewToggle mode={mode} onChange={(next) => (mode = next)} />
      </header>
      <div classNames={["grid", { "lg:grid-cols-2": mode === "both" }]}>
        <div hidden={mode === "preview"} class="min-w-0">
          <CodePanel code={counterSource} lines={counterLines} filename="CounterExample.tsx" />
        </div>
        <div
          hidden={mode === "code"}
          data-example-preview="counter"
          class="grid min-h-80 place-items-center bg-cobalt p-8 text-white"
        >
          <CounterExample />
        </div>
      </div>
    </article>
  );
});

const ListExampleCard = $component(function ListExampleCard() {
  let mode = "both" as ExampleMode;

  return (
    <article class="border-[3px] border-ink bg-paper shadow-block" data-testid="list-example">
      <header class="flex flex-col gap-4 border-b-[3px] border-ink bg-mint p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge label="02 / Deep state" tone="solar" />
          <h3 class="mt-3 font-display text-2xl uppercase">Mutate the data you own.</h3>
        </div>
        <ExampleViewToggle mode={mode} onChange={(next) => (mode = next)} />
      </header>
      <div classNames={["grid", { "lg:grid-cols-2": mode === "both" }]}>
        <div hidden={mode === "preview"} class="min-w-0">
          <CodePanel code={listSource} lines={listLines} filename="ListExample.tsx" />
        </div>
        <div
          hidden={mode === "code"}
          data-example-preview="list"
          class="grid min-h-80 place-items-center bg-cream p-6 sm:p-8"
        >
          <ListExample />
        </div>
      </div>
    </article>
  );
});

const FormExampleCard = $component(function FormExampleCard() {
  let mode = "both" as ExampleMode;

  return (
    <article class="border-[3px] border-ink bg-paper shadow-block" data-testid="form-example">
      <header class="flex flex-col gap-4 border-b-[3px] border-ink bg-tomato p-4 text-white sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge label="03 / Validation" tone="solar" />
          <h3 class="mt-3 font-display text-2xl uppercase">Parsed output crosses the boundary.</h3>
        </div>
        <ExampleViewToggle mode={mode} onChange={(next) => (mode = next)} />
      </header>
      <div classNames={["grid", { "lg:grid-cols-2": mode === "both" }]}>
        <div hidden={mode === "preview"} class="min-w-0">
          <CodePanel code={formSource} lines={formLines} filename="FormExample.tsx" />
        </div>
        <div
          hidden={mode === "code"}
          data-example-preview="form"
          class="grid min-h-80 place-items-center bg-solar p-6 sm:p-8"
        >
          <FormExample />
        </div>
      </div>
    </article>
  );
});

const LandingPage = $component(function LandingPage() {
  return (
    <main id="main">
      <section
        class="sunblock-container relative overflow-hidden pb-24 pt-14 sm:pt-20 2xl:min-h-[860px]"
        aria-labelledby="hero-title"
      >
        <div class="relative z-10 max-w-5xl">
          <div class="mb-7 flex flex-wrap items-center gap-3 font-mono text-xs font-bold uppercase tracking-wider">
            <Badge label="JSX / compiled" tone="neutral" />
            <span aria-hidden="true">→</span>
            <Badge label="static template" tone="mint" />
            <span aria-hidden="true">+</span>
            <Badge label="precise DOM ops" tone="solar" />
          </div>
          <h1
            id="hero-title"
            class="font-display text-[clamp(4.4rem,11vw,9rem)] leading-[.76] uppercase tracking-[-.07em]"
          >
            Build in
            <br />
            <span class="relative inline-block text-cobalt">
              <span class="relative z-10">sunlight.</span>
              <span
                class="absolute -bottom-2 left-1 h-6 w-full -rotate-1 bg-solar"
                aria-hidden="true"
              ></span>
            </span>
          </h1>
          <div class="mt-10 grid items-start gap-8 lg:grid-cols-[1fr_26rem]">
            <div>
              <p class="max-w-2xl text-xl font-medium leading-snug sm:text-2xl">
                Sol compiles familiar JSX into static HTML templates and fine-grained DOM
                operations. Setup runs once. Updates land exactly where data changed.
              </p>
              <div class="mt-8 flex flex-wrap gap-4">
                <a
                  href={siteHref("/docs")}
                  class="cut-corner inline-flex border-[3px] border-ink bg-cobalt px-6 py-4 font-mono text-sm font-bold uppercase text-white shadow-block transition hover:-translate-x-1 hover:-translate-y-1"
                >
                  Start assembling →
                </a>
                <a
                  href="#mechanism"
                  class="inline-flex border-[3px] border-ink bg-solar px-6 py-4 font-mono text-sm font-bold uppercase shadow-block-sm transition hover:-rotate-1"
                >
                  See the mechanism
                </a>
              </div>
              <div class="mt-8 flex max-w-lg items-center justify-between gap-4 border-[3px] border-ink bg-ink p-3 text-white shadow-block-sm">
                <code class="overflow-x-auto font-mono text-sm text-solar">bun add sol</code>
                <button
                  type="button"
                  class="border-2 border-cream px-3 py-2 font-mono text-[0.6875rem] font-bold uppercase hover:bg-cream hover:text-ink"
                  onClick={() => navigator.clipboard.writeText("bun add sol")}
                >
                  Copy
                </button>
              </div>
            </div>
            <aside class="relative -rotate-2 border-[3px] border-ink bg-paper p-5 shadow-block">
              <span class="absolute -right-3 -top-4 rotate-6 border-2 border-ink bg-tomato px-3 py-1 font-mono text-[0.625rem] font-bold uppercase text-white">
                One setup
              </span>
              <p class="font-mono text-xs font-bold uppercase text-cobalt">
                Operational note / 001
              </p>
              <p class="mt-3 text-lg font-semibold leading-snug">
                Writable declarations become signals. Derived constants become computed values. Your
                code keeps normal reads and assignments.
              </p>
            </aside>
          </div>
        </div>
        <div
          class="relative mx-auto mt-20 h-[460px] w-full max-w-[620px] 2xl:absolute 2xl:right-0 2xl:top-32 2xl:mt-0 2xl:h-[620px]"
          aria-label="Sol blocks assembling around a precise DOM output"
        >
          <div class="absolute left-1/2 top-1/2 size-[22rem] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-dashed border-ink sm:size-[30rem]"></div>
          <div class="absolute left-1/2 top-1/2 grid size-40 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[3px] border-ink bg-solar shadow-block sm:size-52">
            <div class="text-center">
              <span class="font-display text-3xl uppercase">DOM</span>
              <span class="block font-mono text-[0.625rem] font-bold uppercase">
                only what changes
              </span>
            </div>
          </div>
          <div class="absolute left-[2%] top-[5%] w-44 -rotate-3 border-[3px] border-ink bg-cobalt p-4 text-white shadow-block-sm">
            <span class="font-mono text-[0.625rem] font-bold uppercase text-solar">Block / 01</span>
            <strong class="mt-2 block font-display text-lg uppercase">Writable state</strong>
            <code class="mt-3 block font-mono text-xs">let count = 0</code>
          </div>
          <div class="absolute right-[5%] top-[12%] w-40 rotate-3 border-[3px] border-ink bg-tomato p-4 text-white shadow-block-sm">
            <span class="font-mono text-[0.625rem] font-bold uppercase text-solar">Block / 02</span>
            <strong class="mt-2 block font-display text-lg uppercase">Computed</strong>
            <code class="mt-3 block font-mono text-xs">count * 2</code>
          </div>
          <div class="absolute bottom-[4%] left-[4%] w-44 rotate-2 border-[3px] border-ink bg-mint p-4 shadow-block-sm">
            <span class="font-mono text-[0.625rem] font-bold uppercase text-cobalt">
              Block / 03
            </span>
            <strong class="mt-2 block font-display text-lg uppercase">Binding</strong>
            <code class="mt-3 block font-mono text-xs">$bind={"{state}"}</code>
          </div>
        </div>
      </section>

      <div
        class="overflow-hidden border-y-[3px] border-ink bg-ink py-3 text-cream"
        aria-hidden="true"
      >
        <div class="ticker-track flex gap-8 font-mono text-xs font-bold uppercase tracking-[.2em]">
          <span>
            Setup once ◆ Patch precisely ◆ Write normal JavaScript ◆ Deep reactive proxies ◆ Typed
            routes ◆ Schema-aware forms ◆{" "}
          </span>
          <span>
            Setup once ◆ Patch precisely ◆ Write normal JavaScript ◆ Deep reactive proxies ◆ Typed
            routes ◆ Schema-aware forms ◆{" "}
          </span>
        </div>
      </div>

      <section id="mechanism" class="bg-cobalt text-white">
        <div class="sunblock-container py-24 lg:py-32">
          <div class="grid gap-12 lg:grid-cols-[.72fr_1.28fr]">
            <div>
              <p class="font-mono text-xs font-bold uppercase tracking-[.2em] text-solar">
                01 / The mechanism
              </p>
              <h2 class="mt-4 font-display text-5xl uppercase leading-[.9] sm:text-7xl">
                Familiar in.
                <br />
                Focused out.
              </h2>
              <p class="mt-6 max-w-md text-lg text-blue-100">
                The compiler traces dependencies before code reaches the browser. The runtime gets a
                static template and only the operations needed to keep it current.
              </p>
            </div>
            <ol class="border-[3px] border-ink bg-cream text-ink shadow-[12px_12px_0_#FFD21C]">
              <li class="grid gap-4 border-b-[3px] border-ink p-6 sm:grid-cols-[4.5rem_1fr_auto] sm:items-center">
                <span class="font-display text-5xl text-tomato">01</span>
                <div>
                  <h3 class="font-display text-xl uppercase">Write a component</h3>
                  <p class="mt-1 text-sm font-medium">Plain declarations, derived values, JSX.</p>
                </div>
                <code class="w-fit bg-ink px-3 py-2 font-mono text-xs text-solar">
                  $component(fn)
                </code>
              </li>
              <li class="grid gap-4 border-b-[3px] border-ink bg-solar p-6 sm:grid-cols-[4.5rem_1fr_auto] sm:items-center">
                <span class="font-display text-5xl text-cobalt">02</span>
                <div>
                  <h3 class="font-display text-xl uppercase">Compile the graph</h3>
                  <p class="mt-1 text-sm font-medium">
                    Static template plus dependency-aware DOM work.
                  </p>
                </div>
                <span class="font-mono text-2xl font-bold">↘ ↗</span>
              </li>
              <li class="grid gap-4 p-6 sm:grid-cols-[4.5rem_1fr_auto] sm:items-center">
                <span class="font-display text-5xl text-tomato">03</span>
                <div>
                  <h3 class="font-display text-xl uppercase">Patch with precision</h3>
                  <p class="mt-1 text-sm font-medium">
                    No component rerun; dependent DOM updates directly.
                  </p>
                </div>
                <Badge label="mounted" tone="mint" />
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section
        id="examples"
        class="sunblock-container py-24 lg:py-32"
        aria-labelledby="examples-title"
      >
        <div class="flex flex-col justify-between gap-6 border-b-[4px] border-ink pb-8 lg:flex-row lg:items-end">
          <div>
            <p class="font-mono text-xs font-bold uppercase tracking-[.2em] text-cobalt">
              02 / Working assemblies
            </p>
            <h2
              id="examples-title"
              class="mt-3 font-display text-5xl uppercase leading-none sm:text-8xl"
            >
              Code with gravity.
            </h2>
          </div>
          <p class="max-w-md text-lg font-medium">
            Switch between code, preview, or both. Every preview is compiled by Sol and keeps its
            state while the panels move.
          </p>
        </div>
        <div class="mt-14 grid gap-12">
          <CounterExampleCard />
          <ListExampleCard />
          <FormExampleCard />
        </div>
      </section>

      <section class="border-y-[3px] border-ink bg-solar">
        <div class="sunblock-container py-24 lg:py-32">
          <p class="font-mono text-xs font-bold uppercase tracking-[.2em]">03 / Complete orbit</p>
          <h2 class="mt-5 max-w-5xl font-display text-5xl uppercase leading-[.88] sm:text-8xl">
            Forms, routes, async work, and motion share one precise runtime.
          </h2>
          <div class="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <a
              href={siteHref("/docs/forms-and-validation")}
              class="border-[3px] border-ink bg-paper p-5 shadow-block-sm transition hover:-translate-y-1"
            >
              <Badge label="Forms" tone="tomato" />
              <h3 class="mt-8 font-display text-2xl uppercase">Parsed output only.</h3>
              <p class="mt-3">Valibot, Zod, or any compatible parser can own validation.</p>
            </a>
            <a
              href={siteHref("/docs/routing")}
              class="border-[3px] border-ink bg-cobalt p-5 text-white shadow-block-sm transition hover:-translate-y-1"
            >
              <Badge label="Routing" tone="solar" />
              <h3 class="mt-8 font-display text-2xl uppercase">Routes know shape.</h3>
              <p class="mt-3">Compile-time discovery, typed params, browser history.</p>
            </a>
            <a
              href={siteHref("/docs/async-and-context")}
              class="border-[3px] border-ink bg-mint p-5 shadow-block-sm transition hover:-translate-y-1"
            >
              <Badge label="Async" tone="neutral" />
              <h3 class="mt-8 font-display text-2xl uppercase">Boundaries own waiting.</h3>
              <p class="mt-3">Suspense, Await, context, and errors compose directly.</p>
            </a>
            <a
              href={siteHref("/docs/transitions")}
              class="border-[3px] border-ink bg-tomato p-5 text-white shadow-block-sm transition hover:-translate-y-1"
            >
              <Badge label="Motion" tone="solar" />
              <h3 class="mt-8 font-display text-2xl uppercase">The DOM finishes moving.</h3>
              <p class="mt-3">Enter and leave phases preserve retiring content correctly.</p>
            </a>
          </div>
          <a
            href={siteHref("/docs")}
            class="mt-12 inline-flex border-[3px] border-ink bg-ink px-6 py-4 font-mono text-sm font-bold uppercase text-white shadow-[8px_8px_0_#2447D8] transition hover:-translate-y-1"
          >
            Open the field manual →
          </a>
        </div>
      </section>
    </main>
  );
});

export const landingRoute = $route({ path: "/" }, LandingPage);
