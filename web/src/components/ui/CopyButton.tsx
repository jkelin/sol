import { $component } from "sol";
import { buttonClass } from "./Button.tsx";

export interface CopyButtonProps {
  readonly text: string;
  readonly label?: string;
}

export const CopyButton = $component<CopyButtonProps>(function CopyButton(props) {
  if (typeof props.text !== "string") throw new TypeError("CopyButton text must be a string");
  let status = "idle" as "idle" | "copied" | "failed";

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.text);
      status = "copied";
      window.setTimeout(() => (status = "idle"), 1800);
    } catch {
      status = "failed";
    }
  }

  return (
    <span class="inline-flex items-center gap-3">
      <button type="button" class={buttonClass("outline", "sm")} onClick={copy}>
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Select code"
            : (props.label ?? "Copy")}
      </button>
      <span class="sr-only" role="status" aria-live="polite">
        {status === "copied"
          ? "Code copied to clipboard"
          : status === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </span>
  );
});
