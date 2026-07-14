import { $component } from "solix";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./variants.ts";

export interface ButtonProps {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly type?: "button" | "submit" | "reset";
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
}

export const Button = $component<ButtonProps>(function Button(props) {
  if (typeof props.label !== "string" || props.label.trim() === "") {
    throw new TypeError("Button label must be a non-empty string");
  }
  const className = buttonClass(props.variant, props.size);
  return (
    <button
      type={props.type ?? "button"}
      class={className}
      disabled={Boolean(props.disabled || props.loading)}
      aria-busy={Boolean(props.loading)}
      onClick={props.onClick}
    >
      {props.loading ? "Working…" : props.label}
    </button>
  );
});
