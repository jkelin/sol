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

export function parseRoutePath(context: CompilerContext, node: t.StringLiteral): ParsedRoutePath {
  const path = node.value;
  if (!path.startsWith("/") || path.startsWith("//")) {
    codeFrame(context, node, "Route paths must start with exactly one slash");
  }
  if (path.includes("#")) codeFrame(context, node, "Route paths must not contain a hash");
  const parts = path.split("?");
  if (parts.length > 2) codeFrame(context, node, "Route paths may contain only one query template");
  const pathname = parts[0]!;
  const query = parts[1];
  if (pathname !== "/" && (pathname.endsWith("/") || pathname.includes("//"))) {
    codeFrame(context, node, "Route paths must not contain empty or trailing segments");
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
              return escapeRegExp(segment);
            }
            const name = segment.slice(1);
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
              codeFrame(context, node, `Invalid route parameter ${segment}`);
            }
            if (parameterNames.includes(name)) {
              codeFrame(context, node, `Duplicate route parameter ${name}`);
            }
            parameterNames.push(name);
            pathnameParameterNames.push(name);
            specificity.push(0);
            return "([^/]+)";
          })
          .join("/");

  if (query !== undefined) {
    if (!query) codeFrame(context, node, "Route query templates must not be empty");
    const queryKeys = new Set<string>();
    for (const part of query.split("&")) {
      const match = /^([A-Za-z_$][A-Za-z0-9_$-]*)=:([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
      if (!match) {
        codeFrame(context, node, `Invalid route query parameter ${part}`);
      }
      const [, key, name] = match;
      if (queryKeys.has(key!)) codeFrame(context, node, `Duplicate route query key ${key}`);
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
