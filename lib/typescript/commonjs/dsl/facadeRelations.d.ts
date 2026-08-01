import type { AssociationData, AssociationStored, DbReadOptions, DbWhere, FacadeRuntimeModel, LoadingState, QueryHandle, Relation, RelationDecl, RelationResult, ScopeQueryHandle } from '../types';
/**
 * Every way a model exposes rows becomes the same `Relation`: a named relation with or without a
 * remote half, an ad-hoc filter, a list of ids, or a declared association. One shape for all of
 * them is what lets a consumer read any of them without knowing which kind it holds.
 */
export declare const localLoadingState: (hasData: boolean) => LoadingState;
export declare const createLocalResult: <TData>(data: TData, hasData: boolean, hasMore: boolean, loadMore: () => void) => RelationResult<TData>;
export declare const createNamedRelation: <TStored extends {
    id: string;
}, TInput>(runtime: FacadeRuntimeModel<TStored, TInput>, name: string, params: Record<string, unknown> | null, query: ScopeQueryHandle<TStored, Record<string, unknown>> | QueryHandle<TStored, Record<string, unknown>, TStored | undefined> | undefined, remoteType: "connection" | "list" | "single" | undefined) => Relation<TStored, TStored[] | TStored | undefined, TInput>;
export declare const createWhereRelation: <TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput>(runtime: FacadeRuntimeModel<TStored, TInput>, where: DbWhere<TStored>, options?: DbReadOptions<TStored>) => Relation<TStored, TStored[], TInput>;
export declare const createByIdsRelation: <TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput>(runtime: FacadeRuntimeModel<TStored, TInput>, ids: readonly string[] | null | undefined) => Relation<TStored, TStored[], TInput>;
export declare const createAssociationRelation: <TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput, TDefinition extends RelationDecl<unknown>>(runtime: FacadeRuntimeModel<TStored, TInput>, name: string, id: string | null | undefined) => Relation<AssociationStored<TDefinition>, AssociationData<TDefinition>>;
//# sourceMappingURL=facadeRelations.d.ts.map