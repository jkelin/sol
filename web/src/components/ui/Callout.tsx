import { $component } from "solix";
import { panelClass, type PanelTone } from "./variants.ts";

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
