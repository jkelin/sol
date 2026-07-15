import type { Component } from "sol";
import type { ServerEndpoint } from "sol/compiler-runtime";

export interface RenderContext {
  readonly template: string;
  readonly development?: boolean;
}

export type RequestHandler = (request: Request, context: RenderContext) => Promise<Response>;

export interface RequestHandlerOptions {
  readonly logicalPaths?: boolean;
  readonly maxBodyBytes?: number;
}

export interface SolkitAdapterContext {
  readonly serverDirectory: string;
  readonly clientDirectory: string;
  readonly writeFile?: (file: string, source: string | Uint8Array) => void | Promise<void>;
}

export interface SolkitAdapter {
  readonly name: string;
  write(context: SolkitAdapterContext): void | Promise<void>;
}

export type StaticPaths = readonly string[];

export interface SolkitOptions {
  readonly entry: string;
  readonly exportName?: string;
  readonly adapter: SolkitAdapter;
  readonly maxBodyBytes?: number;
}

export type SolkitRoot = Component;
export type { ServerEndpoint };
