---
title: Transitions
description: Keep entering and retiring DOM blocks mounted for the exact duration of their CSS motion.
section: Systems
order: 9
---

Use `$transition` on an intrinsic element that can enter or leave a conditional, keyed list, or route. Each phase is a whitespace-separated CSS class string.

```sol live preview=TransitionDemo title="Conditional enter and leave"
import { $component, type Transition } from "sol";

const fade: Transition = {
  enter: "example-enter",
  leave: "example-leave",
};

const TransitionDemo = $component(function TransitionDemo() {
  let visible = true;
  return (
    <section>
      <button class="border-[3px] border-ink bg-solar px-4 py-3 font-mono text-xs font-bold uppercase shadow-block-sm" onClick={() => visible = !visible}>Toggle block</button>
      <div class="mt-6 min-h-28">{visible && <div $transition={fade} class="border-[3px] border-ink bg-cobalt p-6 font-display text-2xl uppercase text-white shadow-block-sm">Precise motion</div>}</div>
    </section>
  );
});
```

Transitions run only for updates after the first render. Leave animations keep their DOM mounted until every transitioned descendant finishes. Re-adding the same conditional branch or keyed-list key cancels its leave and reuses the existing DOM.

Reduced-motion preferences and browsers without `Element.getAnimations()` fall back to immediate insertion and removal.

## CSS phases

```css
.example-enter {
  animation: example-in 180ms ease-out both;
}
.example-leave {
  animation: example-out 140ms ease-in both;
}
```

The application owns the visual CSS; Sol owns lifecycle timing and cancellation.
