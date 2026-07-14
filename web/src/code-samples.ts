export const counterSource = `import { $component, $query, $rpcQuery } from "sol";
import * as v from "valibot";

export const websiteMessage = $rpcQuery(
  "website-message",
  { schema: v.tuple([]) },
  async () => ({ message: "Validated on the Sol server." }),
);

const Counter = $component(function Counter() {
  let count = 0;
  const doubled = count * 2;
  const serverMessage = $query({
    queryKey: ["website", "message"],
    query: websiteMessage,
    enabled: false,
  });

  return (
    <>
      <button onClick={() => count++}>{count} / {doubled}</button>
      <button onClick={() => void serverMessage.refetch({ suspense: false })}>
        {serverMessage.isFetching ? "Calling server…" : "Call named RPC"}
      </button>
      {serverMessage.data && <p>{serverMessage.data.message}</p>}
    </>
  );
});`;

export const listSource = `import { $component } from "sol";

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

export const formSource = `import { $component, $form } from "sol";
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
