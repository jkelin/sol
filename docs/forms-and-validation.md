---
title: Forms and Validation
description: Own values, validation issues, submission state, and parsed output with one form controller.
section: Systems
order: 5
---

`$form()` owns a form's values, validation errors, and submission state. It accepts a callable parser, an object with `parse()` or `parseAsync()`, or a Standard Schema implementation such as Valibot or Zod.

```sol live preview=ContactForm title="Schema-aware submission"
import { $component, $form } from "sol";
import * as v from "valibot";

const ContactSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2, "Use at least two characters.")),
});

const ContactForm = $component(function ContactForm() {
  let accepted = "";
  const form = $form({
    schema: v.parser(ContactSchema),
    defaultValues: { name: "" },
    validationStrategy: "onSubmit",
  }, values => {
    accepted = values.name;
  });

  return (
    <form $form={form} class="border-[3px] border-ink bg-paper p-6 shadow-block-sm">
      <label for="contact-name" class="font-mono text-xs font-bold uppercase">Name</label>
      <input id="contact-name" name="name" $bind={form.values.name} aria-invalid={Boolean(form.errors.name)} class="mt-2 w-full border-[3px] border-ink bg-cream px-4 py-3" />
      <p class="mt-2 min-h-5 font-mono text-xs font-bold text-tomato" role="alert">{form.errors.name?.[0] ?? ""}</p>
      <button disabled={form.isSubmitting} class="mt-4 border-[3px] border-ink bg-cobalt px-4 py-3 font-mono text-xs font-bold uppercase text-white shadow-block-sm">Submit</button>
      <p class="mt-4 font-mono text-xs text-cobalt" role="status">{accepted ? `Accepted: ${accepted}` : "Waiting for parsed output."}</p>
    </form>
  );
});
```

## Connect the controller

The `$form` element property connects submit, input, and focus-out events. Successful submissions receive parsed output and do not reset automatically.

## Validation strategies

- `onSubmit` validates on submit and clears an errored field when that named field emits input.
- `onBlur` validates the complete schema on focus-out.
- `onInput` validates the complete schema on each input event.

Field issues are grouped into message arrays by dotted path. Pathless issues live in `form.formErrors`. Async validation ignores stale results after a newer input, reset, or submission.
