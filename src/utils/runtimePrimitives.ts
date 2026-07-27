import { isTempId } from './generateTempId';
import { getRuntimeGeneration } from '../dsl/configure';
import { isRecord } from './normalizeHelpers';
import { registerReset } from '../core/reset';

type RowId = { id: string };
type CreatedAtLike = string | number | Date | null | undefined;
type CreatedAtRow = RowId & { createdAt?: CreatedAtLike };

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export const createGenerationFence = (options?: { lazy?: boolean }): { isCurrent(): boolean; captureNow(): void } => {
  let generation: number | null = options?.lazy ? null : getRuntimeGeneration();
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => { generation = getRuntimeGeneration(); }
  };
};

type SnapshotModel<TStored extends RowId> = {
  find(id: string | undefined | null): TStored | undefined;
  all(): TStored[];
  where(filter: Partial<TStored>): TStored[];
};

type DestroyManyModel<TStored extends RowId> = {
  all(): TStored[];
  destroyMany(ids: string[]): void;
};

export type ReconcileScopeFields<TStored extends RowId, TNode extends RowId> =
  | { fields: ReadonlyArray<Extract<keyof TStored & keyof TNode, string>> }
  | { fieldMap: Partial<Record<Extract<keyof TStored, string>, Extract<keyof TNode, string>>> };

export type ReconcileOptimisticRowsOptions<TStored extends CreatedAtRow, TNode extends CreatedAtRow> = {
  /** Candidate resolver, or a scope-field shorthand backed by `model.where`. */
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
   *   `model.find(node.id)` themselves before calling this function.
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

/**
 * Absolute `createdAt` gap between a candidate and an incoming node, in milliseconds. Missing or
 * unparseable `createdAt` on either side makes `toTimestamp` return `NaN`, which propagates through
 * `Math.abs` to a `NaN` delta - the `!Number.isFinite(delta)` guard in `findBestOptimisticCandidate`
 * deliberately excludes a NaN delta from candidate ranking (never treated as a 0 or best match).
 */
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

  return model.where(filter);
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
    if (model.find(node.id)) {
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

const deleteManyForMaintenance = <TStored extends RowId>(model: DestroyManyModel<TStored>, ids: string[]): number => {
  if (ids.length === 0) return 0;
  model.destroyMany(ids);
  return ids.length;
};

type RowProtect<TStored extends RowId> = ((row: TStored) => boolean) | ReadonlySet<string> | readonly string[];

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

  for (const row of model.all()) {
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

type ResolveStaleTempRowsOptions<TStored extends CreatedAtRow> = {
  maxAgeMs: number;
  protectedIds?: ReadonlySet<string> | readonly string[];
  onStale: (row: TStored) => void;
};

/**
 * Run `onStale` for temp-id rows older than the age threshold and not protected. A row whose
 * `createdAt` cannot be parsed (missing, malformed, or otherwise NaN) is treated as maximally old and
 * resolved immediately - an unparseable timestamp must not grant a stale row indefinite protection
 * from cleanup.
 *
 * @param model Snapshot model used to scan temp rows.
 * @param options Age threshold, optional protected ids, and stale-row callback.
 * @returns Number of stale temp rows resolved.
 */
export const resolveStaleTempRows = <TStored extends CreatedAtRow>(
  model: Pick<DestroyManyModel<TStored>, 'all'>,
  options: ResolveStaleTempRowsOptions<TStored>
): number => {
  const protectedIds = options.protectedIds ? normalizeIdSet(options.protectedIds) : new Set<string>();
  const now = Date.now();
  let resolved = 0;

  for (const row of model.all()) {
    if (!isTempId(row.id) || protectedIds.has(row.id)) continue;
    const createdAt = toTimestamp(row.createdAt);
    const age = Number.isFinite(createdAt) ? now - createdAt : Number.POSITIVE_INFINITY;
    if (age <= options.maxAgeMs) continue;

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
  isRecord(arg) && arg.force === true;

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

type SingleFlightOptions = {
  /** Clear the shared in-flight promise on runtime reset so a stale fetch never satisfies post-reset callers. */
  resetOnRuntimeReset?: boolean;
};

/**
 * Wraps an async function so concurrent callers share one in-flight promise.
 * Unlike createThrottledSingleFlight this primitive has no throttle window and
 * PROPAGATES rejections to every caller sharing the flight - use it when the
 * caller must observe failures (bootstrap fetches, config loads).
 */
export const createSingleFlight = <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: SingleFlightOptions
): ((...args: TArgs) => Promise<TResult>) => {
  let inFlight: Promise<TResult> | null = null;
  if (options?.resetOnRuntimeReset) {
    registerReset(() => {
      inFlight = null;
    });
  }
  return (...args: TArgs): Promise<TResult> => {
    if (inFlight) return inFlight;
    const flight = fn(...args).finally(() => {
      if (inFlight === flight) inFlight = null;
    });
    inFlight = flight;
    return flight;
  };
};
