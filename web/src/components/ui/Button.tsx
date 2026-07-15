import { $component } from "@soljs/sol";

export type ButtonVariant = "primary" | "solar" | "outline" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-cobalt text-white hover:-translate-y-0.5 hover:shadow-block active:translate-x-1 active:translate-y-1 active:shadow-none",
  solar:
    "bg-solar text-ink hover:-rotate-1 active:translate-x-1 active:translate-y-1 active:shadow-none",
  outline:
    "bg-paper text-ink hover:bg-mint active:translate-x-1 active:translate-y-1 active:shadow-none",
  danger:
    "bg-tomato text-white hover:-translate-y-0.5 active:translate-x-1 active:translate-y-1 active:shadow-none",
};

const sizes: Readonly<Record<ButtonSize, string>> = {
  sm: "px-3 py-2 text-[0.6875rem]",
  md: "px-4 py-3 text-xs",
  lg: "px-6 py-4 text-sm",
};

function requireButtonOption<T extends string>(
  value: string,
  options: Readonly<Record<T, string>>,
  label: string,
): T {
  if (!(value in options)) {
    throw new TypeError(`${label} must be one of: ${Object.keys(options).join(", ")}`);
  }
  return value as T;
}

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  const safeVariant = requireButtonOption(variant, variants, "Button variant");
  const safeSize = requireButtonOption(size, sizes, "Button size");
  return `inline-flex items-center justify-center border-[3px] border-ink font-mono font-bold uppercase shadow-block-sm transition disabled:cursor-not-allowed disabled:translate-x-0 disabled:translate-y-0 disabled:bg-muted disabled:text-cream disabled:shadow-none ${variants[safeVariant]} ${sizes[safeSize]}`;
}

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
