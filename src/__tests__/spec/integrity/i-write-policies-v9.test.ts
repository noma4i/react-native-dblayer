import { belongsTo, configureDb, defineModel, f } from '../../../index';
import { isIncomingNewer } from '../../../core/invariants';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

describe('v9 model-owned write policies', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
  });

  it('applies the documented nullish newer-wins policy', () => {
    expect(isIncomingNewer(null, null)).toBe(true);
    expect(isIncomingNewer('2026-01-01T00:00:00Z', null)).toBe(false);
    expect(isIncomingNewer(null, '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('accepts equal timestamps and rejects strictly older incoming ones', () => {
    expect(isIncomingNewer('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(true);
    expect(isIncomingNewer('2026-01-01T00:00:01Z', '2026-01-01T00:00:00Z')).toBe(false);
    expect(isIncomingNewer('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')).toBe(true);
  });

  it('compares timestamps by instant across timezone offsets', () => {
    expect(isIncomingNewer('2026-01-01T00:00:00+11:00', '2025-12-31T13:00:00Z')).toBe(true);
    expect(isIncomingNewer('2025-12-31T13:00:00Z', '2026-01-01T00:00:00+11:00')).toBe(true);
  });

  it('applies the missing-value policy to unparseable timestamps', () => {
    expect(isIncomingNewer('2026-01-01T00:00:00Z', 'not-a-date')).toBe(false);
    expect(isIncomingNewer('not-a-date', '2026-01-01T00:00:00Z')).toBe(true);
    expect(isIncomingNewer('not-a-date', 'also-not-a-date')).toBe(true);
  });

  it('rejects an invalid or older newerBy timestamp and accepts a newer timestamp', () => {
    const rows = defineModel({
      id: 'V9NewerBy',
      name: 'V9NewerBy',
      fields: { updatedAt: f.str(), body: f.str() },
      write: { groups: [{ fields: ['updatedAt', 'body'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-01T00:00:00Z', body: 'current' });
    rows.insert({ id: 'row-1', updatedAt: 'invalid', body: 'invalid' });
    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-07-01T00:00:00Z', body: 'current' });
    rows.insert({ id: 'row-1', updatedAt: '2026-06-01T00:00:00Z', body: 'older' });
    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-07-01T00:00:00Z', body: 'current' });
    rows.insert({ id: 'row-1', updatedAt: '2026-08-01T00:00:00Z', body: 'newer' });

    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-08-01T00:00:00Z', body: 'newer' });
  });

  it('accepts both-missing newerBy values but rejects an unparseable incoming value against a valid one', () => {
    const rows = defineModel({
      id: 'V9NewerByMissing',
      name: 'V9NewerByMissing',
      fields: { updatedAt: f.raw<string | null>(), body: f.str() },
      write: { groups: [{ fields: ['updatedAt', 'body'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', updatedAt: null, body: 'first' });
    rows.insert({ id: 'row-1', updatedAt: 'invalid', body: 'both-missing' });
    expect(rows.find('row-1')).toMatchObject({ updatedAt: 'invalid', body: 'both-missing' });
    rows.insert({ id: 'row-1', updatedAt: '2026-08-01T00:00:00Z', body: 'valid' });
    rows.insert({ id: 'row-1', updatedAt: 'invalid', body: 'rejected' });

    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-08-01T00:00:00Z', body: 'valid' });
  });

  it('compares tuple fields numerically before using codepoint ordering', () => {
    const rows = defineModel({
      id: 'V9Tuple',
      name: 'V9Tuple',
      fields: { sequence: f.raw<number | string | null>(), messageId: f.str() },
      write: { groups: [{ fields: ['sequence', 'messageId'] as const, policy: { monotonic: { tuple: ['sequence', 'messageId'] } } }] }
    });
    rows.insert({ id: 'row-1', sequence: '9', messageId: 'b' });
    rows.insert({ id: 'row-1', sequence: 10, messageId: 'a' });
    rows.insert({ id: 'row-1', sequence: 2, messageId: 'z' });

    expect(rows.find('row-1')).toMatchObject({ sequence: 10, messageId: 'a' });
  });

  it('keeps prior values for nullish or empty nonEmpty writes', () => {
    const rows = defineModel({
      id: 'V9NonEmpty',
      name: 'V9NonEmpty',
      fields: { clientId: f.str().nullable() },
      write: { groups: [{ fields: ['clientId'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', clientId: 'client-1' });
    rows.insert({ id: 'row-1', clientId: '' });
    rows.insert({ id: 'row-1', clientId: null });

    expect(rows.find('row-1')?.clientId).toBe('client-1');
  });

  it('preserves media dimensions and sources during events but never during replace', () => {
    const media = defineModel({
      id: 'V9Media',
      name: 'V9Media',
      fields: { media: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['media'] as const, policy: [{ monotonic: { all: [{ ladder: { path: 'media.status', tiers: [['processing'], ['ready', 'failed', 'completed']] } }, { tuple: ['media.progress'] }] } }, { keys: { width: 'positive', height: 'positive', fileUrl: 'nonEmpty' } }] }] }
    });
    media.insert({ id: 'row-1', media: { width: 320, height: 240, fileUrl: 'file:///local.mp4', status: 'processing', progress: 80 } });
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 0, height: 0, fileUrl: '', status: 'processing', progress: 90 } } }) } }).apply('received', {});

    expect(media.find('row-1')?.media).toMatchObject({ width: 320, height: 240, fileUrl: 'file:///local.mp4', progress: 90 });
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 1, height: 1, fileUrl: 'https://cdn/server.mp4', status: 'ready', progress: 100 } } }) } }).apply('received', {});
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 2, height: 2, fileUrl: 'https://cdn/regression.mp4', status: 'processing', progress: 99 } } }) } }).apply('received', {});

    expect(media.find('row-1')?.media).toMatchObject({ width: 1, height: 1, fileUrl: 'https://cdn/server.mp4', status: 'ready', progress: 100 });
  });

  it('shallow-folds snapshot object fields but lets scalar and null snapshot values replace', () => {
    const rows = defineModel({
      id: 'V9Snapshot',
      name: 'V9Snapshot',
      fields: { payload: f.raw<Record<string, unknown>>().nullable() },
      write: { groups: [{ fields: ['payload'] as const, policy: { snapshot: true } }] }
    });
    rows.insert({ id: 'row-1', payload: { local: 'keep', server: 'old' } });
    rows.insert({ id: 'row-1', payload: { server: 'new' } });
    expect(rows.find('row-1')?.payload).toEqual({ local: 'keep', server: 'new' });
    rows.insert({ id: 'row-1', payload: null });
    expect(rows.find('row-1')?.payload).toBeNull();
  });

  it('folds the replaced row into a new id when the model has no write groups', () => {
    const rows = defineModel({
      id: 'V9ReplaceWithoutPolicies',
      name: 'V9ReplaceWithoutPolicies',
      fields: { body: f.str(), localUri: f.raw<string | undefined>() }
    });
    rows.insert({ id: 'temporary-id', body: 'optimistic', localUri: 'file:///local.mp4' });
    rows.replace('temporary-id', { id: 'server-id', body: 'server' });

    expect(rows.find('server-id')).toMatchObject({ body: 'server', localUri: 'file:///local.mp4' });
  });

  it('uses server values for every policy on replace', () => {
    const rows = defineModel({
      id: 'V9ReplacePolicyMatrix',
      name: 'V9ReplacePolicyMatrix',
      fields: {
        continuity: f.str().nullable(),
        sequence: f.num(),
        payload: f.raw<Record<string, unknown>>(),
        media: f.raw<Record<string, unknown>>()
      },
      write: {
        groups: [
          { fields: ['continuity'] as const, policy: 'continuity' },
          { fields: ['sequence'] as const, policy: { monotonic: { tuple: ['sequence'] } } },
          { fields: ['payload'] as const, policy: { snapshot: true } },
          { fields: ['media'] as const, policy: { keys: { width: 'positive', url: 'nonEmpty' } } }
        ]
      }
    });
    rows.insert({ id: 'temporary-id', continuity: 'local', sequence: 9, payload: { local: true }, media: { width: 320, url: 'file:///local.mp4' } });
    rows.replace('temporary-id', { id: 'server-id', continuity: null, sequence: 1, payload: { server: true }, media: { width: 0, url: 'https://cdn/server.mp4' } });

    expect(rows.find('server-id')).toMatchObject({ continuity: null, sequence: 1, payload: { server: true }, media: { width: 0, url: 'https://cdn/server.mp4' } });
  });

  it('lets a ladder abstain when either nested stage is absent', () => {
    const rows = defineModel({
      id: 'V9LadderAbstain',
      name: 'V9LadderAbstain',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: 'c' } });
    rows.insert({ id: 'row-1', blob: {} });
    expect(rows.find('row-1')?.blob).toEqual({});
    rows.insert({ id: 'row-1', blob: { stage: 'a' } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'a' });
  });

  it('rejects a lower ladder tier and accepts movement within its current tier', () => {
    const rows = defineModel({
      id: 'V9LadderTiers',
      name: 'V9LadderTiers',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: 'd' } });
    rows.insert({ id: 'row-1', blob: { stage: 'a' } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'd' });
    rows.insert({ id: 'row-1', blob: { stage: 'e' } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'e' });
  });

  it('reports an unknown incoming ladder tier but not an absent incoming tier', () => {
    const rows = defineModel({
      id: 'V9LadderUnknown',
      name: 'V9LadderUnknown',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: 'd' } });
    diagnostics().reset();

    rows.insert({ id: 'row-1', blob: { stage: 'unknown' } });

    expect(rows.find('row-1')?.blob).toEqual({ stage: 'd' });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'unranked-ladder-value', model: rows.modelId, count: 1 });

    diagnostics().reset();
    rows.insert({ id: 'row-1', blob: {} });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('composes ladder and tuple guards over nested paths', () => {
    const rows = defineModel({
      id: 'V9LadderTuple',
      name: 'V9LadderTuple',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { all: [{ ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } }, { tuple: ['blob.progress'] }] } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: 'c', progress: 10 } });
    rows.insert({ id: 'row-1', blob: { stage: 'a', progress: 11 } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'c', progress: 10 });
    rows.insert({ id: 'row-1', blob: { stage: 'd', progress: 11 } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'd', progress: 11 });
  });

  it('accepts one any branch but rejects an all composition with a failed branch', () => {
    const rows = defineModel({
      id: 'V9AnyAll',
      name: 'V9AnyAll',
      fields: { blob: f.raw<Record<string, unknown>>(), headId: f.str().nullable(), headAt: f.num(), headSeq: f.num() },
      write: { groups: [{ fields: ['blob', 'headId', 'headAt', 'headSeq'] as const, policy: { monotonic: { all: [{ present: 'headId' }, { any: [{ equal: 'headId' }, { tuple: ['headAt', 'headSeq'] }] }] } } }] }
    });
    rows.insert({ id: 'row-1', blob: {}, headId: 'head-1', headAt: 10, headSeq: 1 });
    rows.insert({ id: 'row-1', blob: {}, headId: 'head-1', headAt: 1, headSeq: 1 });
    expect(rows.find('row-1')).toMatchObject({ headId: 'head-1', headAt: 1, headSeq: 1 });
    rows.insert({ id: 'row-1', blob: {}, headId: null, headAt: 20, headSeq: 1 });
    expect(rows.find('row-1')).toMatchObject({ headId: 'head-1', headAt: 1, headSeq: 1 });
  });

  it('preserves positive and non-empty nested keys', () => {
    const rows = defineModel({
      id: 'V9NestedKeys',
      name: 'V9NestedKeys',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { keys: { w: 'positive', h: 'positive', url: 'nonEmpty', alt: 'nonEmpty' } } }] }
    });
    rows.insert({ id: 'row-1', blob: { w: 5, h: 4, url: 'local://blob', alt: ['label'] } });
    rows.insert({ id: 'row-1', blob: { w: 0, h: 'not-a-number', url: '', alt: [] } });
    expect(rows.find('row-1')?.blob).toEqual({ w: 5, h: 4, url: 'local://blob', alt: ['label'] });
    rows.insert({ id: 'row-1', blob: { w: -1, h: -2, url: {}, alt: '' } });
    expect(rows.find('row-1')?.blob).toEqual({ w: 5, h: 4, url: 'local://blob', alt: ['label'] });
  });

  it('applies a policy list left to right after a rejected guard restores the group', () => {
    const rows = defineModel({
      id: 'V9PolicySequence',
      name: 'V9PolicySequence',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: {
        groups: [
          {
            fields: ['blob'] as const,
            policy: [{ monotonic: { tuple: ['blob.progress'] } }, { keys: { w: 'positive' } }]
          }
        ]
      }
    });
    rows.insert({ id: 'row-1', blob: { progress: 10, w: 9 } });
    rows.insert({ id: 'row-1', blob: { progress: 9, w: 0 } });
    expect(rows.find('row-1')?.blob).toEqual({ progress: 10, w: 9 });
  });

  it('reads nested paths in newerBy, tuple, present, and equal predicates', () => {
    const newerRows = defineModel({
      id: 'V9PathNewer',
      name: 'V9PathNewer',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { newerBy: 'blob.updatedAt' } } }] }
    });
    newerRows.insert({ id: 'row-1', blob: { updatedAt: '2026-01-02T00:00:00Z' } });
    newerRows.insert({ id: 'row-1', blob: { updatedAt: '2026-01-01T00:00:00Z' } });
    expect(newerRows.find('row-1')?.blob).toEqual({ updatedAt: '2026-01-02T00:00:00Z' });

    const tupleRows = defineModel({
      id: 'V9PathTuple',
      name: 'V9PathTuple',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { tuple: ['blob.seq'] } } }] }
    });
    tupleRows.insert({ id: 'row-1', blob: { seq: 2 } });
    tupleRows.insert({ id: 'row-1', blob: { seq: 1 } });
    expect(tupleRows.find('row-1')?.blob).toEqual({ seq: 2 });

    const predicateRows = defineModel({
      id: 'V9PathPredicates',
      name: 'V9PathPredicates',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { all: [{ present: 'blob.headId' }, { any: [{ equal: 'blob.headId' }, { tuple: ['blob.headAt', 'blob.headSeq'] }] }] } } }] }
    });
    predicateRows.insert({ id: 'row-1', blob: { headId: 'head-1', headAt: 2, headSeq: 1 } });
    predicateRows.insert({ id: 'row-1', blob: { headId: 'head-1', headAt: 1, headSeq: 1 } });
    expect(predicateRows.find('row-1')?.blob).toEqual({ headId: 'head-1', headAt: 1, headSeq: 1 });
    predicateRows.insert({ id: 'row-1', blob: { headAt: 3, headSeq: 1 } });
    expect(predicateRows.find('row-1')?.blob).toEqual({ headId: 'head-1', headAt: 1, headSeq: 1 });
  });

  it('routes relation counter decrements through the patch write gate', () => {
    const parents = defineModel({
      id: 'V9CounterParent',
      name: 'V9CounterParent',
      fields: { childCount: f.num() },
      write: { groups: [{ fields: ['childCount'] as const, policy: { monotonic: { tuple: ['childCount'] }, on: ['patch'] } }] }
    });
    const children = defineModel({
      id: 'V9CounterChild',
      name: 'V9CounterChild',
      fields: { parentId: f.str() },
      relations: () => ({ parent: belongsTo(parents, { foreignKey: 'parentId', counterCache: { field: 'childCount' } }) })
    });
    parents.insert({ id: 'parent-1', childCount: 5 });
    children.insert({ id: 'child-1', parentId: 'parent-1' });
    expect(parents.find('parent-1')?.childCount).toBe(6);

    children.destroy('child-1');

    expect(parents.find('parent-1')?.childCount).toBe(6);
  });
});

