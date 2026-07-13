import type { Transition } from "solix";

export const pageTransition: Transition = {
  enter: "page-enter",
  leave: "page-leave",
};

export const todoTransition: Transition = {
  enter: "todo-enter",
  leave: "todo-leave",
};
