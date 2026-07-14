import { isObject, runtimeState } from "./reactivity.ts";
import type {
  DefaultRouteValues,
  LinkProps,
  RouteConfig,
  RouteDefinition,
  RouteValues,
} from "./routes.ts";
import { CONTEXT } from "./symbols.ts";
import type { RenderFrame } from "./rendering.ts";
import type { JSX } from "./jsx-runtime.ts";
import type {
  HttpRouteConfig,
  HttpRouteDefinition,
  HttpRouteInput,
  RpcArgs,
  RpcConfig,
  RpcFunction,
} from "./server-functions.ts";

export type Component<Props extends object = Record<string, never>> = (
  props: Readonly<Props>,
) => JSX.Element | Promise<JSX.Element>;

export interface Context<TShape extends object> {
  readonly Provider: Component<{ data: TShape; children?: JSX.Element | readonly JSX.Element[] }>;
  use(): TShape;
  useOptional(): TShape | undefined;
}

export interface SuspenseProps {
  readonly fallback: JSX.Element;
  readonly timeoutMs?: number;
  readonly error?: (error: unknown) => JSX.Element;
  readonly children?: JSX.Element | readonly JSX.Element[];
}

export interface AwaitProps<T> {
  readonly $promise: PromiseLike<T>;
  readonly error?: (error: unknown) => JSX.Element;
  readonly children: (data: T) => JSX.Element;
}

export interface ErrorBoundaryProps {
  readonly fallback: (error: unknown) => JSX.Element;
  readonly children?: JSX.Element | readonly JSX.Element[];
}

export interface HeadProps {
  readonly children?: JSX.Element | readonly JSX.Element[];
}

const contexts = new WeakSet<object>();

export function $component<Props extends object>(
  _setup: (props: Readonly<Props>) => JSX.Element | Promise<JSX.Element>,
): Component<Props> {
  throw new Error("$component() reached runtime. Add solix() before Vite's JSX transform.");
}

export function $context<TShape extends object>(): Context<TShape> {
  if (arguments.length !== 0) throw new TypeError("$context() does not accept a default value");
  const key = Symbol("solix.context.value");
  const Provider = (() => {
    throw new Error("Context providers must be rendered as JSX inside a compiled component");
  }) as Component<{ data: TShape; children?: JSX.Element | readonly JSX.Element[] }>;

  const read = (optional: boolean, frame?: RenderFrame): TShape | undefined => {
    const source = (frame ?? runtimeState.activeFrame)?.contexts.get(key);
    if (!source) {
      if (optional) return undefined;
      throw new Error("Context is not available outside its Provider");
    }
    return contextProxy(source) as TShape;
  };

  const context = {
    [CONTEXT]: key,
    Provider,
    use: (frame?: RenderFrame) => read(false, frame)!,
    useOptional: (frame?: RenderFrame) => read(true, frame),
  } as Context<TShape>;
  contexts.add(context);
  return Object.freeze(context);
}

export function contextUse<TShape extends object>(
  candidate: Context<TShape>,
  frame: RenderFrame,
  optional: boolean,
) {
  if (contexts.has(candidate)) {
    const internal = candidate as Context<TShape> & {
      use(frame: RenderFrame): TShape;
      useOptional(frame: RenderFrame): TShape | undefined;
    };
    return optional ? internal.useOptional(frame) : internal.use(frame);
  }
  return optional ? candidate.useOptional() : candidate.use();
}

function contextProxy(source: () => object): object {
  const target = {};
  const current = (): object => {
    const value = source();
    if (!isObject(value) || Array.isArray(value)) {
      throw new TypeError("Context Provider data must be an object");
    }
    return value;
  };
  return new Proxy(target, {
    get: (_target, key, receiver) => Reflect.get(current(), key, receiver),
    set: (_target, key, value, receiver) => Reflect.set(current(), key, value, receiver),
    deleteProperty: (_target, key) => Reflect.deleteProperty(current(), key),
    defineProperty: (_target, key, descriptor) =>
      Reflect.defineProperty(current(), key, descriptor),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(current()),
    has: (_target, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    setPrototypeOf: (_target, prototype) => Reflect.setPrototypeOf(current(), prototype),
  });
}

export const Suspense = (() => {
  throw new Error("Suspense must be rendered as JSX inside a compiled component");
}) as Component<SuspenseProps>;

export const Await = (() => {
  throw new Error("Await must be rendered as JSX inside a compiled component");
}) as <T>(props: Readonly<AwaitProps<T>>) => JSX.Element;

export const ErrorBoundary = (() => {
  throw new Error("ErrorBoundary must be rendered as JSX inside a compiled component");
}) as Component<ErrorBoundaryProps>;

export const Head = (() => {
  throw new Error("Head must be rendered as JSX inside a compiled component");
}) as Component<HeadProps>;

export function $route<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(_config: RouteConfig<Path, Values>, _candidate: Component): RouteDefinition<Path, Values> {
  throw new Error(
    "$route() reached runtime. Define exported routes in a *.sol.ts or *.sol.tsx file and add solix() to Vite.",
  );
}

export function $rpcQuery<Input extends RpcArgs, Parsed extends RpcArgs, Data>(
  _name: string,
  _config: RpcConfig<Input, Parsed>,
  _handler: (...args: Parsed) => PromiseLike<Data>,
): RpcFunction<Input, Data> {
  throw new Error(
    "$rpcQuery() reached runtime. Define it as an exported constant in a *.sol.ts or *.sol.tsx file.",
  );
}

export function $rpcMutation<Input extends RpcArgs, Parsed extends RpcArgs, Data>(
  _name: string,
  _config: RpcConfig<Input, Parsed>,
  _handler: (...args: Parsed) => PromiseLike<Data>,
): RpcFunction<Input, Data> {
  throw new Error(
    "$rpcMutation() reached runtime. Define it as an exported constant in a *.sol.ts or *.sol.tsx file.",
  );
}

export function $httpRoute<Input extends HttpRouteInput, Parsed>(
  _config: HttpRouteConfig<Input, Parsed>,
  _handler: (input: Parsed, request: Request) => Response | PromiseLike<Response>,
): HttpRouteDefinition {
  throw new Error(
    "$httpRoute() reached runtime. Define it as an exported constant in a *.sol.ts or *.sol.tsx file.",
  );
}

export function Link<const Path extends string, Values extends RouteValues>(
  _props: LinkProps<Path, Values>,
): JSX.Element {
  throw new Error("Link reached runtime. Add solix() before Vite's JSX transform.");
}
