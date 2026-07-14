import { $signal, isObject, runtimeState } from "./reactivity.ts";
import { devtoolsFormCreated, devtoolsFormDisposed, devtoolsFormUpdated } from "./devtools-hook.ts";
import { hasParser, parseValue, type Parser } from "./validation.ts";

export type FormValidationStrategy = "onSubmit" | "onBlur" | "onInput";
export type FormParser<TValues extends Record<string, unknown>, TOutput> = Parser<TValues, TOutput>;

export interface FormConfig<TValues extends Record<string, unknown>, TOutput> {
  schema: FormParser<TValues, TOutput>;
  defaultValues: TValues;
  validationStrategy?: FormValidationStrategy;
}

export type FormErrors = Readonly<Record<string, readonly string[] | undefined>>;

export interface FormController<TValues extends Record<string, unknown>> {
  readonly values: TValues;
  readonly errors: FormErrors;
  readonly formErrors: readonly string[];
  readonly isSubmitting: boolean;
  submit(this: void, event?: SubmitEvent): Promise<boolean>;
  handleInput(this: void, event: Event): Promise<void>;
  handleBlur(this: void, event: FocusEvent): Promise<void>;
  reset(this: void, values?: TValues): void;
  clearErrors(this: void, field?: string): void;
}

interface ValidationIssue {
  message: string;
  path?: unknown[];
}

interface ValidationFailure {
  issues: ValidationIssue[];
}

function cloneFormValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneFormValue) as T;
  if (!isObject(value)) return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    clone[key] = cloneFormValue((value as Record<PropertyKey, unknown>)[key]);
  }
  return clone as T;
}

export function validationFailure(error: unknown): ValidationFailure | undefined {
  if (!isObject(error) || !("issues" in error)) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const normalized: ValidationIssue[] = [];
  for (const issue of issues) {
    if (!isObject(issue) || typeof (issue as { message?: unknown }).message !== "string") {
      return undefined;
    }
    const path = (issue as { path?: unknown }).path;
    if (path !== undefined && !Array.isArray(path)) return undefined;
    normalized.push({ message: (issue as { message: string }).message, path });
  }
  return { issues: normalized };
}

function issueField(path: unknown[] | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;
  const segments: string[] = [];
  for (const item of path) {
    const key = isObject(item) && "key" in item ? (item as { key?: unknown }).key : item;
    if (key !== undefined) segments.push(String(key));
  }
  return segments.length > 0 ? segments.join(".") : undefined;
}

function normalizeFormErrors(failure: ValidationFailure): {
  fields: Record<string, string[]>;
  form: string[];
} {
  const fields: Record<string, string[]> = {};
  const form: string[] = [];
  for (const issue of failure.issues) {
    const field = issueField(issue.path);
    if (field === undefined) form.push(issue.message);
    else (fields[field] ??= []).push(issue.message);
  }
  return { fields, form };
}

function eventField(domEvent: Event): string | undefined {
  const target = domEvent.target;
  if (!isObject(target) || !("name" in target)) return undefined;
  const name = (target as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export function $form<TValues extends Record<string, unknown>, TOutput>(
  config: FormConfig<TValues, TOutput>,
  onSubmit: (values: TOutput) => void | PromiseLike<void>,
): FormController<TValues> {
  if (!isObject(config) || Array.isArray(config))
    throw new TypeError("$form() expects a config object");
  if (!isObject(config.defaultValues) || Array.isArray(config.defaultValues)) {
    throw new TypeError("$form() defaultValues must be an object");
  }
  if (typeof onSubmit !== "function") throw new TypeError("$form() expects a submit function");
  const schema = config.schema;
  if (!hasParser(schema)) {
    throw new TypeError(
      "$form() schema must be callable, expose parse() or parseAsync(), or implement Standard Schema",
    );
  }
  const strategy = config.validationStrategy ?? "onSubmit";
  if (strategy !== "onSubmit" && strategy !== "onBlur" && strategy !== "onInput") {
    throw new TypeError("$form() validationStrategy must be onSubmit, onBlur, or onInput");
  }

  const defaults = cloneFormValue(config.defaultValues);
  const values = $signal(cloneFormValue(defaults));
  const errors = $signal<Record<string, string[]>>({});
  const formErrors = $signal<string[]>([]);
  const isSubmitting = $signal(false);
  let validationId = 0;
  const devtoolsState = (): Record<string, unknown> => ({
    values: values.value,
    errors: errors.value,
    formErrors: formErrors.value,
    isSubmitting: isSubmitting.value,
  });
  const devtoolsId = devtoolsFormCreated(strategy, devtoolsState());
  runtimeState.activeOwner?.push(() => devtoolsFormDisposed(devtoolsId));
  const publish = (): void => devtoolsFormUpdated(devtoolsId, devtoolsState());

  const parse = async (): Promise<TOutput> => {
    return parseValue(schema, values.value);
  };

  const validate = async (): Promise<
    { valid: true; output: TOutput; current: boolean } | { valid: false }
  > => {
    const currentValidation = ++validationId;
    try {
      const output = await parse();
      if (currentValidation === validationId) {
        errors.value = {};
        formErrors.value = [];
        publish();
      }
      return { valid: true, output, current: currentValidation === validationId };
    } catch (error) {
      const failure = validationFailure(error);
      if (!failure) throw error;
      if (currentValidation === validationId) {
        const normalized = normalizeFormErrors(failure);
        errors.value = normalized.fields;
        formErrors.value = normalized.form;
        publish();
      }
      return { valid: false };
    }
  };

  const clearErrors = (field?: string): void => {
    if (field === undefined) {
      errors.value = {};
      formErrors.value = [];
      publish();
      return;
    }
    const next = { ...errors.value };
    let changed = false;
    for (const key of Object.keys(next)) {
      if (key === field || key.startsWith(`${field}.`)) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) {
      errors.value = next;
      publish();
    }
  };

  const controller: FormController<TValues> = {
    get values() {
      return values.value;
    },
    get errors() {
      return errors.value;
    },
    get formErrors() {
      return formErrors.value;
    },
    get isSubmitting() {
      return isSubmitting.value;
    },
    async submit(domEvent?: SubmitEvent): Promise<boolean> {
      domEvent?.preventDefault();
      if (isSubmitting.value) return false;
      isSubmitting.value = true;
      publish();
      try {
        const result = await validate();
        if (!result.valid || !result.current) return false;
        await onSubmit(result.output);
        return true;
      } finally {
        isSubmitting.value = false;
        publish();
      }
    },
    async handleInput(domEvent: Event): Promise<void> {
      if (strategy === "onInput") await validate();
      else {
        validationId += 1;
        clearErrors(eventField(domEvent));
      }
      publish();
    },
    async handleBlur(_event: FocusEvent): Promise<void> {
      if (strategy === "onBlur") await validate();
      publish();
    },
    reset(nextValues?: TValues): void {
      validationId += 1;
      values.value = cloneFormValue(nextValues ?? defaults);
      clearErrors();
      publish();
    },
    clearErrors,
  };
  return controller;
}
