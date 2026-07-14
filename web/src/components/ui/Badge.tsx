import { $component } from "solix";
import { badgeClass, type BadgeTone } from "./variants.ts";

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
