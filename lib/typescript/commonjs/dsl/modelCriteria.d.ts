import type { DbWhere, ModelFieldSpecs } from '../types';
type ModelCriteria<TRow extends Record<string, unknown>> = {
    matches(row: TRow, where: DbWhere<TRow>): boolean;
};
export declare const createModelCriteria: <TRow extends Record<string, unknown>>(fields: ModelFieldSpecs) => ModelCriteria<TRow>;
export {};
//# sourceMappingURL=modelCriteria.d.ts.map