describe('v9 policy primitive edges', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
  });

  it('rejects a nonEmpty group when the guarded field is absent from the payload', () => {
    const rows = defineModel({
      id: 'V9NonEmptyAbsent',
      name: 'V9NonEmptyAbsent',
      fields: { clientId: f.str(), body: f.str() },
      write: { groups: [{ fields: ['clientId'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', clientId: 'client-1', body: 'first' });
    rows.insert({ id: 'row-1', body: 'second' } as never);

    expect(rows.find('row-1')).toMatchObject({ clientId: 'client-1' });
  });

  it('treats numeric zero as a present nonEmpty value', () => {
    const rows = defineModel({
      id: 'V9NonEmptyZero',
      name: 'V9NonEmptyZero',
      fields: { rank: f.num() },
      write: { groups: [{ fields: ['rank'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', rank: 5 });
    rows.insert({ id: 'row-1', rank: 0 });

    expect(rows.find('row-1')).toMatchObject({ rank: 0 });
  });

  it('compares numeric-like tuple parts numerically and falls through equal parts', () => {
    const rows = defineModel({
      id: 'V9TupleNumeric',
      name: 'V9TupleNumeric',
      fields: { headAt: f.str(), headSeq: f.str(), body: f.str() },
      write: { groups: [{ fields: ['headAt', 'headSeq', 'body'] as const, policy: { monotonic: { tuple: ['headAt', 'headSeq'] } } }] }
    });
    rows.insert({ id: 'row-1', headAt: '9', headSeq: '5', body: 'first' });
    rows.insert({ id: 'row-1', headAt: '10', headSeq: '1', body: 'numeric-win' });
    expect(rows.find('row-1')).toMatchObject({ body: 'numeric-win' });

    rows.insert({ id: 'row-1', headAt: '10', headSeq: '2', body: 'tiebreak-win' });
    expect(rows.find('row-1')).toMatchObject({ body: 'tiebreak-win' });

    rows.insert({ id: 'row-1', headAt: '10', headSeq: '2', body: 'equal-loses' });
    expect(rows.find('row-1')).toMatchObject({ body: 'tiebreak-win' });
  });

  it('restores the whole rejected group so a stale partial can never tear paired fields', () => {
    const rows = defineModel({
      id: 'V9GroupAtomic',
      name: 'V9GroupAtomic',
      fields: { updatedAt: f.str(), body: f.str(), unguarded: f.str() },
      write: { groups: [{ fields: ['updatedAt', 'body'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-02T00:00:00Z', body: 'fresh', unguarded: 'old' });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-01T00:00:00Z', body: 'stale', unguarded: 'new' });

    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-07-02T00:00:00Z', body: 'fresh', unguarded: 'new' });
  });
});
