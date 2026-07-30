import { createSingleFlight, createThrottledSingleFlight, configureDb, resetRuntime } from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

const deferred = <TResult>() => {
  let resolve!: (value: TResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createSingleFlight', () => {
  it('coalesces concurrent calls into a single fn invocation and resolves both callers with the same result', async () => {
    const flight = deferred<number>();
    const fn = jest.fn(() => flight.promise);
    const singleFlight = createSingleFlight(fn);

    const first = singleFlight();
    const second = singleFlight();
    expect(fn).toHaveBeenCalledTimes(1);

    flight.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
  });

  it('propagates the rejection to every concurrent caller sharing the flight', async () => {
    const flight = deferred<number>();
    const fn = jest.fn(() => flight.promise);
    const singleFlight = createSingleFlight(fn);
    const error = new Error('boom');

    const first = singleFlight();
    const second = singleFlight();
    expect(fn).toHaveBeenCalledTimes(1);

    flight.reject(error);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
  });

  it('starts a new flight after the previous one settles, whether it resolved or rejected', async () => {
    const first = deferred<number>();
    const fn = jest.fn(() => first.promise);
    const singleFlight = createSingleFlight(fn);

    const firstCall = singleFlight();
    first.resolve(1);
    await expect(firstCall).resolves.toBe(1);

    const second = deferred<number>();
    fn.mockImplementationOnce(() => second.promise);
    const secondCall = singleFlight();
    expect(fn).toHaveBeenCalledTimes(2);
    second.resolve(2);
    await expect(secondCall).resolves.toBe(2);
  });

  it('resetOnRuntimeReset: a runtime reset mid-flight makes the next call start a new flight immediately, and the old flight settling afterward does not clobber the new in-flight slot', async () => {
    setupSpecRuntime();
    const oldFlight = deferred<string>();
    const newFlight = deferred<string>();
    const fn = jest.fn().mockReturnValueOnce(oldFlight.promise).mockReturnValueOnce(newFlight.promise);
    const singleFlight = createSingleFlight(fn, { resetOnRuntimeReset: true });

    const oldCall = singleFlight();
    expect(fn).toHaveBeenCalledTimes(1);

    resetRuntime();

    const newCall = singleFlight();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(newCall).not.toBe(oldCall);

    oldFlight.resolve('old-result');
    await expect(oldCall).resolves.toBe('old-result');

    const thirdCall = singleFlight();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(thirdCall).toBe(newCall);

    newFlight.resolve('new-result');
    await expect(newCall).resolves.toBe('new-result');
  });

  it('without resetOnRuntimeReset, a runtime reset mid-flight does not affect the shared in-flight promise', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });

    const flight = deferred<number>();
    const fn = jest.fn(() => flight.promise);
    const singleFlight = createSingleFlight(fn);

    const first = singleFlight();
    resetRuntime();
    const second = singleFlight();

    expect(second).toBe(first);
    expect(fn).toHaveBeenCalledTimes(1);

    flight.resolve(7);
    await expect(first).resolves.toBe(7);
  });
});

describe('createThrottledSingleFlight', () => {
  it('allows a new execution exactly at the success interval boundary', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const fn = jest.fn(() => Promise.resolve('value'));
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 100 });
    try {
      await expect(throttled()).resolves.toBe('value');
      nowSpy.mockReturnValue(1_100);
      await expect(throttled()).resolves.toBe('value');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shares one in-flight execution and suppresses another call inside the success interval', async () => {
    const flight = deferred<string>();
    const fn = jest.fn(() => flight.promise);
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000 });

    const first = throttled();
    const second = throttled();
    expect(second).toBe(first);
    expect(fn).toHaveBeenCalledTimes(1);

    flight.resolve('value');
    await expect(first).resolves.toBe('value');
    await expect(throttled()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses the default force flag to bypass the success interval', async () => {
    const fn = jest.fn((_options: { force: boolean }) => Promise.resolve('value'));
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000 });

    await expect(throttled({ force: false })).resolves.toBe('value');
    await expect(throttled({ force: false })).resolves.toBeUndefined();
    await expect(throttled({ force: true })).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses a custom force predicate for non-record arguments', async () => {
    const fn = jest.fn((force: boolean) => Promise.resolve(force));
    const isForced = jest.fn((force: boolean) => force);
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000, isForced });

    await expect(throttled(false)).resolves.toBe(false);
    await expect(throttled(false)).resolves.toBeUndefined();
    await expect(throttled(true)).resolves.toBe(true);
    expect(isForced).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('swallows asynchronous and synchronous failures and permits a later retry', async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('async failure'))
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      })
      .mockResolvedValueOnce('recovered');
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000 });

    await expect(throttled()).resolves.toBeUndefined();
    await expect(throttled()).resolves.toBeUndefined();
    await expect(throttled()).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('resetOnRuntimeReset: a runtime reset clears the throttle window and the in-flight slot', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });

    const fn = jest.fn(() => Promise.resolve('value'));
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000, resetOnRuntimeReset: true });

    await expect(throttled()).resolves.toBe('value');
    await expect(throttled()).resolves.toBeUndefined();

    resetRuntime();

    await expect(throttled()).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('without reset registration, a runtime reset preserves the current throttle window', async () => {
    setupSpecRuntime();
    const fn = jest.fn(() => Promise.resolve('value'));
    const throttled = createThrottledSingleFlight(fn, { minIntervalMs: 60_000 });

    await expect(throttled()).resolves.toBe('value');
    resetRuntime();
    await expect(throttled()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
