import type { BaseQueryCollection, BaseQueryConfig, BaseQueryResult, DbRequestSingleData } from '../../types';
type BaseQueryResolvedData<TData, TCollection extends BaseQueryCollection | undefined> = DbRequestSingleData<TData, TData, TCollection>;
export declare const useBaseQuery: <TData, TCollection extends BaseQueryCollection | undefined = undefined>(config: BaseQueryConfig<TData, TCollection>) => BaseQueryResult<BaseQueryResolvedData<TData, TCollection>>;
export {};
//# sourceMappingURL=useBaseQuery.d.ts.map