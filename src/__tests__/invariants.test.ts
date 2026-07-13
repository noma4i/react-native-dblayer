import { isIncomingNewer } from '../index';
import { shouldAcceptIncoming } from '../core/invariants';

type TestItem = Record<string, unknown> & {
  id: string;
  updatedAt?: string | null;
  body?: string;
  status?: string;
};

describe('core invariants', () => {
  it('exports the canonical incoming timestamp comparator', () => {
    expect(isIncomingNewer(null, undefined)).toBe(true);
    expect(isIncomingNewer('2026-04-09T00:00:10.000Z', null)).toBe(false);
    expect(isIncomingNewer(null, '2026-04-09T00:00:10.000Z')).toBe(true);
    expect(isIncomingNewer('2026-04-09T00:00:10.000Z', '2026-04-09T00:00:11.000Z')).toBe(true);
    expect(isIncomingNewer('2026-04-09T00:00:10.000Z', '2026-04-09T00:00:09.000Z')).toBe(false);
    expect(isIncomingNewer('2026-04-09T00:00:10.000Z', '2026-04-09T00:00:10.000Z')).toBe(true);
  });

  it('accepts newer and equal timestamps and rejects older timestamps by default', () => {
    const existing: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'old' };

    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:11.000Z', body: 'newer' })).toBe(true);
    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'equal' })).toBe(true);
    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:09.000Z', body: 'older' })).toBe(false);
  });

  it('preserves missing updatedAt modes', () => {
    const existingWithTimestamp: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'old' };
    const existingWithoutTimestamp: TestItem = { id: '1', body: 'old' };

    expect(shouldAcceptIncoming(existingWithTimestamp, { id: '1', body: 'missing incoming timestamp' })).toBe(false);
    expect(shouldAcceptIncoming(existingWithoutTimestamp, { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'incoming timestamp' })).toBe(true);
    expect(shouldAcceptIncoming(existingWithTimestamp, { id: '1', body: 'replace mode' }, { timestampMode: 'when-both-present' })).toBe(true);
  });

  it('skips shallow-equal full records', () => {
    const existing: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'same' };

    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'same' })).toBe(false);
  });

  it('allows shouldOverwrite to override the timestamp gate', () => {
    const shouldOverwrite = jest.fn(() => true);
    const existing: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'old' };
    const incoming: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:09.000Z', body: 'override' };

    expect(shouldAcceptIncoming(existing, incoming, { shouldOverwrite })).toBe(true);
    expect(shouldOverwrite).toHaveBeenCalledWith(existing, incoming);
  });

  it('ignores undefined fields in defined-field equality mode', () => {
    const existing: TestItem = { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: 'same', status: 'sent' };

    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: undefined }, { equalityMode: 'defined-fields' })).toBe(false);
    expect(shouldAcceptIncoming(existing, { id: '1', updatedAt: '2026-04-09T00:00:10.000Z', body: undefined, status: 'read' }, { equalityMode: 'defined-fields' })).toBe(true);
  });
});
