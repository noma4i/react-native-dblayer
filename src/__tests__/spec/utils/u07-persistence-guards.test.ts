import {
  buildScopeKey,
  configureDb,
  decodePersistence,
  matchesDbWhere,
  encodePersistence,
  invalidatePersistedQuery,
  jsonRoundTrip,
  readPersistedQuery,
  removePersistedQuery,
  writePersistedQuery
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const DECLARATION = { family: 'query:guards', persistenceVersion: 1, fingerprint: 'fp-1' };

const record = (identity: string, overrides: Record<string, unknown> = {}) => ({
  recordVersion: 2,
  family: DECLARATION.family,
  identity,
  persistenceVersion: 1,
  fingerprint: DECLARATION.fingerprint,
  empty: false,
  dataUpdatedAt: 5,
  invalidated: false,
  invalidationRevision: 0,
  scope: { chatId: identity },
  payload: { ids: [identity] },
  ...overrides
});

/**
 * Owner contract of the durable query record store and its codec: every malformed field rejects
 * the whole record, the checksum detects byte damage, and family operations touch exactly their
 * own family.
 */
describe('persisted query record guards', () => {
  let storage!: ReturnType<typeof createMemoryPlane>;

  beforeEach(() => {
    storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
  });

  const readBack = (identity: string) => readPersistedQuery(DECLARATION, identity, candidate => ({ payload: candidate.payload, scope: candidate.scope }));

  it('round-trips a record and removes exactly one identity or one family', () => {
    expect(writePersistedQuery(record('chat-1'))).toBe(true);
    expect(writePersistedQuery(record('chat-2'))).toBe(true);
    expect(writePersistedQuery({ ...record('other'), family: 'query:other' })).toBe(true);
    expect(readBack('chat-1')?.payload).toEqual({ ids: ['chat-1'] });

    removePersistedQuery(DECLARATION, 'chat-1');
    expect(readBack('chat-1')).toBeUndefined();
    expect(readBack('chat-2')).toBeDefined();

    removePersistedQuery(DECLARATION);
    expect(readBack('chat-2')).toBeUndefined();
    expect(() => removePersistedQuery(DECLARATION)).not.toThrow();
    expect(readPersistedQuery({ ...DECLARATION, family: 'query:other' }, 'other', candidate => ({ payload: candidate.payload, scope: candidate.scope }))).toBeDefined();
  });

  it.each([
    ['record version', { recordVersion: 3 }],
    ['family type', { family: 7 }],
    ['identity type', { identity: 7 }],
    ['persistence version', { persistenceVersion: 1.5 }],
    ['fingerprint type', { fingerprint: 7 }],
    ['empty flag', { empty: 'no' }],
    ['updatedAt type', { dataUpdatedAt: 'now' }],
    ['updatedAt sign', { dataUpdatedAt: -1 }],
    ['invalidated flag', { invalidated: 'yes' }]
  ])('rejects and deletes a stored record with a malformed %s', (_label, overrides) => {
    expect(writePersistedQuery(record('bad'))).toBe(true);
    const key = storage.snapshotKeys().find(candidate => candidate.includes('query:guards'))!;
    [{ key, value: encodePersistence(record('bad', overrides)) }].forEach(entry => storage.set(entry.key, entry.value));

    expect(readBack('bad')).toBeUndefined();
    expect(storage.get(key)).toBeUndefined();
  });

  it('marks only accepted records invalidated and returns them', () => {
    writePersistedQuery(record('keep'));
    writePersistedQuery(record('flip'));

    const flipped = invalidatePersistedQuery(DECLARATION, candidate => candidate.identity === 'flip');

    expect(flipped.map(entry => entry.identity)).toEqual(['flip']);
    expect(readBack('flip')?.invalidated).toBe(true);
    expect(readBack('keep')?.invalidated).toBe(false);
  });
});

describe('where operator matching', () => {
  it('gates ordered comparisons by operand types', () => {
    // Ordered operators never coerce across types.
    expect(matchesDbWhere({ id: 'r', seq: '5' }, { seq: { gt: 4 } } as never)).toBe(false);
    expect(matchesDbWhere({ id: 'r', seq: 5 }, { seq: { gt: '4' } } as never)).toBe(false);
    expect(matchesDbWhere({ id: 'r', seq: 5 }, { seq: { gt: Number.NaN } } as never)).toBe(false);
    expect(matchesDbWhere({ id: 'r', name: 'b' }, { name: { gt: 'a', lt: 'c' } } as never)).toBe(true);
    expect(matchesDbWhere({ id: 'r', name: 'a' }, { name: { gte: 'a' } } as never)).toBe(true);
    expect(matchesDbWhere({ id: 'r', name: 'c' }, { name: { lte: 'b' } } as never)).toBe(false);
  });

  it('builds one deterministic scope key regardless of condition key order', () => {
    expect(buildScopeKey({ beta: 1, alpha: 'x' })).toBe(buildScopeKey({ alpha: 'x', beta: 1 }));
    expect(buildScopeKey({})).toBe(buildScopeKey(undefined as never));
  });
});

describe('persistence codec', () => {
  it('detects byte damage through the checksum and rejects foreign schema versions', () => {
    const encoded = encodePersistence({ label: 'sound' });
    expect(decodePersistence(encoded, 1, (value): value is { label: string } => typeof (value as { label?: unknown }).label === 'string')).toMatchObject({
      kind: 'ok',
      value: { label: 'sound' }
    });
    const damaged = encoded.replace('sound', 'nouns');
    expect(decodePersistence(damaged, 1, (value: unknown): value is unknown => value !== undefined || true).kind).toBe('corrupt');
    expect(decodePersistence('not-json', 1, (value: unknown): value is unknown => value !== undefined || true).kind).toBe('corrupt');
  });

  it('accepts only lossless JSON values in a round trip', () => {
    expect(jsonRoundTrip({ nested: { list: [1, 'two', null, true] } })).toMatchObject({ serializable: true });
    expect(jsonRoundTrip(Number.NaN).serializable).toBe(false);
    expect(jsonRoundTrip(-0).serializable).toBe(false);
    expect(jsonRoundTrip(new Date(0)).serializable).toBe(false);
    expect(jsonRoundTrip({ fn: () => 1 }).serializable).toBe(false);
    expect(jsonRoundTrip(Object.assign([], { 0: 'a', extra: true })).serializable).toBe(false);
    const sparse = Object.assign(new Array<string>(2), { 1: 'tail' });
    expect(jsonRoundTrip(sparse).serializable).toBe(false);
    const getter = {};
    Object.defineProperty(getter, 'computed', { enumerable: true, get: () => 1 });
    expect(jsonRoundTrip(getter).serializable).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(jsonRoundTrip(cyclic).serializable).toBe(false);
  });
});
