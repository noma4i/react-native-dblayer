import type { StoredRowBase } from '../types';

export type ModelWriteKind = 'insert' | 'update';

export type ModelWritePropagator<TRow extends StoredRowBase = StoredRowBase> = (row: TRow, kind: ModelWriteKind) => void;

let explicitSuppressionDepth = 0;
let activeModels: Set<string> | null = null;

export const isWritePropagationActive = (): boolean => activeModels !== null;

export const runWithoutWritePropagation = <T>(fn: () => T): T => {
  explicitSuppressionDepth += 1;
  try {
    return fn();
  } finally {
    explicitSuppressionDepth = Math.max(0, explicitSuppressionDepth - 1);
  }
};

export const createWritePropagation = <TRow extends StoredRowBase = StoredRowBase>(modelName: string) => {
  const propagators: Array<ModelWritePropagator<TRow>> = [];

  return {
    register(propagator: ModelWritePropagator<TRow>): void {
      propagators.push(propagator);
    },
    announce(row: TRow, kind: ModelWriteKind): void {
      if (explicitSuppressionDepth > 0 || propagators.length === 0) return;
      const context = activeModels ?? new Set<string>();
      if (context.has(modelName)) return;
      const isRoot = activeModels === null;
      if (isRoot) activeModels = context;
      context.add(modelName);

      try {
        for (const propagator of propagators) {
          propagator(row, kind);
        }
      } finally {
        if (isRoot) activeModels = null;
      }
    }
  };
};
