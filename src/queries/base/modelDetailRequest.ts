import type { BaseQueryCollection, CollectionModel, DbGraphQLDocument, DbRequestSingleConfig } from '../../types';
import { deriveDbKey } from '../../core/deriveDbKey';

type DetailId = string | null | undefined;
type DetailIdInput = DetailId | (() => DetailId);
type DetailEnabled = boolean | ((id: DetailId) => boolean);
type DetailVars<TVariables> = TVariables | ((id: DetailId) => TVariables);

export type ModelDetailRequestConfig<TResponse, TSelected, TResult = TSelected, TVariables = Record<string, unknown>> = {
  /** GraphQL query document. */
  query: DbGraphQLDocument<TResponse, TVariables>;
  /** Detail identifier used for derived key, default vars, and default read. */
  id: DetailIdInput;
  /** Pick the payload from response data. */
  select: (data: TResponse) => TSelected;
  /** Explicit key override. Omit to derive `deriveDbKey(model, { id })`. */
  key?: readonly unknown[];
  /** Query variables or a resolver from the detail id. Defaults to `{ id }`. */
  vars?: DetailVars<TVariables>;
  /** Source label for the default model sync. */
  contract?: string;
  /** Transform the selected payload before returning it when no `read` is configured. */
  map?: (selected: TSelected) => TResult;
  /** Side-load payload passed to the extract sink with source `query`. */
  extract?: (params: { data: TResponse; selected: TSelected }) => unknown;
  /**
   * Whether to read the row back from the model.
   * @default true
   */
  read?: boolean;
  /**
   * Gate query execution, combined with `Boolean(id)`. `false` (or a missing `id`) disables network
   * execution and fetch scheduling, while model reads remain live. Local rows still populate `data`
   * and produce phase `'ready'`; no local rows produce phase `'idle'` with `showSkeleton === false`.
   */
  enabled?: DetailEnabled;
  /** React Query freshness window in milliseconds. */
  staleTime?: number;
  /** Freshness window for known-empty DB scopes in milliseconds. */
  emptyStaleTime?: number;
  /** React Query cache garbage-collection window in milliseconds. */
  gcTime?: number;
  /** React Query remount refetch behavior. */
  refetchOnMount?: boolean;
};

const resolveDetailId = (id: DetailIdInput): DetailId => (typeof id === 'function' ? id() : id);

const resolveDetailVars = <TVariables>(id: DetailId, vars: DetailVars<TVariables> | undefined): TVariables => {
  if (typeof vars === 'function') return (vars as (id: DetailId) => TVariables)(id);
  if (vars !== undefined) return vars;
  return { id } as TVariables;
};

const resolveDetailEnabled = (id: DetailId, enabled: DetailEnabled | undefined): boolean => {
  const idEnabled = Boolean(id);
  if (enabled === undefined) return idEnabled;
  if (typeof enabled === 'function') return idEnabled && enabled(id);
  return idEnabled && enabled;
};

/**
 * Build a model-backed detail request config with derived key, vars, sync, read, and enabled fields.
 * @param model Collection model that stores and reads the detail row.
 * @param config Detail query, selection, sync, read, and React Query options.
 * @returns A single-request config whose default result type is the model stored row for reactive reads.
 */
export const modelDetailRequest = <
  TResponse,
  TStored extends { id: string; updatedAt?: string | null },
  TSelected = TStored,
  TResult = TStored | null,
  TVariables = Record<string, unknown>
>(
  model: CollectionModel<any, TStored>,
  config: ModelDetailRequestConfig<TResponse, TSelected, TResult, TVariables>
): DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables, Extract<BaseQueryCollection<TStored>, { id: DetailId }>> => {
  const id = resolveDetailId(config.id);
  const readEnabled = config.read !== false;

  return {
    query: config.query,
    key: config.key ?? deriveDbKey(model, id ? { id } : undefined),
    select: config.select,
    vars: resolveDetailVars(id, config.vars),
    sync: { model, contract: config.contract ?? 'detail' },
    ...(config.map ? { map: config.map } : {}),
    ...(config.extract ? { extract: config.extract } : {}),
    ...(readEnabled ? { read: { model, id } } : {}),
    enabled: resolveDetailEnabled(id, config.enabled),
    staleTime: config.staleTime,
    emptyStaleTime: config.emptyStaleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  };
};
