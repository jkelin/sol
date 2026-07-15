import { $component } from "@soljs/sol";

export const CounterExample = $component(function CounterExample() {
  let count = 0;
  const doubled = count * 2;

  return (
    <section aria-label="Reactive counter">
      <h4>Reactive output</h4>
      <output aria-live="polite">{count}</output>
      <p>doubled / {doubled}</p>
      <footer>
        <button type="button" disabled={count === 0} onClick={() => count--}>
          −
        </button>
        <button type="button" onClick={() => count++}>
          Add one
        </button>
      </footer>
    </section>
  );
});
