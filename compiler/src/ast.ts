import generateModule from "@babel/generator";
import traverseModule from "@babel/traverse";

export const generate =
  (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule;
export const traverse =
  (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule;
