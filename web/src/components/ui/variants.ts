export type ButtonVariant = "primary" | "solar" | "outline" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
export type BadgeTone = "neutral" | "solar" | "cobalt" | "tomato" | "mint";
export type PanelTone = "paper" | "solar" | "cobalt" | "tomato" | "mint" | "ink";

const buttonVariants: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-cobalt text-white hover:-translate-y-0.5 hover:shadow-block active:translate-x-1 active:translate-y-1 active:shadow-none",
  solar:
    "bg-solar text-ink hover:-rotate-1 active:translate-x-1 active:translate-y-1 active:shadow-none",
  outline:
    "bg-paper text-ink hover:bg-mint active:translate-x-1 active:translate-y-1 active:shadow-none",
  danger:
    "bg-tomato text-white hover:-translate-y-0.5 active:translate-x-1 active:translate-y-1 active:shadow-none",
};

const buttonSizes: Readonly<Record<ButtonSize, string>> = {
  sm: "px-3 py-2 text-[0.6875rem]",
  md: "px-4 py-3 text-xs",
  lg: "px-6 py-4 text-sm",
};

const badgeTones: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-paper text-ink",
  solar: "bg-solar text-ink",
  cobalt: "bg-cobalt text-white",
  tomato: "bg-tomato text-white",
  mint: "bg-mint text-ink",
};

const panelTones: Readonly<Record<PanelTone, string>> = {
  paper: "bg-paper text-ink",
  solar: "bg-solar text-ink",
  cobalt: "bg-cobalt text-white",
  tomato: "bg-tomato text-white",
  mint: "bg-mint text-ink",
  ink: "bg-ink text-white",
};

function requireOption<T extends string>(
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
  const safeVariant = requireOption(variant, buttonVariants, "Button variant");
  const safeSize = requireOption(size, buttonSizes, "Button size");
  return `inline-flex items-center justify-center border-[3px] border-ink font-mono font-bold uppercase shadow-block-sm transition disabled:cursor-not-allowed disabled:translate-x-0 disabled:translate-y-0 disabled:bg-muted disabled:text-cream disabled:shadow-none ${buttonVariants[safeVariant]} ${buttonSizes[safeSize]}`;
}

export function badgeClass(tone: BadgeTone = "neutral"): string {
  const safeTone = requireOption(tone, badgeTones, "Badge tone");
  return `inline-flex w-fit items-center border-2 border-ink px-2.5 py-1 font-mono text-[0.625rem] font-bold uppercase tracking-wide ${badgeTones[safeTone]}`;
}

export function panelClass(tone: PanelTone = "paper", elevated = false): string {
  const safeTone = requireOption(tone, panelTones, "Panel tone");
  return `border-[3px] border-ink ${elevated ? "shadow-block" : ""} ${panelTones[safeTone]}`;
}
