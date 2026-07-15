import { isTempId } from './generateTempId';
import { getDbLogger } from '../core/logger';
import { getRuntimeGeneration } from '../dsl/configure';
import type { AnyDbShape, InferShapeStored } from '../schema/infer';
import { readShapeOrThrow } from '../schema/shape';

type RowId = { id: string };
type CreatedAtLike = string | number | Date | null | undefined;
type CreatedAtRow = RowId & { createdAt?: CreatedAtLike };

type SnapshotModel<TStored extends RowId> = {
  get(id: string | undefined | null): TStored | undefined;
  getAll(): TStored[];
  getWhere(filter: Partial<TStored>): TStored[];
};

type DestroyManyModel<TStored extends RowId> = {
  getAll(): TStored[];
  destroyMany(ids: string[]): void;
};

type PatchModel<TStored extends RowId> = {
  get(id: string): TStored | undefined;
  patch(id: string, updates: Partial<TStored>): boolean | void;
};

type SingletonModel<TStored extends RowId> = PatchModel<TStored> & {
  insertStored(item: TStored): void;
  use: { row(id: string | null | undefined): TStored | undefined };
};

export type ReconcileScopeFields<TStored extends RowId, TNode extends RowId> =
  | { fields: ReadonlyArray<Extract<keyof TStored & keyof TNode, string>> }
  | { fieldMap: Partial<Record<Extract<keyof TStored, string>, Extract<keyof TNode, string>>> };

export type ReconcileOptimisticRowsOptions<TStored extends CreatedAtRow, TNode extends CreatedAtRow> = {
  /** Candidate resolver, or a scope-field shorthand backed by `model.getWhere`. */
  resolveCandidates: ((node: TNode) => TStored[]) | ReconcileScopeFields<TStored, TNode>;
  /** Extra candidate predicate. Temp ids are always considered candidates. */
  isCandidate?: (candidate: TStored, node: TNode) => boolean;
  /** Domain equality check between an optimistic row and a server node. */
  match: (candidate: TStored, node: TNode) => boolean;
  /** Drop matches whose created-at timestamps are farther apart than this window. */
  createdAtWindowMs?: number;
  /** Commit a matched optimistic row to the server node. */
  commit: (tempId: string, node: TNode) => void;
  /**
   * How to handle an incoming node whose id already exists in the model.
   *
   * - `'drop'` (default): the node is silently skipped - neither returned nor committed. This is the
   *   original behavior; callers that need to apply an existing-id node as an update have to pre-check
   *   `model.get(node.id)` themselves before calling this function.
   * - `'return'`: the node is pushed into the returned array as-is, with no candidate matching attempted
   *   and no `commit` call - e.g. a subscription echo of a row already applied by its own mutation
   *   response. The caller decides how to apply it (patch, replace, or ignore).
   *
   * @default 'drop'
   */
  onExisting?: 'drop' | 'return';
};

const toTimestamp = (value: CreatedAtLike): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};

const createdAtDelta = (candidate: CreatedAtRow, node: CreatedAtRow): number => Math.abs(toTimestamp(candidate.createdAt) - toTimestamp(node.createdAt));

const resolveScopedCandidates = <TStored extends RowId, TNode extends RowId>(
  model: SnapshotModel<TStored>,
  scope: ReconcileScopeFields<TStored, TNode>,
  node: TNode
): TStored[] => {
  const filter: Partial<TStored> = {};

  if ('fields' in scope) {
    for (const field of scope.fields) {
      (filter as Record<string, unknown>)[field] = (node as Record<string, unknown>)[field];
    }
  } else {
    for (const [storedField, nodeField] of Object.entries(scope.fieldMap)) {
      if (!nodeField) continue;
      (filter as Record<string, unknown>)[storedField] = (node as Record<string, unknown>)[nodeField];
    }
  }

  return model.getWhere(filter);
};

const candidateAllowed = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  candidate: TStored,
  node: TNode,
  isCandidate?: (candidate: TStored, node: TNode) => boolean
): boolean => isTempId(candidate.id) || Boolean(isCandidate?.(candidate, node));

const findBestOptimisticCandidate = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  candidates: TStored[],
  node: TNode,
  options: ReconcileOptimisticRowsOptions<TStored, TNode>
): TStored | null => {
  let bestCandidate: TStored | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidateAllowed(candidate, node, options.isCandidate)) continue;
    if (!options.match(candidate, node)) continue;

    const delta = createdAtDelta(candidate, node);
    if (!Number.isFinite(delta)) continue;
    if (options.createdAtWindowMs !== undefined && delta > options.createdAtWindowMs) continue;

    if (delta < bestDelta) {
      bestDelta = delta;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
};

