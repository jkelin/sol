import type { Component } from "solix";
import type { ServerEndpoint } from "solix/compiler-runtime";

export interface RenderContext {
  readonly template: string;
  readonly development?: boolean;
}

export type RequestHandler = (request: Request, context: RenderContext) => Promise<Response>;

export interface SolkitAdapterContext {
  readonly serverDirectory: string;
  readonly clientDirectory: string;
}

export interface SolkitAdapter {
  readonly name: string;
  write(context: SolkitAdapterContext): void | Promise<void>;
}

export interface SolkitOptions {
  readonly entry: string;
  readonly exportName?: string;
  readonly adapter: SolkitAdapter;
}

export type SolkitRoot = Component;
export type { ServerEndpoint };
