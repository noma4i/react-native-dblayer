import type { Dependency } from './core.apply.commitBus.types';
import type { RowRecord } from './db.types';
import type { ScopeHandle } from './dsl.model.types';
import type { KeepPreviousOption } from './read.scopeRetention.types';
import type { ClientSort } from './dsl.ordering.types';

/** Resolved include values keyed by include name, as passed to a view `select`. */
export type ViewIncluded = Record<string, unknown>;
/** Computed include: a target model plus an id resolver over the source row. */
export type InternalComputedInclude = [ViewIncludeModel, (row: RowRecord) => string | string[] | null];
/** Relation-backed include with optional require/renderKeys projection hints. */
export type InternalRelationInclude = { require?: readonly string[]; renderKeys?: readonly string[] };
/** Id-resolver include with an explicit target model and projection hints. */
export type InternalIdInclude = { model: ViewIncludeModel; ids: (row: RowRecord) => string | string[] | null; require?: readonly string[]; renderKeys?: readonly string[] };
/** One normalized include declaration in any of its accepted authoring forms. */
export type InternalIncludeConfig = string | InternalComputedInclude | InternalRelationInclude | InternalIdInclude;
/** The untyped view config `defineView` works with after authoring-time generics are erased. */
export type InternalViewConfig<TItem> = {
  source: string | ScopeHandle<RowRecord, Record<string, unknown>>;
  include: Record<string, InternalIncludeConfig>;
  select?: (row: RowRecord, included: ViewIncluded, ctx: { index: number }) => TItem;
  renderKeys?: readonly string[];
  filter?: (row: RowRecord, included: ViewIncluded) => boolean;
  sort?: ClientSort<RowRecord>;
};
/** Per-row item cache entry: inputs (row + includes) and the projected item they produced. */
export type ViewCacheEntry<TItem> = { row: RowRecord; included: ViewIncluded; item: TItem };
/** Window-local cache of projected items for `useWindow` slices. */
export type ViewWindowCache<TItem> = { items: TItem[]; size: number; rows: TItem[] };
/** One evaluated snapshot of view items with its resolution flag. */
export type ViewItemSnapshot<TItem> = { items: TItem[]; totalCount: number; resolved: boolean };
/** A fully evaluated view: snapshot plus the commit-bus dependencies that invalidate it. */
export type EvaluatedView<TItem> = { scopeKey: string | null; limit: number | null; snapshot: ViewItemSnapshot<TItem>; deps: Dependency[] };
/** Incremental FK index for relation includes: rows grouped by foreign key with reverse lookup. */
export type ViewForeignKeyIndex = { rowsByForeignKey: Map<string, RowRecord[]>; fkById: Map<string, string>; unsubscribe: () => void };

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
  /** Keep only the rows this predicate accepts - it sees the source row AND its resolved includes, so a view can filter by joined data a scope `member` predicate cannot reach. Applied before `sort`/window; `totalCount` reflects the filtered set. */
  filter?: (row: TRow, included: TIncluded) => boolean;
  /** Declared order of the projected ITEMS: one field, a key list, or a comparator (same vocabulary as scope `sort`; id tie-break from the source row). Overrides the source scope order for this view's reads. */
  sort?: ClientSort<TItem & { id: string }>;
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
  /** True once the view's SOURCE scope has been reconciled at least once. Mirrors `ScopeWindowResult.resolved`, so a view window bridges into `bridgeWindowPagination` unchanged. */
  resolved: boolean;
};