/**
 * Reconcile incoming server nodes with matching optimistic rows.
 *
 * @param model Snapshot model used to check existing rows and scoped optimistic candidates.
 * @param nodes Incoming server nodes.
 * @param options Candidate resolution, matching, timestamp window, commit callback, and `onExisting`
 * policy for nodes whose id already exists in the model.
 * @returns Server nodes that were not matched, plus (with `onExisting: 'return'`) nodes whose id already
 * existed in the model.
 */
export const reconcileOptimisticRows = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  model: SnapshotModel<TStored>,
  nodes: TNode[],
  options: ReconcileOptimisticRowsOptions<TStored, TNode>
): TNode[] => {
  const unmatched: TNode[] = [];

  for (const node of nodes) {
    if (model.get(node.id)) {
      if (options.onExisting === 'return') {
        unmatched.push(node);
      }
      continue;
    }

    const candidates =
      typeof options.resolveCandidates === 'function'
        ? options.resolveCandidates(node)
        : resolveScopedCandidates(model, options.resolveCandidates, node);
    const bestCandidate = findBestOptimisticCandidate(candidates, node, options);

    if (!bestCandidate) {
      unmatched.push(node);
      continue;
    }

    options.commit(bestCandidate.id, node);
  }

  return unmatched;
};

const normalizeIdSet = (ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> => (ids instanceof Set ? ids : new Set(ids));

const destroyManyIfNeeded = <TStored extends RowId>(model: DestroyManyModel<TStored>, ids: string[]): number => {
  if (ids.length === 0) return 0;
  model.destroyMany(ids);
  return ids.length;
};

const deleteManyForMaintenance = <TStored extends RowId>(model: DestroyManyModel<TStored>, ids: string[]): number => {
  if (ids.length === 0) return 0;
  model.destroyMany(ids);
  return ids.length;
};

const toExpiryTimestamp = (value: CreatedAtLike): number => toTimestamp(value);

/**
 * Delete rows whose foreign key no longer points at a live parent id.
 *
 * @param model Model that can snapshot rows and destroy by id.
 * @param foreignKeyField Row field that stores the parent id.
 * @param liveParentIds Live parent ids accepted by the cleanup pass.
 * @returns Number of rows deleted through `destroyMany`.
 */
export const pruneOrphanedRows = <TStored extends RowId, TForeignKey extends Extract<keyof TStored, string>>(
  model: DestroyManyModel<TStored>,
  foreignKeyField: TForeignKey,
  liveParentIds: ReadonlySet<string> | readonly string[]
): number => {
  const liveIds = normalizeIdSet(liveParentIds);
  const idsToDestroy = model
    .getAll()
    .filter(row => {
      const foreignId = row[foreignKeyField];
      return (typeof foreignId !== 'string' && typeof foreignId !== 'number') || !liveIds.has(String(foreignId));
    })
    .map(row => row.id);

  return destroyManyIfNeeded(model, idsToDestroy);
};

/**
 * Delete rows whose timestamp field is older than the supplied TTL.
 *
 * Invalid timestamps are kept.
 *
 * @param model Model that can snapshot rows and destroy by id.
 * @param field Row field containing a string, number, or Date timestamp.
 * @param ttlMs Maximum allowed age in milliseconds.
 * @param now Reference time; defaults to `Date.now()`.
 * @returns Number of rows deleted through `destroyMany`.
 */
export const pruneExpiredRows = <TStored extends RowId, TField extends Extract<keyof TStored, string>>(
  model: DestroyManyModel<TStored>,
  field: TField,
  ttlMs: number,
  now: CreatedAtLike = Date.now()
): number => {
  const nowMs = toExpiryTimestamp(now);
  if (!Number.isFinite(nowMs)) return 0;

  const idsToDestroy = model
    .getAll()
    .filter(row => {
      const timestamp = toExpiryTimestamp(row[field] as CreatedAtLike);
      return Number.isFinite(timestamp) && nowMs - timestamp > ttlMs;
    })
    .map(row => row.id);

  return destroyManyIfNeeded(model, idsToDestroy);
};

export type RowProtect<TStored extends RowId> = ((row: TStored) => boolean) | ReadonlySet<string> | readonly string[];

const toProtectPredicate = <TStored extends RowId>(protect?: RowProtect<TStored>): ((row: TStored) => boolean) => {
  if (!protect) return () => false;
  if (typeof protect === 'function') return protect;

  const ids = normalizeIdSet(protect);
  return row => ids.has(row.id);
};

/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 *
 * The supplied comparator must order rows from newest/most important to oldest.
 *
 * @param model Model that can snapshot rows and delete rows for maintenance.
 * @param scopeField Row field used to group rows.
 * @param maxPerScope Maximum unprotected rows kept per scope.
 * @param compare Comparator applied inside each scope before trimming.
 * @param protect Optional protected row predicate or id list.
 * @returns Number of rows deleted.
 */
export const trimRowsPerScope = <TStored extends RowId, TScopeField extends Extract<keyof TStored, string>>(
  model: DestroyManyModel<TStored>,
  scopeField: TScopeField,
  maxPerScope: number,
  compare: (left: TStored, right: TStored) => number,
  protect?: RowProtect<TStored>
): number => {
  const shouldProtect = toProtectPredicate(protect);
  const groups = new Map<string, TStored[]>();

  for (const row of model.getAll()) {
    if (shouldProtect(row)) continue;
    const scopeValue = row[scopeField];
    if (scopeValue == null) continue;

    const scopeKey = String(scopeValue);
    const group = groups.get(scopeKey);
    if (group) {
      group.push(row);
    } else {
      groups.set(scopeKey, [row]);
    }
  }

  const limit = Math.max(0, maxPerScope);
  const idsToDestroy: string[] = [];
  for (const rows of groups.values()) {
    if (rows.length <= limit) continue;
    rows.sort(compare);
    idsToDestroy.push(...rows.slice(limit).map(row => row.id));
  }

  return deleteManyForMaintenance(model, idsToDestroy);
};

export type ResolveStaleTempRowsOptions<TStored extends CreatedAtRow> = {
  maxAgeMs: number;
  protectedIds?: ReadonlySet<string> | readonly string[];
  onStale: (row: TStored) => void;
};

/**
 * Run `onStale` for temp-id rows older than the age threshold and not protected.
 *
 * @param model Snapshot model used to scan temp rows.
 * @param options Age threshold, optional protected ids, and stale-row callback.
 * @returns Number of stale temp rows resolved.
 */
export const resolveStaleTempRows = <TStored extends CreatedAtRow>(
  model: Pick<DestroyManyModel<TStored>, 'getAll'>,
  options: ResolveStaleTempRowsOptions<TStored>
): number => {
  const protectedIds = options.protectedIds ? normalizeIdSet(options.protectedIds) : new Set<string>();
  const now = Date.now();
  let resolved = 0;

  for (const row of model.getAll()) {
    if (!isTempId(row.id) || protectedIds.has(row.id)) continue;
    const createdAt = toTimestamp(row.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt <= options.maxAgeMs) continue;

    options.onStale(row);
    resolved += 1;
  }

  return resolved;
};

export type ThrottledSingleFlightOptions<TArgs extends unknown[]> = {
  minIntervalMs: number;
  /** Override throttle suppression; defaults to reading `args[0].force === true`. */
  isForced?: (...args: TArgs) => boolean;
};

const defaultIsForced = (arg: unknown): boolean =>
  typeof arg === 'object' && arg !== null && (arg as { force?: unknown }).force === true;

/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 *
 * Suppressed calls and failed executions resolve to `undefined`.
 *
 * @param fn Async task to run at most once concurrently.
 * @param options Minimum post-success interval and optional force predicate.
 * @returns A wrapped function that shares in-flight work and resolves `undefined` for suppressed or failed calls.
 */
export const createThrottledSingleFlight = <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: ThrottledSingleFlightOptions<TArgs>
): ((...args: TArgs) => Promise<TResult | undefined>) => {
  let inFlight: Promise<TResult | undefined> | null = null;
  let lastSuccessAt = 0;

  return (...args: TArgs): Promise<TResult | undefined> => {
    if (inFlight) return inFlight;

    const force = options.isForced ? options.isForced(...args) : defaultIsForced(args[0]);
    if (!force && Date.now() - lastSuccessAt < options.minIntervalMs) {
      return Promise.resolve(undefined);
    }

    try {
      inFlight = fn(...args)
        .then(result => {
          lastSuccessAt = Date.now();
          return result;
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
    } catch {
      inFlight = Promise.resolve(undefined).finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  };
};

export type KeyedBatchBufferDedupe<TItem> = {
  /** Stable dedupe id for an item inside a keyed bucket. */
  idOf: (item: TItem) => string;
  /** Return true when the candidate should replace the existing item with the same dedupe id. */
  isNewer: (candidate: TItem, existing: TItem) => boolean;
};

export type KeyedBatchBufferConfig<TItem> = {
  /** Bucket key for an incoming item. */
  keyOf: (item: TItem) => string;
  /** Trailing flush delay for each independent bucket. */
  flushMs: number;
  /** Flush a bucket synchronously when its buffered item count reaches this size. */
  maxSize?: number;
  /** Optional newest-wins dedupe policy inside each bucket. */
  dedupe?: KeyedBatchBufferDedupe<TItem>;
  /** Flush callback. Errors are contained and logged. */
  onFlush: (key: string, items: TItem[]) => void;
};

export type KeyedBatchBuffer<TItem> = {
  /** Push an item into its keyed bucket and start or refresh that bucket's trailing timer. */
  push(item: TItem): void;
  /** Flush every non-empty bucket immediately. */
  flushAll(): void;
  /** Drop every bucket without firing `onFlush`. */
  clear(): void;
};

type KeyedBatchBucket<TItem> = {
  items: TItem[];
  itemIndexes: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
};

const clearBucketTimer = <TItem>(bucket: KeyedBatchBucket<TItem>): void => {
  if (!bucket.timer) return;
  clearTimeout(bucket.timer);
  bucket.timer = null;
};

/**
 * Create a keyed trailing batch buffer with independent bucket timers.
 *
 * @param config Keying, timing, optional cap/dedupe policy, and flush callback.
 * @returns Runtime buffer controls for pushing, flushing, and clearing pending items.
 */
export const createKeyedBatchBuffer = <TItem>(config: KeyedBatchBufferConfig<TItem>): KeyedBatchBuffer<TItem> => {
  const buckets = new Map<string, KeyedBatchBucket<TItem>>();
  let generation: number | null = null;

  const isCurrentGeneration = (): boolean => generation == null || generation === getRuntimeGeneration();
  const beginGeneration = (): boolean => {
    if (!isCurrentGeneration()) return false;
    generation ??= getRuntimeGeneration();
    return true;
  };

  const getBucket = (key: string): KeyedBatchBucket<TItem> => {
    const existing = buckets.get(key);
    if (existing) return existing;

    const bucket: KeyedBatchBucket<TItem> = { items: [], itemIndexes: new Map(), timer: null };
    buckets.set(key, bucket);
    return bucket;
  };

  const flushBucket = (key: string, bucket: KeyedBatchBucket<TItem>): void => {
    clearBucketTimer(bucket);
    buckets.delete(key);
    if (bucket.items.length === 0 || !isCurrentGeneration()) return;

    try {
      config.onFlush(key, [...bucket.items]);
    } catch (error) {
      getDbLogger().error('db', 'keyed batch buffer flush failed', { key, error });
    }
  };

  const scheduleBucket = (key: string, bucket: KeyedBatchBucket<TItem>): void => {
    clearBucketTimer(bucket);
    bucket.timer = setTimeout(() => {
      flushBucket(key, bucket);
    }, config.flushMs);
  };

  const pushDistinct = (bucket: KeyedBatchBucket<TItem>, item: TItem): void => {
    if (!config.dedupe) {
      bucket.items.push(item);
      return;
    }

    const dedupeId = config.dedupe.idOf(item);
    const existingIndex = bucket.itemIndexes.get(dedupeId);
    if (existingIndex === undefined) {
      bucket.itemIndexes.set(dedupeId, bucket.items.length);
      bucket.items.push(item);
      return;
    }

    const existing = bucket.items[existingIndex];
    if (existing !== undefined && config.dedupe.isNewer(item, existing)) {
      bucket.items[existingIndex] = item;
    }
  };

  return {
    push(item) {
      if (!beginGeneration()) return;
      const key = config.keyOf(item);
      const bucket = getBucket(key);
      pushDistinct(bucket, item);

      if (config.maxSize !== undefined && config.maxSize > 0 && bucket.items.length >= config.maxSize) {
        flushBucket(key, bucket);
        return;
      }

      scheduleBucket(key, bucket);
    },
    flushAll() {
      if (!isCurrentGeneration()) {
        for (const bucket of buckets.values()) clearBucketTimer(bucket);
        buckets.clear();
        return;
      }
      for (const [key, bucket] of [...buckets.entries()]) {
        flushBucket(key, bucket);
      }
    },
    clear() {
      for (const bucket of buckets.values()) {
        clearBucketTimer(bucket);
      }
      buckets.clear();
    }
  };
};

export type NestedObjectPatcher<TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[]> = (
  id: string,
  ...args: TArgs
) => boolean;

export type KeyedArrayPatcher<TSub extends object, TKey extends Extract<keyof TSub, string>> = {
  /** Replace an existing sub-row with the same key, then append the normalized sub-row. */
  upsert(rows: TSub[] | null | undefined, input: unknown): TSub[];
  /** Remove sub-rows whose key equals the supplied value. */
  remove(rows: TSub[] | null | undefined, keyValue: string): TSub[];
};

export type IdArrayPatcher = {
  /** Replace an existing id, then insert it at the requested edge. */
  upsert(ids: string[] | null | undefined, id: string, position: 'prepend' | 'append'): string[];
  /** Remove an id. */
  remove(ids: string[] | null | undefined, id: string): string[];
};

/**
 * Create immutable patch helpers for an array of keyed shape sub-rows.
 *
 * @param shape Shape used to normalize incoming sub-rows.
 * @param options Key field used for replacement/removal.
 * @returns Immutable `upsert` and `remove` helpers for nullable arrays.
 */
export const createKeyedArrayPatcher = <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(
  shape: TShape,
  options: { key: TKey }
): KeyedArrayPatcher<TSub, TKey> => ({
  upsert(rows, input) {
    const next = readShapeOrThrow(shape, input, 'Keyed array patch item') as TSub;
    const keyValue = next[options.key];
    return [...(rows ?? []).filter(entry => entry[options.key] !== keyValue), next];
  },
  remove(rows, keyValue) {
    return (rows ?? []).filter(entry => entry[options.key] !== keyValue);
  }
});

/**
 * Create immutable patch helpers for id arrays.
 *
 * @returns Immutable `upsert` and `remove` helpers that tolerate nullish arrays.
 */
export const createIdArrayPatcher = (): IdArrayPatcher => ({
  upsert(ids, id, position) {
    const next = (ids ?? []).filter(existingId => existingId !== id);
    return position === 'prepend' ? [id, ...next] : [...next, id];
  },
  remove(ids, id) {
    return (ids ?? []).filter(existingId => existingId !== id);
  }
});

/**
 * Create a shallow patcher for a nullable nested object field.
 *
 * @param model Model used to read and patch the containing row.
 * @param field Nested object field to patch.
 * @param transform Function that derives a partial nested update from the current nested value and caller args.
 * @returns A patcher that returns `false` when the row or nested object is missing.
 */
export const createNestedObjectPatcher = <
  TRow extends RowId,
  TField extends Extract<keyof TRow, string>,
  TArgs extends unknown[],
  TNested extends object = NonNullable<TRow[TField]> & object
>(
  model: PatchModel<TRow>,
  field: TField,
  transform: (current: TNested, ...args: TArgs) => Partial<TNested>
): NestedObjectPatcher<TRow, TField, TArgs> => {
  return (id, ...args) => {
    const row = model.get(id);
    const current = row?.[field];
    if (typeof current !== 'object' || current === null) return false;

    model.patch(id, {
      [field]: {
        ...(current as TNested),
        ...transform(current as TNested, ...args)
      }
    } as Partial<TRow>);
    return true;
  };
};

type NumericField<TStored> = {
  [K in keyof TStored]: TStored[K] extends number ? K : never;
}[keyof TStored];

const removeSingletonId = <TStored extends RowId>(input: Partial<TStored>): Omit<Partial<TStored>, 'id'> => {
  const { id: _ignoredId, ...updates } = input;
  return updates;
};

/**
 * Build statics for a single-row model with defaults and clamped numeric updates.
 *
 * @param model Model that owns the singleton row.
 * @param recordId Stable singleton row id.
 * @param defaults Default row returned before insertion and used for first upsert.
 * @returns Singleton statics for reading, upserting, and clamped numeric patches.
 */
export const singletonStatics = <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => {
  const upsert = (input: Partial<TStored>): void => {
    const updates = removeSingletonId(input);
    const existing = model.get(recordId);
    if (existing) {
      model.patch(recordId, updates as Partial<TStored>);
      return;
    }

    model.insertStored({ ...defaults, ...updates, id: recordId } as TStored);
  };

  return {
    recordId,
    defaults,
    current: (): TStored | undefined => model.get(recordId),
    useCurrent: (): TStored => model.use.row(recordId) ?? defaults,
    upsertCurrent: upsert,
    patchClamped: <TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min = 0): boolean => {
      if (delta === 0) return false;
      const current = model.get(recordId);
      if (!current) return false;

      const value = current[field];
      const currentValue = typeof value === 'number' ? value : 0;
      model.patch(recordId, { [field]: Math.max(min, currentValue + delta) } as Partial<TStored>);
      return true;
    }
  };
};
