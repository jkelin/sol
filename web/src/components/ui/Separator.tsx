import { $component } from "sol";

export interface SeparatorProps {
  readonly label?: string;
}

export const Separator = $component<SeparatorProps>(function Separator(props) {
  return (
    <div class="flex items-center gap-3" role="separator" aria-label={props.label ?? "Section"}>
      <span class="h-[3px] flex-1 bg-ink"></span>
      {props.label ? (
        <span class="font-mono text-[0.625rem] font-bold uppercase tracking-widest">
          {props.label}
        </span>
      ) : null}
      <span class="h-[3px] flex-1 bg-ink"></span>
    </div>
  );
});
