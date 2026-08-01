import type { DbReadOptions, DbWhere, Dependency, ModelContext, ModelCore, ModelReadBuilder } from '../types';
export declare const createModelReactiveReads: <TStored extends {
    id: string;
} & Record<string, unknown>, TInput>(options: {
    modelId: string;
    modelName: string;
    context: ModelContext<TStored>;
    defaultOrder?: DbReadOptions<TStored>["orderBy"];
    matchesCriteria(row: TStored, where: DbWhere<TStored>): boolean;
    normalizeCriteria(where: DbWhere<TStored>): DbWhere<TStored>;
    rowDep(id: string, fields?: ReadonlyArray<string>): Dependency;
    modelDep: Dependency;
    whereRead(where: DbWhere<TStored> | null): ModelReadBuilder<TStored>;
}) => ModelCore<TStored, TInput>["use"];
//# sourceMappingURL=modelReactiveReads.d.ts.map