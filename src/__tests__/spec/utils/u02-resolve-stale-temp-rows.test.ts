import { resolveStaleTempRows } from '../../../utils/runtimePrimitives';

type Row = { id: string; createdAt: string };

describe('resolveStaleTempRows NaN safety', () => {
  it('treats an unparseable createdAt as maximally stale instead of protecting the row indefinitely', () => {
    const onStale = jest.fn();
    const badRow: Row = { id: 'temp-bad', createdAt: 'not-a-date' };
    const oldRow: Row = { id: 'temp-old', createdAt: new Date(Date.now() - 10_000).toISOString() };
    const model = { all: () => [badRow, oldRow] };

    const resolved = resolveStaleTempRows(model, { maxAgeMs: 1, onStale });

    expect(onStale).toHaveBeenCalledWith(badRow);
    expect(onStale).toHaveBeenCalledWith(oldRow);
    expect(resolved).toBe(2);
  });

  it('still protects a temp row with a valid, recent createdAt', () => {
    const onStale = jest.fn();
    const freshRow: Row = { id: 'temp-fresh', createdAt: new Date().toISOString() };
    const model = { all: () => [freshRow] };

    const resolved = resolveStaleTempRows(model, { maxAgeMs: 60_000, onStale });

    expect(onStale).not.toHaveBeenCalled();
    expect(resolved).toBe(0);
  });
});
