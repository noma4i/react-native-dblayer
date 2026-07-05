const inFlightMutationRegistry = new Map<string, Promise<unknown>>();

const normalizeForStableSerialization = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeForStableSerialization(item));
  }

  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([entryKey, entryValue]) => [entryKey, normalizeForStableSerialization(entryValue)] as const);

    return Object.fromEntries(normalizedEntries);
  }

  return String(value);
};

export const serializeSingleFlightValue = (value: unknown): string => {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(normalizeForStableSerialization(value));
};

export const createSingleFlightSignature = (scope: string, mutationKey: readonly unknown[], payload: unknown): string => {
  return `${scope}:${serializeSingleFlightValue(mutationKey)}:${serializeSingleFlightValue(payload)}`;
};

export const runSingleFlight = <T>(signature: string, execute: () => Promise<T>): Promise<T> => {
  const existingPromise = inFlightMutationRegistry.get(signature) as Promise<T> | undefined;
  if (existingPromise) {
    return existingPromise;
  }

  const nextPromise = Promise.resolve().then(execute);
  const trackedPromise = nextPromise.finally(() => {
    if (inFlightMutationRegistry.get(signature) === trackedPromise) {
      inFlightMutationRegistry.delete(signature);
    }
  });

  inFlightMutationRegistry.set(signature, trackedPromise);
  return trackedPromise;
};
