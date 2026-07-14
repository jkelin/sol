import type { HttpRouteInput } from "solix";
import * as v from "valibot";

const schemaImplementationMarker = "SOLIX_BACKEND_SCHEMA_VALIDATOR_DO_NOT_SHIP";
const backendSecret = "SOLIX_BACKEND_SECRET_DO_NOT_SHIP";

const pageTuple = v.tuple([v.pipe(v.number(), v.integer(), v.minValue(1))]);
const titleTuple = v.tuple([v.pipe(v.string(), v.trim(), v.minLength(1))]);

export function notesPageSchema(input: readonly [number]): [number] {
  if (!Array.isArray(input)) throw new TypeError(schemaImplementationMarker);
  return v.parse(pageTuple, input);
}

export function noteTitleSchema(input: readonly [string]): [string] {
  if (!Array.isArray(input)) throw new TypeError(schemaImplementationMarker);
  return v.parse(titleTuple, input);
}

export function noteHttpSchema(input: HttpRouteInput): { id: number } {
  if (!input || typeof input !== "object") throw new TypeError(schemaImplementationMarker);
  const id = Number(input.params.id);
  if (!Number.isInteger(id) || id < 1) throw { issues: [{ message: "Invalid note id" }] };
  return { id };
}

export function verifyNotesBackendSecret(value: unknown): void {
  if (value === backendSecret) throw new Error(backendSecret);
}
