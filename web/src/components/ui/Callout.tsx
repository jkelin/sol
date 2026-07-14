import { $component } from "sol";

export type PanelTone = "paper" | "solar" | "cobalt" | "tomato" | "mint" | "ink";

const tones: Readonly<Record<PanelTone, string>> = {
  paper: "bg-paper text-ink",
  solar: "bg-solar text-ink",
  cobalt: "bg-cobalt text-white",
  tomato: "bg-tomato text-white",
  mint: "bg-mint text-ink",
  ink: "bg-ink text-white",
};

export function panelClass(tone: PanelTone = "paper", elevated = false): string {
  if (!(tone in tones)) {
    throw new TypeError(`Panel tone must be one of: ${Object.keys(tones).join(", ")}`);
  }
  return `border-[3px] border-ink ${elevated ? "shadow-block" : ""} ${tones[tone]}`;
}

export interface CalloutProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly tone?: PanelTone;
}

export const Callout = $component<CalloutProps>(function Callout(props) {
  if (!props.eyebrow || !props.title || !props.body) {
    throw new TypeError("Callout eyebrow, title, and body are required");
  }
  return (
    <aside class={`${panelClass(props.tone ?? "mint", true)} p-5`}>
      <p class="font-mono text-[0.6875rem] font-bold uppercase tracking-wider">{props.eyebrow}</p>
      <h3 class="mt-3 font-display text-2xl uppercase leading-none">{props.title}</h3>
      <p class="mt-3 leading-relaxed">{props.body}</p>
    </aside>
  );
});
