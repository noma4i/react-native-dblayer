import type { Dependency } from './apply/commitBus';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';

type WaiterModel<TStored extends { id: string }> = {
  modelId: string;
  get(id: string | null | undefined): TStored | undefined;
  patch(id: string, patch: Record<string, unknown>): void;
};

export type RowPatch<TStored> = Partial<TStored> | ((row: TStored) => Partial<TStored>);

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

const rowDepOf = <TStored extends { id: string }>(model: WaiterModel<TStored>, id: string): Dependency => ({ kind: 'row', model: model.modelId, id });

const resolvePatch = <TStored extends { id: string }>(row: TStored, patch: RowPatch<TStored>): Record<string, unknown> =>
  (typeof patch === 'function' ? (patch as (row: TStored) => Partial<TStored>)(row) : patch) as Record<string, unknown>;

/**
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 */
export const patchWhenPresent = <TStored extends { id: string }>(
  model: WaiterModel<TStored>,
  id: string,
  patch: RowPatch<TStored>,
  options: PatchWhenPresentOptions
): void => {
  const generation = getRuntimeGeneration();
  const existing = model.get(id);
  if (existing) {
    model.patch(id, resolvePatch(existing, patch));
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  const subscription = getCommitBus().subscribe(() => {
    if (!active) return;
    if (generation !== getRuntimeGeneration()) return;
    const row = model.get(id);
    if (!row) return;
    active = false;
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
    model.patch(id, resolvePatch(row, patch));
  }, [rowDepOf(model, id)]);
  timer = setTimeout(() => {
    active = false;
    subscription.unsubscribe();
  }, options.ttlMs);
};

/** Resolve with the row once it exists, or with `undefined` on timeout/abort. */
export const waitForRow = <TStored extends { id: string }>(
  model: WaiterModel<TStored>,
  id: string,
  options: WaitForRowOptions
): Promise<TStored | undefined> => {
  const generation = getRuntimeGeneration();
  const existing = model.get(id);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: TStored | undefined): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      subscription.unsubscribe();
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    const subscription = getCommitBus().subscribe(() => {
      if (generation !== getRuntimeGeneration()) {
        finish(undefined);
        return;
      }
      const row = model.get(id);
      if (row) finish(row);
    }, [rowDepOf(model, id)]);
    timer = setTimeout(() => finish(undefined), options.timeoutMs);
    if (options.signal?.aborted) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', onAbort);
  });
};
