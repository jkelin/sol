import { compareSpecificityVectors } from "./specificity.ts";

export interface RouteSpecificityDescriptor {
  readonly path: string;
  readonly compiled: {
    readonly specificity: readonly number[];
  };
}

export interface StaticRouteDescriptor extends RouteSpecificityDescriptor {
  readonly compiled: {
    readonly pattern: string;
    readonly specificity: readonly number[];
  };
  readonly assetKey: string;
}

export function compareRouteSpecificity(
  left: RouteSpecificityDescriptor,
  right: RouteSpecificityDescriptor,
): number {
  return (
    compareSpecificityVectors(left.compiled.specificity, right.compiled.specificity) ||
    left.path.localeCompare(right.path)
  );
}
