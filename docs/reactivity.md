---
title: Reactivity
description: Work with inferred signals, computed values, deep proxies, bindings, and manual primitives.
section: Core
order: 4
---

Direct writable declarations inside `$component` become signals automatically. Directly derived `const` declarations become computed values.

## Deep reactive values

Arrays and plain objects are deep proxies. Nested assignments and mutating array methods remain reactive while Dates, collections, frozen objects, and class instances keep their identity.

```sol live preview=AssemblyQueue title="Deep object and array updates"
import { $component } from "@soljs/sol";

const AssemblyQueue = $component(function AssemblyQueue() {
  let blocks = [
    { id: 1, label: "Template", ready: true },
    { id: 2, label: "DOM operation", ready: false },
  ];

  return (
    <section>
      <ul class="grid gap-3">
        {blocks.map((block) => (
          <li key={block.id}>
            <button classNames={["flex w-full justify-between border-[3px] border-ink p-4 font-bold shadow-block-sm", { "bg-mint": block.ready, "bg-paper": !block.ready }]} onClick={() => block.ready = !block.ready}>
              <span>{block.label}</span><span class="font-mono text-xs uppercase">{block.ready ? "Ready" : "Draft"}</span>
            </button>
          </li>
        ))}
      </ul>
      <button class="mt-5 border-[3px] border-ink bg-cobalt px-4 py-3 font-mono text-xs font-bold uppercase text-white shadow-block-sm" onClick={() => blocks.push({ id: blocks.length + 1, label: `Block ${blocks.length + 1}`, ready: false })}>Add block</button>
    </section>
  );
});
```

## Form bindings

Use `$bind={state}` on inputs, textareas, and selects. Static checkbox and radio input types bind
`checked` regardless of casing; other supported controls bind `value`. A textarea controlled by
`value` or `$bind` cannot also have children.

```tsx
<input name="title" $bind={title} />
<input type="checkbox" $bind={complete} />
```

## Manual state

State created outside compiled components uses `$signal()` and `$computed()` with `.value`. Reach for these when state must outlive or sit outside a component-owned setup frame.
