import { getRuntimeGeneration } from '../utils/runtimeGeneration';

export const createGenerationRegistry = <T>(
  readGeneration: () => number = getRuntimeGeneration
): {
  assertCanRegister(key: string, errorMessage: string): void;
  register(key: string, value: T, errorMessage: string): () => void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  entries(): IterableIterator<[string, T]>;
  values(): IterableIterator<T>;
} => {
  const values = new Map<string, T>();
  const generations = new Map<string, number>();
  const assertCanRegister = (key: string, errorMessage: string): void => {
    const generation = readGeneration();
    if (values.has(key) && generations.get(key) === generation) throw new Error(errorMessage);
  };
  const register = (key: string, value: T, errorMessage: string): (() => void) => {
    const generation = readGeneration();
    if (values.has(key) && generations.get(key) === generation) throw new Error(errorMessage);
    values.set(key, value);
    generations.set(key, generation);
    return () => {
      if (values.get(key) !== value) return;
      values.delete(key);
      generations.delete(key);
    };
  };
  return {
    assertCanRegister,
    register,
    get: (key: string): T | undefined => values.get(key),
    has: (key: string): boolean => values.has(key),
    entries: (): IterableIterator<[string, T]> => values.entries(),
    values: (): IterableIterator<T> => values.values()
  };
};
