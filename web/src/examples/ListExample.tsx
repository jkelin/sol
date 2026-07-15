import { $component } from "@soljs/sol";

export const ListExample = $component(function ListExample() {
  let items = [
    { id: 1, label: "Static template", ready: true },
    { id: 2, label: "Dependency graph", ready: false },
  ];

  return (
    <section aria-label="Compiler assembly list">
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={item.ready}
              onClick={() => (item.ready = !item.ready)}
            >
              <strong>{item.label}</strong>
              <small>{item.ready ? "Ready" : "Draft"}</small>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          items.push({
            id: items.length + 1,
            label: `DOM operation ${items.length + 1}`,
            ready: false,
          })
        }
      >
        Add block
      </button>
    </section>
  );
});
