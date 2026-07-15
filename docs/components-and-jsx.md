---
title: Components and JSX
description: Define compiled components, pass typed props, bind events, and author DOM classes naturally.
section: Core
order: 3
---

Create components with `$component`. Props are readonly and typed; writable local declarations belong to the mounted component instance.

## Typed props and events

```sol live preview=SolarButton title="A typed component"
import { $component } from "@soljs/sol";

const SolarButton = $component<{ readonly label: string }>(function SolarButton(props) {
  let presses = 0;
  return (
    <button class="border-[3px] border-ink bg-solar px-5 py-4 font-mono text-xs font-bold uppercase shadow-block-sm" onClick={() => presses++}>
      {props.label}: {presses}
    </button>
  );
});
```

Event attributes use React-style capitalization such as `onClick`, while handlers receive browser events. Intrinsic elements accept `class`, `className`, or `classNames`.

HTML attribute identity is ASCII-case-insensitive. The compiler rejects differently cased
duplicates and reserves `data-sol-e` and `data-sol-hydration` in every casing for hydration
metadata. Component prop names remain case-sensitive.

## Conditional classes

`classNames` accepts strings, nested arrays, and object maps:

```tsx
<button classNames={["control", { "control--active": count > 0 }]}>Count</button>
```

Only use one class alias on an element. The compiler normalizes dynamic values and updates the DOM class list when its reactive inputs change.

## Component composition

General component children are not supported in the first version. Prefer explicit typed props and focused leaf components. `Head`, `Suspense`, `ErrorBoundary`, context providers, `Await`, and `Link` have compiler-specialized child contracts.

## Document head

`Head` appends its JSX children directly to `document.head` and renders no body wrapper:

```tsx
import { Head } from "@soljs/sol";

<Head>
  <title>{pageTitle}</title>
  <meta name="description" content={description} />
  <meta property="og:title" content={pageTitle} />
  <style>{pageStyles}</style>
  <script src="/analytics.js" async />
</Head>;
```

Title, metadata, styles, script attributes, and raw text update reactively. Managed blocks precede static head content so titles take effect, and newer blocks precede older blocks. Each block removes only its own nodes when disposed and preserves entries authored in the HTML document or by other mounted blocks. Overlapping entries are not deduplicated.

For SSR, provide `renderToStringAsync()` with an `onHead` callback and insert the collected string into the response document's `<head>`. Insert the returned body string into the application target. `hydrate()` then claims both trees in place, preserving the identity of server-rendered metadata, styles, and scripts while attaching reactive updates and ownership cleanup.

Scripts execute under native browser rules when inserted. Updating an inline script's text does not execute it again, and removing the element cannot undo effects caused by an earlier execution.

## DOM refs and portals

`createRef<T>()` creates an object ref whose non-reactive `current` value is assigned after its element is inserted and reset to `null` during cleanup. Intrinsic elements also accept callback refs; callbacks receive the element when attached and `null` when detached.

`Portal` renders JSX, text, and primitive children into a reactive element target without recreating them when the target changes. `GlobalPortal` renders the same child types directly under `document.body`, which is useful for dialogs, notifications, and other page-level overlays. Both preserve context, async boundaries, events, refs, and transitions.

```sol live preview=PortalDemo title="Refs and portals"
import { $component, createRef, GlobalPortal, Portal } from "@soljs/sol";

const PortalDemo = $component(function PortalDemo() {
  const target = createRef<HTMLDivElement>();
  const trigger = createRef<HTMLButtonElement>();
  let localOpen = false;
  let globalOpen = false;
  let callbackState = "detached";

  return (
    <section class="grid gap-4 border-[3px] border-ink bg-cream p-5 shadow-block-sm">
      <div class="flex flex-wrap gap-3">
        <button
          ref={trigger}
          class="border-[3px] border-ink bg-solar px-4 py-2 font-mono text-xs font-bold uppercase shadow-block-sm"
          onClick={() => (localOpen = !localOpen)}
        >
          Toggle local portal
        </button>
        <button
          class="border-[3px] border-ink bg-white px-4 py-2 font-mono text-xs font-bold uppercase"
          onClick={() => trigger.current?.focus()}
        >
          Focus the trigger
        </button>
        <button
          class="border-[3px] border-ink bg-cobalt px-4 py-2 font-mono text-xs font-bold uppercase text-white"
          onClick={() => (globalOpen = true)}
        >
          Open global portal
        </button>
      </div>

      <p data-testid="portal-ref-state" class="font-mono text-xs uppercase">Callback ref: {callbackState}</p>
      <div ref={target} class="min-h-20 border-2 border-dashed border-ink/40 bg-white p-3">
        <span class="font-mono text-xs uppercase text-pencil">Local portal target</span>
      </div>

      {localOpen && (
        <Portal target={target.current!}>
          <div
            data-testid="local-portal-content"
            ref={(element) => (callbackState = element ? "attached" : "detached")}
            class="mt-2 border-[3px] border-ink bg-solar p-4 font-bold"
          >
            Rendered through Portal
          </div>
        </Portal>
      )}

      {globalOpen && (
        <GlobalPortal>
          <div class="fixed inset-0 z-50 grid place-items-center bg-ink/55 p-6" role="dialog" aria-label="Global notice">
            <div class="border-[3px] border-ink bg-cream p-6 shadow-block">
              <p class="font-display text-2xl uppercase">Direct child of body</p>
              <button
                class="mt-4 border-[3px] border-ink bg-solar px-4 py-2 font-mono text-xs font-bold uppercase"
                onClick={() => (globalOpen = false)}
              >
                Close global portal
              </button>
            </div>
          </div>
        </GlobalPortal>
      )}
    </section>
  );
});
```

Portal targets are `Element` objects rather than selector strings. If the target expression changes, Sol validates it and moves the existing portal nodes. A target created with a ref must be available before a conditional Portal is first shown, as in the example above.

## Lists and identity

Map reactive arrays with a stable `key`:

```tsx
<ul>
  {items.map((item) => (
    <li key={item.id}>{item.label}</li>
  ))}
</ul>
```

Keys preserve DOM identity during reordering and let removed rows dispose their owned work correctly.
Compiled `.map()` calls accept exactly one synchronous, non-generator inline callback with an item
and optional index identifier. A third callback parameter is rejected because compiled keyed rows
do not expose the source collection. Named callbacks cannot refer to their own name because the
callback function boundary is removed during compilation.
