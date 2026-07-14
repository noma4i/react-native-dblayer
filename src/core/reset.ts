const resetters = new Set<() => void | Promise<void>>();

/** Register runtime state that must clear on logout and account changes. */
export const registerReset = (reset: () => void | Promise<void>): (() => void) => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/** Reset every registered v6 state plane. */
export const resetRuntime = async (): Promise<void> => {
  for (const reset of resetters) await reset();
};
