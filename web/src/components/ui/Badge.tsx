import { $component } from "solix";

export type BadgeTone = "neutral" | "solar" | "cobalt" | "tomato" | "mint";

const tones: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-paper text-ink",
  solar: "bg-solar text-ink",
  cobalt: "bg-cobalt text-white",
  tomato: "bg-tomato text-white",
  mint: "bg-mint text-ink",
};

export function badgeClass(tone: BadgeTone = "neutral"): string {
  if (!(tone in tones)) {
    throw new TypeError(`Badge tone must be one of: ${Object.keys(tones).join(", ")}`);
  }
  return `inline-flex w-fit items-center border-2 border-ink px-2.5 py-1 font-mono text-[0.625rem] font-bold uppercase tracking-wide ${tones[tone]}`;
}

export interface BadgeProps {
  readonly label: string;
  readonly tone?: BadgeTone;
}

export const Badge = $component<BadgeProps>(function Badge(props) {
  if (typeof props.label !== "string" || props.label.trim() === "") {
    throw new TypeError("Badge label must be a non-empty string");
  }
  return <span class={badgeClass(props.tone)}>{props.label}</span>;
});
