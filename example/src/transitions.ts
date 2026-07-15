import type { Transition } from "@soljs/sol";

export const pageTransition: Transition = {
  enter: "page-enter",
  leave: "page-leave",
};

export const todoTransition: Transition = {
  enter: "todo-enter",
  leave: "todo-leave",
};
