/** Mutable configured-slot pair used by runtime seams (logger, transport, storage, query client, defaults, writes, tracking). */
export const createConfiguredSlot = <T>(defaultValue: T): { get: () => T; set: (value: T) => void } => {
  let current = defaultValue;
  return {
    get: () => current,
    set: value => {
      current = value;
    }
  };
};
