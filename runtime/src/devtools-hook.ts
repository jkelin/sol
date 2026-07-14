export interface ComponentMetadata {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

export interface SourceMetadata {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export type DevtoolsArea = "components" | "requests" | "router" | "forms";

export interface DevtoolsHook {
  componentCreated(metadata: ComponentMetadata, props: object, parentId?: number): number;
  componentRendered(id: number, getNodes: () => readonly Node[]): void;
  componentUpdated(id: number, props: object): void;
  componentDisposed(id: number): void;
  loaderCreated(key: string, args: readonly unknown[]): number;
  loaderUpdated(id: number, state: object): void;
  queryCreated(key: string, args: readonly unknown[], source?: SourceMetadata): number;
  queryUpdated(id: number, state: object): void;
  queryDisposed(id: number): void;
  mutationCreated(source?: SourceMetadata): number;
  mutationUpdated(id: number, state: object): void;
  mutationDisposed(id: number): void;
  formCreated(strategy: string, state: object): number;
  formUpdated(id: number, state: object): void;
  formDisposed(id: number): void;
  routerUpdated(state: object): void;
}

export const DEVTOOLS_HOOK = Symbol.for("solix.devtools.hook");

function hook(): DevtoolsHook | undefined {
  return (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK];
}

export function devtoolsComponentCreated(
  metadata: ComponentMetadata,
  props: object,
  parentId?: number,
): number {
  return hook()?.componentCreated(metadata, props, parentId) ?? 0;
}

export function devtoolsComponentRendered(id: number, getNodes: () => readonly Node[]): void {
  if (id) hook()?.componentRendered(id, getNodes);
}

export function devtoolsComponentUpdated(id: number, props: object): void {
  hook()?.componentUpdated(id, props);
}

export function devtoolsComponentPropsUpdated(props: object): void {
  if (!hook()) return;
  queueMicrotask(() => hook()?.componentUpdated(0, props));
}

export function devtoolsComponentDisposed(id: number): void {
  if (id) hook()?.componentDisposed(id);
}

export function devtoolsLoaderCreated(key: string, args: readonly unknown[]): number {
  return hook()?.loaderCreated(key, args) ?? 0;
}

export function devtoolsLoaderUpdated(id: number, state: object): void {
  if (id) hook()?.loaderUpdated(id, state);
}

export function devtoolsQueryCreated(
  key: string,
  args: readonly unknown[],
  source?: SourceMetadata,
): number {
  return hook()?.queryCreated(key, args, source) ?? 0;
}

export function devtoolsQueryUpdated(id: number, state: object): void {
  if (id) hook()?.queryUpdated(id, state);
}

export function devtoolsQueryDisposed(id: number): void {
  if (id) hook()?.queryDisposed(id);
}

export function devtoolsMutationCreated(source?: SourceMetadata): number {
  return hook()?.mutationCreated(source) ?? 0;
}

export function devtoolsMutationUpdated(id: number, state: object): void {
  if (id) hook()?.mutationUpdated(id, state);
}

export function devtoolsMutationDisposed(id: number): void {
  if (id) hook()?.mutationDisposed(id);
}

export function devtoolsFormCreated(strategy: string, state: object): number {
  return hook()?.formCreated(strategy, state) ?? 0;
}

export function devtoolsFormUpdated(id: number, state: object): void {
  if (id) hook()?.formUpdated(id, state);
}

export function devtoolsFormDisposed(id: number): void {
  if (id) hook()?.formDisposed(id);
}

export function devtoolsRouterUpdated(state: object): void {
  hook()?.routerUpdated(state);
}
