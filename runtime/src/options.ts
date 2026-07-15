export function snapshotOwnDataProperties(
  value: object,
  name: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unexpected = Reflect.ownKeys(descriptors).find(
    (key) => typeof key !== "string" || !allowed.includes(key),
  );
  if (unexpected !== undefined) {
    throw new TypeError(`${name} contains unknown property ${String(unexpected)}`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!descriptor) continue;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${name} ${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
