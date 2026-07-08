import { getDbLogger } from './logger';
import type { CollectionModel, StoredWriteInput } from '../types';

type RowId = { id: string; updatedAt?: string | null };
type RowCollection = {
  readonly id: string;
  subscribeChanges(
    callback: (changes: Array<{ type: string; key?: unknown; value?: unknown }>) => void,
    options: { includeInitialState: false }
  ): RowSubscription;
};
type RowSubscription = { unsubscribe(): void };

export type RowPatch<TStored extends RowId> =
  | Partial<StoredWriteInput<TStored>>
  | ((row: TStored) => Partial<StoredWriteInput<TStored>>);

export type PatchWhenPresentOptions = {
  /** Maximum time to keep a deferred patch before dropping it. */
  ttlMs: number;
};

export type WaitForRowOptions = {
  /** Maximum time to wait before resolving with `undefined`. */
  timeoutMs: number;
  /** Optional abort signal that resolves the waiter with `undefined` and cleans up immediately. */
  signal?: AbortSignal;
};

type PatchQueueState<TStored extends RowId> = {
  id: string;
  model: CollectionModel<unknown, TStored>;
  patches: Array<RowPatch<TStored>>;
  timer: ReturnType<typeof setTimeout>;
  subscription: RowSubscription;
};

type WaiterState<TStored extends RowId> = {
  id: string;
  done: boolean;
  model: CollectionModel<unknown, TStored>;
  resolve: (row: TStored | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  subscription: RowSubscription;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type CollectionState = {
  patchQueues: Map<string, PatchQueueState<any>>;
  waiters: Set<WaiterState<any>>;
};

const states = new WeakMap<RowCollection, CollectionState>();

const stateFor = (collection: RowCollection): CollectionState => {
  const existing = states.get(collection);
  if (existing) return existing;

  const state: CollectionState = { patchQueues: new Map(), waiters: new Set() };
  states.set(collection, state);
  return state;
};

const changeMatchesRow = (change: { key?: unknown; value?: unknown }, id: string): boolean => {
  if (String(change.key) === id) return true;
  const value = change.value;
  return typeof value === 'object' && value !== null && (value as { id?: unknown }).id === id;
};

const subscribeForRow = <TStored extends RowId>(
  model: CollectionModel<unknown, TStored>,
  id: string,
  onPresent: () => void
): RowSubscription =>
  model.collection.subscribeChanges(
    changes => {
      if (changes.some(change => change.type !== 'delete' && changeMatchesRow(change, id))) {
        onPresent();
      }
    },
    { includeInitialState: false }
  );

const applyPatch = <TStored extends RowId>(model: CollectionModel<unknown, TStored>, id: string, patch: RowPatch<TStored>): void => {
  const row = model.get(id);
  if (!row) return;

  const updates = typeof patch === 'function' ? patch(row) : patch;
  model.patch(id, updates);
};

const finishPatchQueue = <TStored extends RowId>(state: CollectionState, queue: PatchQueueState<TStored>): PatchQueueState<TStored> | null => {
  const current = state.patchQueues.get(queue.id);
  if (current !== queue) return null;

  clearTimeout(queue.timer);
  queue.subscription.unsubscribe();
  state.patchQueues.delete(queue.id);
  return queue;
};

const applyPatchQueue = <TStored extends RowId>(state: CollectionState, queue: PatchQueueState<TStored>): void => {
  const current = finishPatchQueue(state, queue);
  if (!current) return;
  for (const patch of current.patches) {
    applyPatch(current.model, current.id, patch);
  }
};

const expirePatchQueue = <TStored extends RowId>(state: CollectionState, queue: PatchQueueState<TStored>): void => {
  const current = finishPatchQueue(state, queue);
  if (!current) return;
  getDbLogger().debug('db', 'row patch queue expired', {
    collectionId: current.model.collection.id,
    id: current.id,
    count: current.patches.length
  });
};

/**
 * Apply a patch immediately when the row exists, or defer it until the row appears.
 *
 * Deferred patches are ordered per row id, expire after `ttlMs`, and are cleared on model runtime reset.
 *
 * @param model Model that owns the row and exposes its TanStack DB collection.
 * @param id Row id to patch.
 * @param patch Partial update or updater derived from the current row at application time.
 * @param options Deferred patch TTL.
 */
export const patchWhenPresent = <TStored extends RowId>(
  model: CollectionModel<unknown, TStored>,
  id: string,
  patch: RowPatch<TStored>,
  options: PatchWhenPresentOptions
): void => {
  if (model.get(id)) {
    applyPatch(model, id, patch);
    return;
  }

  const state = stateFor(model.collection);
  const existing = state.patchQueues.get(id) as PatchQueueState<TStored> | undefined;
  if (existing) {
    existing.patches.push(patch);
    return;
  }

  const queue = {} as PatchQueueState<TStored>;
  queue.id = id;
  queue.model = model;
  queue.patches = [patch];
  queue.subscription = subscribeForRow(model, id, () => applyPatchQueue(state, queue));
  queue.timer = setTimeout(() => expirePatchQueue(state, queue), options.ttlMs);
  state.patchQueues.set(id, queue);
};

const finishWaiter = <TStored extends RowId>(state: CollectionState, waiter: WaiterState<TStored>, row: TStored | undefined): void => {
  if (waiter.done) return;
  waiter.done = true;
  clearTimeout(waiter.timer);
  waiter.subscription.unsubscribe();
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener('abort', waiter.abortHandler);
  }
  state.waiters.delete(waiter);
  waiter.resolve(row);
};

/**
 * Resolve with a row once it exists, without polling.
 *
 * The waiter uses the model's TanStack DB `subscribeChanges` channel, resolves `undefined` on timeout
 * or abort, and removes timers/subscriptions on every exit path.
 *
 * @param model Model that owns the row and exposes its TanStack DB collection.
 * @param id Row id to wait for.
 * @param options Timeout and optional abort signal.
 * @returns Promise resolving to the row or `undefined`.
 */
export const waitForRow = <TStored extends RowId>(
  model: CollectionModel<unknown, TStored>,
  id: string,
  options: WaitForRowOptions
): Promise<TStored | undefined> => {
  const existing = model.get(id);
  if (existing) return Promise.resolve(existing);
  if (options.signal?.aborted) return Promise.resolve(undefined);

  const state = stateFor(model.collection);
  return new Promise(resolve => {
    const waiter = {} as WaiterState<TStored>;
    waiter.id = id;
    waiter.done = false;
    waiter.model = model;
    waiter.resolve = resolve;
    waiter.subscription = subscribeForRow(model, id, () => {
      finishWaiter(state, waiter, model.get(id));
    });
    waiter.timer = setTimeout(() => finishWaiter(state, waiter, undefined), options.timeoutMs);
    if (options.signal) {
      waiter.signal = options.signal;
      waiter.abortHandler = () => finishWaiter(state, waiter, undefined);
      options.signal.addEventListener('abort', waiter.abortHandler, { once: true });
    }
    state.waiters.add(waiter);
  });
};

/** Clear deferred row patches and waiters for a collection during model runtime reset. */
export const clearRowWaitersForCollection = (collection: RowCollection): void => {
  const state = states.get(collection);
  if (!state) return;

  for (const queue of [...state.patchQueues.values()]) {
    finishPatchQueue(state, queue);
  }
  for (const waiter of [...state.waiters]) {
    finishWaiter(state, waiter, undefined);
  }
  states.delete(collection);
};

/** Return internal waiter counts for leak-focused tests. */
export const getRowWaiterDebugInfo = (collection: RowCollection): { patchQueues: number; waiters: number } => {
  const state = states.get(collection);
  return {
    patchQueues: state?.patchQueues.size ?? 0,
    waiters: state?.waiters.size ?? 0
  };
};
