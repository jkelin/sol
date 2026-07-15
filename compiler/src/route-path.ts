import type * as t from "@babel/types";
import type { CompilerContext } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import { escapeRegExp } from "./html.ts";

export interface ParsedRoutePath {
  pattern: string;
  parameterNames: string[];
  pathnameParameterNames: string[];
  queryParameters: Array<{ key: string; name: string }>;
  specificity: number[];
}

export function canonicalizeStaticRouteSegment(segment: string): string {
  return encodeURIComponent(decodeURIComponent(segment));
}

export function compileRoutePath(path: string): ParsedRoutePath {
  if (typeof path !== "string") throw new TypeError("Route path must be a string");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Route paths must start with exactly one slash");
  }
  if (path.includes("#")) throw new TypeError("Route paths must not contain a hash");
  const parts = path.split("?");
  if (parts.length > 2) throw new TypeError("Route paths may contain only one query template");
  const pathname = parts[0]!;
  const query = parts[1];
  if (pathname !== "/" && (pathname.endsWith("/") || pathname.includes("//"))) {
    throw new TypeError("Route paths must not contain empty or trailing segments");
  }

  const parameterNames: string[] = [];
  const pathnameParameterNames: string[] = [];
  const queryParameters: Array<{ key: string; name: string }> = [];
  const specificity: number[] = [];
  const pattern =
    pathname === "/"
      ? ""
      : pathname
          .slice(1)
          .split("/")
          .map((segment) => {
            if (!segment.startsWith(":")) {
              specificity.push(1);
              let decoded: string;
              try {
                decoded = decodeURIComponent(segment);
              } catch {
                throw new TypeError(`Invalid percent encoding in route segment ${segment}`);
              }
              if (decoded === "." || decoded === "..") {
                throw new TypeError("Route paths must not contain dot segments");
              }
              return escapeRegExp(encodeURIComponent(decoded));
            }
            const name = segment.slice(1);
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
              throw new TypeError(`Invalid route parameter ${segment}`);
            }
            if (parameterNames.includes(name)) {
              throw new TypeError(`Duplicate route parameter ${name}`);
            }
            parameterNames.push(name);
            pathnameParameterNames.push(name);
            specificity.push(0);
            return "([^/]+)";
          })
          .join("/");

  if (query !== undefined) {
    if (!query) throw new TypeError("Route query templates must not be empty");
    const queryKeys = new Set<string>();
    for (const part of query.split("&")) {
      const match = /^([A-Za-z_$][A-Za-z0-9_$-]*)=:([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
      if (!match) {
        throw new TypeError(`Invalid route query parameter ${part}`);
      }
      const [, key, name] = match;
      if (queryKeys.has(key!)) throw new TypeError(`Duplicate route query key ${key}`);
      queryKeys.add(key!);
      queryParameters.push({ key: key!, name: name! });
      if (!parameterNames.includes(name!)) parameterNames.push(name!);
    }
  }

  return {
    pattern: pathname === "/" ? "^/$" : `^/${pattern}$`,
    parameterNames,
    pathnameParameterNames,
    queryParameters,
    specificity,
  };
}

export function parseRoutePath(context: CompilerContext, node: t.StringLiteral): ParsedRoutePath {
  try {
    return compileRoutePath(node.value);
  } catch (error) {
    codeFrame(context, node, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
