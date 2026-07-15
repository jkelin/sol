import { $signal, assertOwnerActive, isObject, runtimeState } from "./reactivity.ts";
import { devtoolsFormCreated, devtoolsFormDisposed, devtoolsFormUpdated } from "./devtools-hook.ts";
import { hasParser, parseValue, type Parser } from "./validation.ts";
import { assertSetupActive, type Cleanup, type RenderFrame } from "./rendering.ts";
import { snapshotOwnDataProperties } from "./options.ts";

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
  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) descriptor.value = cloneFormValue(descriptor.value);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function assertFormValues(value: unknown, detail: "defaultValues" | "reset values"): void {
  if (!isObject(value) || Array.isArray(value)) {
    throw new TypeError(`$form() ${detail} must be an object`);
  }
}

export function validationFailure(error: unknown): ValidationFailure | undefined {
  if (!isObject(error)) return undefined;
  const issuesDescriptor = Object.getOwnPropertyDescriptor(error, "issues");
  if (
    !issuesDescriptor ||
    !("value" in issuesDescriptor) ||
    !Array.isArray(issuesDescriptor.value)
  ) {
    return undefined;
  }
  const normalized: ValidationIssue[] = [];
  for (const issue of issuesDescriptor.value) {
    if (!isObject(issue)) return undefined;
    const messageDescriptor = Object.getOwnPropertyDescriptor(issue, "message");
    if (
      !messageDescriptor ||
      !("value" in messageDescriptor) ||
      typeof messageDescriptor.value !== "string"
    ) {
      return undefined;
    }
    const pathDescriptor = Object.getOwnPropertyDescriptor(issue, "path");
    if (pathDescriptor && !("value" in pathDescriptor)) return undefined;
    const path = pathDescriptor?.value;
    if (path !== undefined && !Array.isArray(path)) return undefined;
    normalized.push({ message: messageDescriptor.value, path });
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
  const fields = Object.create(null) as Record<string, string[]>;
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
  const owner = runtimeState.activeOwner;
  const frame = runtimeState.activeFrame;
  if (!owner || !frame) throw new Error("$form() must be called during component setup");
  assertSetupActive(frame, "$form()");
  assertOwnerActive(owner, "$form()");
  return createForm(config, onSubmit, owner);
}

export function formInFrame<TValues extends Record<string, unknown>, TOutput>(
  frame: RenderFrame,
  config: FormConfig<TValues, TOutput>,
  onSubmit: (values: TOutput) => void | PromiseLike<void>,
): FormController<TValues> {
  assertSetupActive(frame, "$form()");
  assertOwnerActive(frame.owner, "$form()");
  return createForm(config, onSubmit, frame.owner);
}

function createForm<TValues extends Record<string, unknown>, TOutput>(
  config: FormConfig<TValues, TOutput>,
  onSubmit: (values: TOutput) => void | PromiseLike<void>,
  owner: Cleanup[] | undefined,
): FormController<TValues> {
  if (!isObject(config) || Array.isArray(config))
    throw new TypeError("$form() expects a config object");
  const snapshot = snapshotOwnDataProperties(config, "$form() config", [
    "schema",
    "defaultValues",
    "validationStrategy",
  ]);
  const defaultValues = snapshot.defaultValues;
  assertFormValues(defaultValues, "defaultValues");
  if (typeof onSubmit !== "function") throw new TypeError("$form() expects a submit function");
  const schemaValue = snapshot.schema;
  if (!hasParser(schemaValue)) {
    throw new TypeError(
      "$form() schema must be callable, expose parse() or parseAsync(), or implement Standard Schema",
    );
  }
  const schema = schemaValue as FormParser<TValues, TOutput>;
  const strategy = snapshot.validationStrategy ?? "onSubmit";
  if (strategy !== "onSubmit" && strategy !== "onBlur" && strategy !== "onInput") {
    throw new TypeError("$form() validationStrategy must be onSubmit, onBlur, or onInput");
  }

  const defaults = cloneFormValue(defaultValues as TValues);
  const values = $signal(cloneFormValue(defaults));
  const errors = $signal<Record<string, string[]>>({});
  const formErrors = $signal<string[]>([]);
  const isSubmitting = $signal(false);
  let validationId = 0;
  let disposed = false;
  const devtoolsState = (): Record<string, unknown> => ({
    values: values.value,
    errors: errors.value,
    formErrors: formErrors.value,
    isSubmitting: isSubmitting.value,
  });
  const devtoolsId = devtoolsFormCreated(strategy, devtoolsState());
  owner?.push(() => {
    disposed = true;
    validationId += 1;
    devtoolsFormDisposed(devtoolsId);
  });
  const publish = (): void => {
    if (!disposed) devtoolsFormUpdated(devtoolsId, devtoolsState());
  };

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
    if (disposed) return;
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
      if (disposed || isSubmitting.value) return false;
      isSubmitting.value = true;
      publish();
      try {
        const result = await validate();
        if (!result.valid || !result.current) return false;
        await onSubmit(result.output);
        return !disposed;
      } finally {
        if (!disposed) {
          isSubmitting.value = false;
          publish();
        }
      }
    },
    async handleInput(domEvent: Event): Promise<void> {
      if (disposed) return;
      if (strategy === "onInput") await validate();
      else {
        validationId += 1;
        clearErrors(eventField(domEvent));
      }
      publish();
    },
    async handleBlur(_event: FocusEvent): Promise<void> {
      if (disposed) return;
      if (strategy === "onBlur") await validate();
      publish();
    },
    reset(nextValues?: TValues): void {
      if (disposed) return;
      if (nextValues !== undefined) assertFormValues(nextValues, "reset values");
      validationId += 1;
      values.value = cloneFormValue(nextValues ?? defaults);
      clearErrors();
      publish();
    },
    clearErrors,
  };
  return controller;
}
