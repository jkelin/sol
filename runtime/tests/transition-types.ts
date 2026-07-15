import type { Transition } from "@soljs/sol";

const fade: Transition = {
  enter: "fade-in duration-100",
  leave: "fade-out duration-75",
};

void fade;

const invalid: Transition = {
  // @ts-expect-error Transition phases must be CSS class name strings.
  enter: { keyframes: [{ opacity: 0 }] },
};

void invalid;
