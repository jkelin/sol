import { $component, $form } from "sol";
import * as v from "valibot";

const emailSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email("Enter a valid email address.")),
});

export const FormExample = $component(function FormExample() {
  let submitted = "";
  const form = $form(
    {
      schema: v.parser(emailSchema),
      defaultValues: { email: "" },
      validationStrategy: "onSubmit",
    },
    (values) => {
      submitted = values.email;
    },
  );

  return (
    <form $form={form}>
      <label for="landing-email">Email address</label>
      <input
        id="landing-email"
        name="email"
        type="email"
        $bind={form.values.email}
        aria-invalid={Boolean(form.errors.email)}
        aria-describedby="landing-email-error"
        placeholder="you@example.com"
      />
      <p id="landing-email-error" role="alert">
        {form.errors.email?.[0] ?? ""}
      </p>
      <button type="submit" disabled={form.isSubmitting}>
        Validate
      </button>
      <p role="status" aria-live="polite">
        {submitted ? `Accepted: ${submitted}` : "Only parsed output reaches submit."}
      </p>
    </form>
  );
});
