export const counterSource = `import { $component } from "solix";

const Counter = $component(function Counter() {
  let count = 0;
  const doubled = count * 2;

  return (
    <button onClick={() => count++}>
      {count} / {doubled}
    </button>
  );
});`;

export const listSource = `import { $component } from "solix";

const SolarList = $component(function SolarList() {
  let items = [{ id: 1, label: "Static template", ready: true }];

  return <ul>{items.map(item => (
    <li key={item.id}>
      <button onClick={() => item.ready = !item.ready}>
        {item.ready ? "Ready" : "Draft"} — {item.label}
      </button>
    </li>
  ))}</ul>;
});`;

export const formSource = `import { $component, $form } from "solix";
import * as v from "valibot";

const Email = v.object({
  email: v.pipe(v.string(), v.email("Enter a valid email.")),
});

const Signup = $component(function Signup() {
  const form = $form({
    schema: v.parser(Email),
    defaultValues: { email: "" },
  }, values => console.log(values));

  return <form $form={form}>
    <input name="email" $bind={form.values.email} />
    <button>Join</button>
  </form>;
});`;
