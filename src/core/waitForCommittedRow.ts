import type { CommitSubscription, ModelWaitOptions } from '../types';
import { getCommitBus } from '../dsl/configure';
import { createGenerationFence } from '../utils/runtimeGeneration';

/** Resolve a committed model row or finish with `undefined` at a terminal boundary. */
export const waitForCommittedRow = <TStored extends { id: string }>(
  model: { key: string; find(id: string | null | undefined): TStored | undefined },
  id: string | null | undefined,
  options: ModelWaitOptions
): Promise<TStored | undefined> => {
  if (id == null || options.signal?.aborted) return Promise.resolve(undefined);

  const generationFence = createGenerationFence();
  const existing = model.find(id);
  if (existing) return Promise.resolve(existing);

  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let subscription: CommitSubscription | null = null;
    let settled = false;
    const finish = (value: TStored | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
      subscription?.unsubscribe();
      subscription = null;
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);

    subscription = getCommitBus().subscribe(() => {
      if (!generationFence.isCurrent()) {
        finish(undefined);
        return;
      }
      const row = model.find(id);
      if (row) finish(row);
    }, [{ kind: 'row', model: model.key, id }]);
    timer = setTimeout(() => finish(undefined), options.timeoutMs);
    if (options.signal?.aborted) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', onAbort);
  });
};
