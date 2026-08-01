import { isWhereOperatorValue, matchesDbWhere } from '../core/compileDbWhere';
import type { DbWhere, ModelCriteria, ModelFieldSpecs } from '../types';
import { scalarFieldCodecs } from '../schema/fieldCodec';

export const createModelCriteria = <TRow extends Record<string, unknown>>(fields: ModelFieldSpecs): ModelCriteria<TRow> => {
  const cache = new WeakMap<object, DbWhere<TRow>>();
  const normalize = (where: DbWhere<TRow>): DbWhere<TRow> => {
    if (typeof where !== 'object' || where === null || Array.isArray(where)) return where;
    const record = where as Record<string, unknown>;
    if ('and' in record) return { and: (record.and as Array<DbWhere<TRow>>).map(normalize) } as DbWhere<TRow>;
    if ('or' in record) return { or: (record.or as Array<DbWhere<TRow>>).map(normalize) } as DbWhere<TRow>;
    if ('not' in record) return { not: normalize(record.not as DbWhere<TRow>) } as DbWhere<TRow>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const fieldSpec = fields[key];
      const operand = (raw: unknown): unknown => {
        if (raw === undefined || raw === null) return raw;
        if (key === 'id') return scalarFieldCodecs.id.read(raw);
        const normalized = fieldSpec ? fieldSpec.readValue(raw) : undefined;
        return normalized === undefined || normalized === null ? raw : normalized;
      };
      out[key] = isWhereOperatorValue(value)
        ? Object.fromEntries(Object.entries(value).map(([operator, raw]) => [operator, Array.isArray(raw) ? raw.map(operand) : operand(raw)]))
        : operand(value);
    }
    return out as DbWhere<TRow>;
  };
  const normalizeCached = (where: DbWhere<TRow>): DbWhere<TRow> => {
    if (typeof where !== 'object' || where === null) return where;
    let normalized = cache.get(where);
    if (!normalized) {
      normalized = normalize(where);
      cache.set(where, normalized);
    }
    return normalized;
  };
  return {
    // One normalization for both readers of a filter: the row predicate and the query compiler.
    normalize: normalizeCached,
    matches: (row: TRow, where: DbWhere<TRow>): boolean => matchesDbWhere(row, normalizeCached(where))
  };
};
