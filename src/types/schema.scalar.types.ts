/** Typed boundary for one scalar field codec outside model and shape normalization. */
export type ScalarValue<TValue> = {
  /** Convert one transport representation to its stored value or return `undefined`. */
  read: (value: unknown) => TValue | undefined;
  /** Convert one transport representation to its stored value or throw an error naming the input. */
  require: (value: unknown, label: string) => TValue;
};
