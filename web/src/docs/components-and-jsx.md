---
title: Components and JSX
description: Define compiled components, pass typed props, bind events, and author DOM classes naturally.
section: Core
order: 3
---

Create components with `$component`. Props are readonly and typed; writable local declarations belong to the mounted component instance.

## Typed props and events

```solix live preview=SolarButton title="A typed component"
import { $component } from "solix";

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

## Conditional classes

`classNames` accepts strings, nested arrays, and object maps:

```tsx
<button classNames={["control", { "control--active": count > 0 }]}>Count</button>
```

Only use one class alias on an element. The compiler normalizes dynamic values and updates the DOM class list when its reactive inputs change.

## Component composition

General component children are not supported in the first version. Prefer explicit typed props and focused leaf components. `Suspense`, `ErrorBoundary`, context providers, `Await`, and `Link` have compiler-specialized child contracts.

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
