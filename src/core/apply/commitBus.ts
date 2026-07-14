export type CommitChange = { model: string; ids: string[]; scopeKeys: string[]; fields: string[] };
export type CommitListener = (changes: CommitChange[]) => void;

/** Emits exactly one semantic notification after an applied plan commits. */
export const createCommitBus = () => {
  const listeners = new Set<CommitListener>();
  return {
    subscribe: (listener: CommitListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (changes: CommitChange[]) => {
      if (!changes.length) return;
      for (const listener of listeners) listener(changes);
    }
  };
};
