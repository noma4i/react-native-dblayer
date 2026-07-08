import type { ModelMirrorConfig, ModelMirrorTarget, StoredRowBase, StoredWriteInput } from '../types';
import { pickDefined } from '../utils/pickDefined';
import { getDbLogger } from './logger';
import { runWithoutWritePropagation } from './writePropagation';

type RuntimeStoredRow = StoredRowBase & Record<string, unknown>;
type RuntimeMirrorConfig = ModelMirrorConfig<RuntimeStoredRow, RuntimeStoredRow>;

const definedProjection = (projection: Record<string, unknown>): Record<string, unknown> =>
  pickDefined(projection, Object.keys(projection)) as Record<string, unknown>;

const buildMirrorInsert = (
  sourceName: string,
  target: ModelMirrorTarget<RuntimeStoredRow>,
  rowId: string,
  projection: Record<string, unknown>
): StoredWriteInput<RuntimeStoredRow> | null => {
  const payload = { ...projection, id: rowId } as Partial<RuntimeStoredRow> & { id: string };
  if (typeof target.buildStored !== 'function') {
    return payload as StoredWriteInput<RuntimeStoredRow>;
  }

  try {
    return target.buildStored(payload);
  } catch (error) {
    getDbLogger().error(`[${sourceName}] mirror insert skipped`, {
      target: target.collection.id,
      id: rowId,
      error
    });
    return null;
  }
};

export const createMirrorPropagator = (sourceName: string, mirrors: RuntimeMirrorConfig[] | undefined) => {
  if (!mirrors || mirrors.length === 0) return null;

  return (row: RuntimeStoredRow): void => {
    for (const mirror of mirrors) {
      const projected = mirror.project(row);
      if (projected === null) continue;

      const projection = definedProjection(projected as Record<string, unknown>);
      const target = mirror.model();
      runWithoutWritePropagation(() => {
        if (target.get(row.id)) {
          target.patch(row.id, { ...projection, id: row.id } as Partial<RuntimeStoredRow>);
          return;
        }

        const insertRow = buildMirrorInsert(sourceName, target, row.id, projection);
        if (insertRow) {
          target.insertStored(insertRow);
        }
      });
    }
  };
};
