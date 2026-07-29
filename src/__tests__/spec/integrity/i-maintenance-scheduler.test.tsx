jest.mock('../../../core/gc', () => ({ ...jest.requireActual('../../../core/gc'), collectGarbage: jest.fn() }));

import { configureDb, defineModel, f } from '../../../index';
import { collectGarbage } from '../../../core/gc';
import { startMaintenanceScheduler } from '../../../core/maintenanceScheduler';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('maintenance scheduler', () => {
  it('does not starve the first armed sweep when more pressure arrives', () => {
    jest.useFakeTimers();
    let stop = (): void => {};
    try {
      const collect = collectGarbage as jest.MockedFunction<typeof collectGarbage>;
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const rows = defineModel({ id: 'MaintenanceSchedulerNonStarvation', name: 'MaintenanceSchedulerNonStarvation', fields: { label: f.str() } });
      stop = startMaintenanceScheduler({ threshold: 1, debounceMs: 10 });

      rows.insert({ id: 'row-1', label: 'first' });
      rows.destroy('row-1');
      jest.advanceTimersByTime(5);
      rows.insert({ id: 'row-2', label: 'second' });
      rows.destroy('row-2');
      jest.advanceTimersByTime(5);

      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      jest.useRealTimers();
    }
  });

  it('logs a failed GC tick and schedules the next eligible tick', () => {
    jest.useFakeTimers();
    try {
      const error = jest.fn();
      const collect = collectGarbage as jest.MockedFunction<typeof collectGarbage>;
      collect.mockImplementationOnce(() => {
        throw new Error('gc failed');
      });
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport(), logger: { debug: () => {}, error } });
      const rows = defineModel({ id: 'MaintenanceSchedulerRows', name: 'MaintenanceSchedulerRows', fields: { label: f.str() } });
      const stop = startMaintenanceScheduler({ threshold: 1, debounceMs: 10 });

      rows.insert({ id: 'row-1', label: 'first' });
      rows.destroy('row-1');
      jest.advanceTimersByTime(10);
      expect(error).toHaveBeenCalledWith('MaintenanceScheduler', 'garbage collection failed', expect.objectContaining({ error: expect.any(Error) }));

      rows.insert({ id: 'row-2', label: 'second' });
      rows.destroy('row-2');
      jest.advanceTimersByTime(10);
      expect(collect).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
