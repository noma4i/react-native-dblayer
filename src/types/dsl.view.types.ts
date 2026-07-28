import type { ScopeHandle } from './dsl.model.types';
import type { KeepPreviousOption } from './read.scopeRetention.types';

/** Minimal snapshot reader accepted by computed view includes. Method syntax keeps concrete model readers assignable under strict function variance. */
export type ViewIncludeModel = {
  modelId: string;
  find(id: string): { id: string } | null | undefined;
  all(): Array<{ id: string }>;
};

/** One declared-relation or computed-id include specification for a typed view source row. */
export type ViewIncludeSpec<TRow, TIncluded = Record<string, unknown>> =
  | string
  | {
      require?: readonly string[];
      /** Preserve delivered related-row references while these stored keys remain shallow-equal. */
      renderKeys?: readonly (keyof (NonNullable<TIncluded> extends readonly (infer TElement)[] ? NonNullable<TElement> : NonNullable<TIncluded>) & string)[];
    }
  | [ViewIncludeModel, (row: TRow) => string | string[] | null]
  | {
      model: ViewIncludeModel;
      ids: (row: TRow) => string | string[] | null;
      require?: readonly string[];
      /** Preserve delivered target-row references while these stored keys remain shallow-equal. */
      renderKeys?: readonly (keyof (NonNullable<TIncluded> extends readonly (infer TElement)[] ? NonNullable<TElement> : NonNullable<TIncluded>) & string)[];
    };

/**
 * Typed configuration for a model-owned joined projection.
 *
 * Declare both output and include shapes when includes are consumed, for example
 * `ChatModel.view<ChatListItem, { lastMessage: StoredMessage | null; users: UserData[] }>(...)`.
 * TypeScript cannot partially infer the second type argument after an explicit output type.
 */
export type ViewConfig<TRow extends { id: string }, TIncluded extends Record<string, unknown>, TItem> = {
  /** Declared scope name or scope handle on the model that owns the view. */
  source: string | ScopeHandle<TRow, Record<string, unknown>>;
  /** Declared relation names or explicit target-model id resolvers keyed by the projection alias. An include may require stored fields: `undefined` is missing and `null` is present; incomplete related rows are delivered as absent. */
  include: { [K in keyof TIncluded & string]: ViewIncludeSpec<TRow, TIncluded[K]> };
  /** Build one view item from a source row, resolved includes, and its source index. With `renderKeys`, identity is gated by those keys on this selected output. */
  select?: (row: TRow, included: TIncluded, ctx: { index: number }) => TItem;
  /** Preserve an item reference while all listed keys of the selected output, or the whole row when `select` is absent, are unchanged. */
  renderKeys?: readonly (keyof TItem & string)[];
};

export type ViewHandle<TItem, TScope> = {
  /** Reactively read every projected item; `keepPrevious` is opt-in for unresolved key handoffs. */
  use(scopeValue: TScope | null | undefined, opts?: KeepPreviousOption): TItem[];
  /** Reactively read a local window over the projected source scope. */
  useWindow(scopeValue: TScope | null | undefined, opts?: { pageSize?: number } & KeepPreviousOption): ViewWindowResult<TItem>;
};

export type ViewWindowResult<TItem> = {
  /** Current-key items, or retained previous-key items while `isPreviousData` is true. */
  rows: TItem[];
  /** Total count for the snapshot represented by `rows`. */
  totalCount: number;
  /** Whether more locally-synced items exist beyond the current window. */
  hasMore: boolean;
  /** Grow the local view window by one page without fetching from the network. */
  fetchNextPage: () => void;
  /** True only while rows belong to the previous scope key and the current key is unresolved. */
  isPreviousData: boolean;
};
