import { $component } from "sol";

export type ExampleMode = "code" | "preview" | "both";

export interface ExampleViewToggleProps {
  readonly mode: ExampleMode;
  readonly onChange: (mode: ExampleMode) => void;
}

const modes: readonly ExampleMode[] = ["code", "preview", "both"];

export const ExampleViewToggle = $component<ExampleViewToggleProps>(
  function ExampleViewToggle(props) {
    if (!modes.includes(props.mode)) {
      throw new TypeError("Example mode must be code, preview, or both");
    }
    return (
      <div class="flex flex-wrap gap-2" aria-label="Example view" role="group">
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            classNames={[
              "border-2 border-ink px-3 py-2 font-mono text-[0.6875rem] font-bold uppercase transition",
              {
                "bg-solar text-ink shadow-block-sm": props.mode === mode,
                "bg-paper text-ink hover:bg-mint": props.mode !== mode,
              },
            ]}
            aria-pressed={props.mode === mode}
            onClick={() => props.onChange(mode)}
          >
            {mode}
          </button>
        ))}
      </div>
    );
  },
);
