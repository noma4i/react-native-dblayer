import type { StoredRowBase } from '../types';

export type ModelWriteKind = 'insert' | 'update';

export type ModelWritePropagator<TRow extends StoredRowBase = StoredRowBase> = (row: TRow, kind: ModelWriteKind) => void;

let propagationDepth = 0;

export const isWritePropagationActive = (): boolean => propagationDepth > 0;

export const runWithoutWritePropagation = <T>(fn: () => T): T => {
  propagationDepth += 1;
  try {
    return fn();
  } finally {
    propagationDepth = Math.max(0, propagationDepth - 1);
  }
};

export const createWritePropagation = <TRow extends StoredRowBase = StoredRowBase>() => {
  const propagators: Array<ModelWritePropagator<TRow>> = [];

  return {
    register(propagator: ModelWritePropagator<TRow>): void {
      propagators.push(propagator);
    },
    announce(row: TRow, kind: ModelWriteKind): void {
      if (propagationDepth > 0 || propagators.length === 0) return;

      propagationDepth += 1;
      try {
        for (const propagator of propagators) {
          propagator(row, kind);
        }
      } finally {
        propagationDepth = Math.max(0, propagationDepth - 1);
      }
    }
  };
};
