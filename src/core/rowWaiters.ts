import type { Dependency, RowPatch, UpdateWhenRowExistsOptions, WaitForRowOptions, WaiterModel } from '../types';
import { getCommitBus } from '../dsl/configure';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { noteDataLoss } from './diagnostics';

const modelKeyOf = <TStored extends { id: string }>(model: WaiterModel<TStored>): string => ('modelId' in model ? model.modelId : model.key);
const rowDepOf = <TStored extends { id: string }>(model: WaiterModel<TStored>, id: string): Dependency => ({ kind: 'row', model: modelKeyOf(model), id });

const resolvePatch = <TStored extends { id: string }>(row: TStored, patch: RowPatch<TStored>): Record<string, unknown> =>
  (typeof patch === 'function' ? (patch as (row: TStored) => Partial<TStored>)(row) : patch) as Record<string, unknown>;

/**
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 *
 * @param model Model to read and patch.
 * @param id Row id to patch now or wait for.
 * @param patch A partial update, or a function deriving one from the row once it is known.
 * @param options.ttlMs Maximum time to keep a deferred patch queued before dropping it.
 */
export const updateWhenRowExists = <TStored extends { id: string }>(
  model: WaiterModel<TStored>,
  id: string,
  patch: RowPatch<TStored>,
  options: UpdateWhenRowExistsOptions
): void => {
  const generationFence = createGenerationFence();
  const existing = model.find(id);
  if (existing) {
    model.update(id, resolvePatch(existing, patch));
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Shared teardown for the terminal cases (applied, stale generation, TTL) - unsubscribes immediately instead of leaving a dead subscriber on the commit bus until the TTL timer sweeps it. */
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
  };
  const subscription = getCommitBus().subscribe(() => {
    if (!generationFence.isCurrent()) {
      stop();
      return;
    }
    const row = model.find(id);
    if (!row) return;
    stop();
    model.update(id, resolvePatch(row, patch));
  }, [rowDepOf(model, id)]);
  timer = setTimeout(() => {
    noteDataLoss('deferred-patch-timeout', modelKeyOf(model), 1);
    stop();
  }, options.ttlMs);
};

/**
 * Resolve with the row once it exists, or with `undefined` on timeout/abort. Resolves immediately, without
 * subscribing, when the row already exists.
 *
 * @param model Model to read.
 * @param id Row id to wait for.
 * @param options.timeoutMs Maximum time to wait before resolving with `undefined`.
 * @param options.signal Optional abort signal that resolves with `undefined` and cleans up immediately.
 * @returns A promise for the row, or `undefined` on timeout/abort.
 */
export const waitForRow = <TStored extends { id: string }>(
  model: WaiterModel<TStored>,
  id: string,
  options: WaitForRowOptions
): Promise<TStored | undefined> => {
  const generationFence = createGenerationFence();
  const existing = model.find(id);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: TStored | undefined): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      subscription.unsubscribe();
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    const subscription = getCommitBus().subscribe(() => {
      if (!generationFence.isCurrent()) {
        finish(undefined);
        return;
      }
      const row = model.find(id);
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
