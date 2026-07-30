import { createCheckpointScheduler } from '../../../core/apply/checkpoint';
import type { CheckpointTarget } from '../../../types';
import { createMemoryPlane } from '../helpers/harness';

const setup = (maxPendingPlans = 10) => {
  const storage = createMemoryPlane();
  const write = jest.spyOn(storage, 'set');
  const target: CheckpointTarget = {
    persistEntries: jest.fn(() => [{ key: 'row', value: 'value' }]),
    ackPersist: jest.fn()
  };
  const scheduler = createCheckpointScheduler({
    storage,
    prefix: () => 'checkpoint:',
    getTarget: () => target,
    delayMs: 10,
    maxPendingPlans
  });
  return { scheduler, target, write };
};

describe('checkpoint scheduler pacing', () => {
  it('keeps the pending-plan backlog when a flush write fails', () => {
    const storage = createMemoryPlane();
    const scheduler = createCheckpointScheduler({
      storage,
      prefix: () => 'dbl:',
      getTarget: () => ({ persistEntries: () => [{ key: 'dbl:row', value: 'x' }], ackPersist: () => {} }),
      delayMs: 10_000,
      maxPendingPlans: 100
    });
    scheduler.notePlan(['SpecCheckpointModel'], 1);
    scheduler.notePlan(['SpecCheckpointModel'], 2);
    const originalSet = storage.set.bind(storage);
    storage.set = () => {
      throw new Error('flush write failed');
    };

    expect(() => scheduler.flushNow()).toThrow('flush write failed');
    expect(scheduler.pendingPlans()).toBe(2);

    storage.set = originalSet;
    scheduler.flushNow();
    expect(scheduler.pendingPlans()).toBe(0);
    expect(scheduler.flushedEpoch()).toBe(2);
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('flushes at the first armed deadline without restarting on later plans', () => {
    const { scheduler, target, write } = setup();
    scheduler.notePlan(['Rows'], 1);
    jest.advanceTimersByTime(5);
    scheduler.notePlan(['Rows'], 2);
    jest.advanceTimersByTime(5);

    expect(write).toHaveBeenCalledTimes(1);
    expect(target.ackPersist).toHaveBeenCalledTimes(1);
    expect(scheduler.flushedEpoch()).toBe(2);
    expect(scheduler.pendingPlans()).toBe(0);
    scheduler.cancel();
  });

  it('flushes synchronously at the pending-plan cap and cancels the armed deadline', () => {
    const { scheduler, write } = setup(3);
    scheduler.notePlan(['Rows'], 1);
    scheduler.notePlan(['Rows'], 2);
    scheduler.notePlan(['Rows'], 3);

    expect(write).toHaveBeenCalledTimes(1);
    expect(scheduler.flushedEpoch()).toBe(3);
    jest.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
    scheduler.cancel();
  });

  it('cancels a pending deadline and discards its dirty plan set', () => {
    const { scheduler, write } = setup();
    scheduler.notePlan(['Rows'], 1);
    scheduler.cancel();
    jest.advanceTimersByTime(10);

    expect(write).not.toHaveBeenCalled();
    expect(scheduler.pendingPlans()).toBe(0);
  });
});
