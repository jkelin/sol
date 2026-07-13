import type { SourceMap } from "magic-string";

export interface CompileResult {
  code: string;
  map: SourceMap | null;
}
