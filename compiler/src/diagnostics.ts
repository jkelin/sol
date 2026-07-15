import type * as t from "@babel/types";
import MagicString, { SourceMap } from "magic-string";
import type { CompilerContext } from "./context.ts";

export function mappedCode(compiler: CompilerContext, node: t.Node, code: string): string {
  const marker = `/*${compiler.mappingMarkerPrefix}${compiler.mappingOrigins.length}__*/`;
  compiler.mappingOrigins.push({ marker, originalOffset: node.start ?? 0 });
  return `${marker}${code}`;
}

export function unmappedCode(compiler: CompilerContext, code: string): string {
  const escapedPrefix = compiler.mappingMarkerPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return code.replaceAll(new RegExp(`/\\*${escapedPrefix}\\d+__\\*/`, "g"), "");
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

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return { line: low, column: offset - starts[low]! };
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
  const escapedPrefix = compiler.mappingMarkerPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`/\\*${escapedPrefix}\\d+__\\*/`, "g");
  const markerOffsets = new Map<string, number>();
  for (const match of transformed.matchAll(markerPattern)) markerOffsets.set(match[0], match.index);
  const generatedLineStarts = lineStarts(transformed);
  const originalLineStarts = lineStarts(compiler.source);
  for (const origin of compiler.mappingOrigins) {
    const markerOffset = markerOffsets.get(origin.marker);
    if (markerOffset === undefined) continue;
    const generated = positionAt(generatedLineStarts, markerOffset + origin.marker.length);
    const original = positionAt(originalLineStarts, origin.originalOffset);
    const segments = decoded.mappings[generated.line] ?? (decoded.mappings[generated.line] = []);
    const existing = segments.findIndex((segment) => segment[0] === generated.column);
    if (existing >= 0) segments.splice(existing, 1);
    segments.push([generated.column, 0, original.line, original.column]);
    segments.sort((left, right) => left[0] - right[0]);
  }
  const markersByLine = new Map<number, Array<{ start: number; end: number }>>();
  for (const origin of compiler.mappingOrigins) {
    const offset = markerOffsets.get(origin.marker);
    if (offset === undefined) continue;
    const position = positionAt(generatedLineStarts, offset);
    const markers = markersByLine.get(position.line) ?? [];
    markers.push({ start: position.column, end: position.column + origin.marker.length });
    markersByLine.set(position.line, markers);
  }
  for (const [line, markers] of markersByLine) {
    markers.sort((left, right) => left.start - right.start);
    const segments = decoded.mappings[line];
    if (!segments) continue;
    let markerIndex = 0;
    let removed = 0;
    decoded.mappings[line] = segments.flatMap((segment) => {
      while (markerIndex < markers.length && segment[0] >= markers[markerIndex]!.end) {
        const marker = markers[markerIndex++]!;
        removed += marker.end - marker.start;
      }
      const marker = markers[markerIndex];
      if (marker && segment[0] >= marker.start && segment[0] < marker.end) return [];
      const shifted = segment.slice() as typeof segment;
      shifted[0] -= removed;
      return [shifted];
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
