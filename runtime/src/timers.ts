export const MAX_TIMER_DELAY = 2_147_483_647;

export function validateTimerDelay(value: unknown, label: string, allowZero = true): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!allowZero && value === 0) ||
    value > MAX_TIMER_DELAY
  ) {
    const range = allowZero ? "a finite non-negative number" : "a positive finite number";
    throw new TypeError(`${label} must be ${range} no greater than ${MAX_TIMER_DELAY}`);
  }
  return value;
}
