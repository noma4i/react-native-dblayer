import { createOperationState } from '../../core/planes/operationState';
import { flushPersistence } from '../../dsl/configure';
import { createMemoryStorage } from '../helpers/memoryStorage';
import { createInvariantFixture, RETENTION_MAX_ROWS, runSession, storageByteSize, storageKeyCount } from './session.helpers';

const MODELS = 2;
const SCOPES_PER_MODEL = 3;
const JOURNAL_CAP = 50;
const LEDGER_KEYS = 2;
const APPLIED_MARKERS = MODELS;
const META_KEYS = 1;
const MAX_LIVE_ROWS = MODELS * SCOPES_PER_MODEL * RETENTION_MAX_ROWS;
const MAX_PERSISTED_KEYS = MAX_LIVE_ROWS + MODELS * SCOPES_PER_MODEL + JOURNAL_CAP + LEDGER_KEYS + APPLIED_MARKERS + META_KEYS;
const ROW_BYTES = 96;
const MAX_PERSISTED_BYTES = MAX_LIVE_ROWS * ROW_BYTES + MAX_PERSISTED_KEYS * 128;

const scriptedSession = (ingestCount: number) => [
  ...(['Alpha', 'Beta'] as const).flatMap(model => Array.from({ length: SCOPES_PER_MODEL }, (_, bucket) => ({ kind: 'pages' as const, model, scope: { bucket: String(bucket) }, count: 5, rowsPerPage: 20 }))),
  { kind: 'ingestEvents' as const, model: 'Alpha', count: ingestCount },
  { kind: 'ingestEvents' as const, model: 'Beta', count: ingestCount },
  { kind: 'optimistic' as const, model: 'Alpha', count: 20, outcome: 'commit' as const },
  { kind: 'optimistic' as const, model: 'Beta', count: 10, outcome: 'rollback' as const },
  { kind: 'destroys' as const, model: 'Alpha', count: 15 },
  { kind: 'destroys' as const, model: 'Beta', count: 15 }
];

describe('budget invariants', () => {
  it('B1: retention-derived key bound holds after the full scripted session', async () => {
    const fixture = createInvariantFixture();
    await runSession(fixture.driver, scriptedSession(200));
    fixture.flushAndCollect();

    expect(storageKeyCount(fixture.storage.storage)).toBeLessThanOrEqual(MAX_PERSISTED_KEYS);
  });

  it('B2: persisted bytes are retention-bound rather than proportional to ingest traffic', async () => {
    const baseline = createInvariantFixture();
    await runSession(baseline.driver, scriptedSession(200));
    baseline.flushAndCollect();
    const baselineBytes = storageByteSize(baseline.storage.storage);
    const doubled = createInvariantFixture();
    await runSession(doubled.driver, scriptedSession(400));
    doubled.flushAndCollect();
    const doubledBytes = storageByteSize(doubled.storage.storage);

    expect(baselineBytes).toBeLessThanOrEqual(MAX_PERSISTED_BYTES);
    expect(doubledBytes).toBeLessThanOrEqual(Math.ceil(baselineBytes * 1.1));
  });

  it('B3: flushing k dirty rows persists exactly k row entries', () => {
    const fixture = createInvariantFixture();
    const batches: Array<Array<{ key: string; value: string | null }>> = [];
    const set = fixture.storage.storage.set;
    fixture.storage.storage.set = entries => {
      batches.push(entries);
      set(entries);
    };
    const K = 7;
    for (let index = 0; index < K; index += 1) fixture.models.Alpha.insertStored({ id: `patch:${index}`, bucket: 'patch', value: index });
    flushPersistence();
    const rowKeys = batches.flatMap(batch => batch).filter(entry => entry.key.startsWith('dbl:row:InvariantAlpha:'));

    expect(rowKeys).toHaveLength(K);
  });

  it('B4: closed operations prune by TTL and keyed sequences remain capped', () => {
    let now = 0;
    const memory = createMemoryStorage();
    const state = createOperationState({ storage: memory.storage, prefix: () => 'dbl:', now: () => now });
    for (let index = 0; index < 513; index += 1) state.nextSequence(`sequence:${index}`, 0);
    state.begin({ operationId: 'closed', model: 'InvariantAlpha', tempIds: [], intent: 'insert', idempotencyKey: 'closed', createdAt: now });
    state.close('closed', 'committed');
    now = 60 * 60 * 1000 + 1;
    state.prune();
    memory.storage.set(state.persistEntries());

    expect(state.hasCommitted('closed')).toBe(false);
    expect(Object.keys(JSON.parse(memory.storage.get('dbl:seq')!) as Record<string, number>)).toHaveLength(512);
  });
});
