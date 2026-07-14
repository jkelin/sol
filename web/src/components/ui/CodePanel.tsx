import { $component } from "sol";
import { CopyButton } from "./CopyButton.tsx";

export interface CodeToken {
  readonly content: string;
  readonly color?: string;
}

export interface CodeLine {
  readonly tokens: readonly CodeToken[];
}

export interface CodePanelProps {
  readonly code: string;
  readonly lines: readonly CodeLine[];
  readonly filename?: string;
}

export const CodePanel = $component<CodePanelProps>(function CodePanel(props) {
  if (typeof props.code !== "string" || !Array.isArray(props.lines)) {
    throw new TypeError("CodePanel requires code and tokenized lines");
  }
  return (
    <section class="min-w-0 border-[3px] border-ink bg-ink text-white" aria-label="Code panel">
      <header class="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-cream px-4 py-3">
        <span class="font-mono text-[0.6875rem] font-bold uppercase text-solar">
          {props.filename ?? "example.tsx"}
        </span>
        <CopyButton text={props.code} label="Copy code" />
      </header>
      <pre class="max-h-[34rem] overflow-auto px-2 py-4 text-[0.76rem] leading-6 sm:px-3 sm:py-6 sm:text-[0.8125rem]">
        <code class="font-mono">
          {props.lines.map((line, lineIndex) => (
            <span key={lineIndex} class="grid grid-cols-[1.5rem_1fr] gap-2">
              <span class="select-none text-right text-white/35" aria-hidden="true">
                {lineIndex + 1}
              </span>
              <span class="min-w-max">
                {line.tokens.map((token: CodeToken, tokenIndex: number) => (
                  <span
                    key={`${lineIndex}-${tokenIndex}`}
                    style={`color:${token.color ?? "#fffaf0"}`}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
});
