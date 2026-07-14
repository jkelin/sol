import { $component } from "solix";

export interface InputProps {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly onInput: (event: InputEvent) => void;
}

export const Input = $component<InputProps>(function Input(props) {
  if (!props.id || !props.name || !props.label) {
    throw new TypeError("Input id, name, and label are required");
  }
  return (
    <div>
      <label for={props.id} class="font-mono text-xs font-bold uppercase">
        {props.label}
      </label>
      <input
        id={props.id}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder ?? ""}
        disabled={Boolean(props.disabled)}
        aria-invalid={Boolean(props.error)}
        aria-describedby={props.error ? `${props.id}-error` : undefined}
        class="mt-2 w-full border-[3px] border-ink bg-cream px-4 py-3 outline-none transition placeholder:text-muted focus:border-cobalt focus:ring-4 focus:ring-solar disabled:cursor-not-allowed disabled:opacity-60"
        onInput={props.onInput}
      />
      <p
        id={`${props.id}-error`}
        class="mt-2 min-h-5 font-mono text-[0.6875rem] font-bold text-tomato"
        role="alert"
      >
        {props.error ?? ""}
      </p>
    </div>
  );
});
