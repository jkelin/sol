export function compareSpecificityVectors(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? -1) - (left[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}
