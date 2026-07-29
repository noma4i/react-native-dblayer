export function arraysShallowEqual<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean;
export function arraysShallowEqual<TLeft, TRight>(
  left: ReadonlyArray<TLeft>,
  right: ReadonlyArray<TRight>,
  equals: (left: TLeft, right: TRight) => boolean
): boolean;
export function arraysShallowEqual(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  equals: (left: unknown, right: unknown) => boolean = Object.is
): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => equals(item, right[index])));
}
