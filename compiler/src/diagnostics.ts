import type * as t from "@babel/types";
import MagicString, { SourceMap } from "magic-string";
import type { CompilerContext } from "./context.ts";

export function mappedCode(compiler: CompilerContext, node: t.Node, code: string): string {
  const marker = `/*__sol_source_${compiler.mappingOrigins.length}__*/`;
  compiler.mappingOrigins.push({ marker, originalOffset: node.start ?? 0 });
  return `${marker}${code}`;
}

export function offsetPosition(source: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}

export function generatedSourceMap(
  transformedSource: MagicString,
  transformed: string,
  compiler: CompilerContext,
  sourceContent = compiler.source,
): SourceMap {
  const decoded = transformedSource.generateDecodedMap({
    hires: true,
    source: compiler.filename,
    includeContent: true,
  });
  for (const origin of compiler.mappingOrigins) {
    const markerOffset = transformed.indexOf(origin.marker);
    if (markerOffset < 0) continue;
    const generated = offsetPosition(transformed, markerOffset + origin.marker.length);
    const original = offsetPosition(compiler.source, origin.originalOffset);
    const segments = decoded.mappings[generated.line] ?? (decoded.mappings[generated.line] = []);
    const existing = segments.findIndex((segment) => segment[0] === generated.column);
    if (existing >= 0) segments.splice(existing, 1);
    segments.push([generated.column, 0, original.line, original.column]);
    segments.sort((left, right) => left[0] - right[0]);
  }
  const markersByLine = new Map<number, Array<{ start: number; end: number }>>();
  for (const origin of compiler.mappingOrigins) {
    const offset = transformed.indexOf(origin.marker);
    if (offset < 0) continue;
    const position = offsetPosition(transformed, offset);
    const markers = markersByLine.get(position.line) ?? [];
    markers.push({ start: position.column, end: position.column + origin.marker.length });
    markersByLine.set(position.line, markers);
  }
  for (const [line, markers] of markersByLine) {
    markers.sort((left, right) => left.start - right.start);
    const segments = decoded.mappings[line];
    if (!segments) continue;
    decoded.mappings[line] = segments
      .filter(
        (segment) =>
          !markers.some((marker) => segment[0] >= marker.start && segment[0] < marker.end),
      )
      .map((segment) => {
        const removed = markers.reduce(
          (total, marker) => total + (segment[0] >= marker.end ? marker.end - marker.start : 0),
          0,
        );
        const shifted = segment.slice() as typeof segment;
        shifted[0] -= removed;
        return shifted;
      });
  }
  return new SourceMap({
    ...decoded,
    sourcesContent: (decoded.sourcesContent ?? [sourceContent]).map(() => sourceContent),
  });
}

export function codeFrame(context: CompilerContext, node: t.Node, message: string): never {
  const line = node.loc?.start.line ?? 1;
  const column = node.loc?.start.column ?? 0;
  const sourceLine = context.source.split(/\r?\n/)[line - 1] ?? "";
  const error = new SyntaxError(
    `${context.filename}:${line}:${column + 1} ${message}\n${sourceLine}\n${" ".repeat(column)}^`,
  );
  throw error;
}
