import { belongsTo, configureDb, defineModelRuntime, f , isIncomingNewer } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

describe('model-owned write policies', () => {
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
    const rows = defineModelRuntime({
      id: 'PolicyNewerBy',
      name: 'PolicyNewerBy',
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

  it('restores a field the previous row never had by omission on monotonic rejection', () => {
    const rows = defineModelRuntime({
      id: 'PolicyRejectMissingField',
      name: 'PolicyRejectMissingField',
      fields: { updatedAt: f.str(), body: f.str().optional(), label: f.str() },
      write: { groups: [{ fields: ['updatedAt', 'body'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-01T00:00:00Z', label: 'first' });
    rows.insert({ id: 'row-1', updatedAt: '2026-06-01T00:00:00Z', body: 'older', label: 'second' });

    const row = rows.find('row-1')!;
    expect(row.label).toBe('second');
    expect('body' in row).toBe(false);
  });

  it('restores a field the previous row never had by omission under continuity', () => {
    const rows = defineModelRuntime({
      id: 'PolicyContinuityMissingField',
      name: 'PolicyContinuityMissingField',
      fields: { body: f.str().nullable().optional(), label: f.str() },
      write: { groups: [{ fields: ['body'] as const, policy: 'continuity' }] }
    });
    rows.insert({ id: 'row-1', label: 'first' });
    rows.insert({ id: 'row-1', body: null, label: 'second' });

    const row = rows.find('row-1')!;
    expect(row.label).toBe('second');
    expect('body' in row).toBe(false);
  });

  it('restores a nested key the previous object never had by omission under a nested continuity policy', () => {
    const rows = defineModelRuntime({
      id: 'PolicyNestedMissingKey',
      name: 'PolicyNestedMissingKey',
      fields: { meta: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['meta'] as const, policy: { keys: { count: 'continuity' } } }] }
    });
    rows.insert({ id: 'row-1', meta: { other: 1 } });
    rows.insert({ id: 'row-1', meta: { other: 2, count: null } });

    const meta = rows.find('row-1')!.meta as Record<string, unknown>;
    expect(meta.other).toBe(2);
    expect('count' in meta).toBe(false);
  });

  it('accepts both-missing newerBy values but rejects an unparseable incoming value against a valid one', () => {
    const rows = defineModelRuntime({
      id: 'PolicyNewerByMissing',
      name: 'PolicyNewerByMissing',
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
    const rows = defineModelRuntime({
      id: 'PolicyTuple',
      name: 'PolicyTuple',
      fields: { sequence: f.raw<number | string | null>(), messageId: f.str() },
      write: { groups: [{ fields: ['sequence', 'messageId'] as const, policy: { monotonic: { tuple: ['sequence', 'messageId'] } } }] }
    });
    rows.insert({ id: 'row-1', sequence: '9', messageId: 'b' });
    rows.insert({ id: 'row-1', sequence: 10, messageId: 'a' });
    rows.insert({ id: 'row-1', sequence: 2, messageId: 'z' });

    expect(rows.find('row-1')).toMatchObject({ sequence: 10, messageId: 'a' });
  });

  it('keeps prior values for nullish or empty nonEmpty writes', () => {
    const rows = defineModelRuntime({
      id: 'PolicyNonEmpty',
      name: 'PolicyNonEmpty',
      fields: { clientId: f.str().nullable() },
      write: { groups: [{ fields: ['clientId'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', clientId: 'client-1' });
    rows.insert({ id: 'row-1', clientId: '' });
    rows.insert({ id: 'row-1', clientId: null });

    expect(rows.find('row-1')?.clientId).toBe('client-1');
  });

  it('preserves guarded media values during events and replace', () => {
    const media = defineModelRuntime({
      id: 'PolicyMedia',
      name: 'PolicyMedia',
      fields: { media: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['media'] as const, policy: [{ monotonic: { all: [{ ladder: { path: 'media.status', tiers: [['processing'], ['ready', 'failed', 'completed']] } }, { tuple: ['media.progress'] }] } }, { keys: { width: 'positive', height: 'positive', fileUrl: 'nonEmpty' } }] }] }
    });
    media.insert({ id: 'row-1', media: { width: 320, height: 240, fileUrl: 'file:///local.mp4', status: 'processing', progress: 80 } });
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 0, height: 0, fileUrl: '', status: 'processing', progress: 90 } } }) } }).apply('received', {});

    expect(media.find('row-1')?.media).toMatchObject({ width: 320, height: 240, fileUrl: 'file:///local.mp4', progress: 90 });
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 1, height: 1, fileUrl: 'https://cdn/server.mp4', status: 'ready', progress: 100 } } }) } }).apply('received', {});
    media.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', media: { width: 2, height: 2, fileUrl: 'https://cdn/regression.mp4', status: 'processing', progress: 99 } } }) } }).apply('received', {});

    expect(media.find('row-1')?.media).toMatchObject({ width: 1, height: 1, fileUrl: 'https://cdn/server.mp4', status: 'ready', progress: 100 });
    media.replace('row-1', {
      id: 'row-server',
      media: { width: 0, height: 0, fileUrl: '', status: 'processing', progress: 99 }
    });

    expect(media.find('row-server')?.media).toMatchObject({
      width: 1,
      height: 1,
      fileUrl: 'https://cdn/server.mp4',
      status: 'processing',
      progress: 99
    });
  });

  it('shallow-folds snapshot object fields but lets scalar and null snapshot values replace', () => {
    const rows = defineModelRuntime({
      id: 'PolicySnapshot',
      name: 'PolicySnapshot',
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
    const rows = defineModelRuntime({
      id: 'PolicyReplaceWithoutPolicies',
      name: 'PolicyReplaceWithoutPolicies',
      fields: { body: f.str(), localUri: f.raw<string | undefined>() }
    });
    rows.insert({ id: 'temporary-id', body: 'optimistic', localUri: 'file:///local.mp4' });
    rows.replace('temporary-id', { id: 'server-id', body: 'server' });

    expect(rows.find('server-id')).toMatchObject({ body: 'server', localUri: 'file:///local.mp4' });
  });

  it('applies structural and local policies while leaving monotonic replace authoritative', () => {
    const rows = defineModelRuntime({
      id: 'PolicyReplacePolicyMatrix',
      name: 'PolicyReplacePolicyMatrix',
      fields: {
        continuity: f.str().nullable(),
        local: f.str().nullable(),
        sequence: f.num(),
        payload: f.raw<Record<string, unknown>>(),
        media: f.raw<Record<string, unknown>>()
      },
      write: {
        groups: [
          { fields: ['continuity'] as const, policy: 'continuity' },
          { fields: ['local'] as const, policy: 'local' },
          { fields: ['sequence'] as const, policy: { monotonic: { tuple: ['sequence'] } } },
          { fields: ['payload'] as const, policy: { snapshot: true } },
          { fields: ['media'] as const, policy: { keys: { width: 'positive', url: 'nonEmpty' } } }
        ]
      }
    });
    rows.insert({
      id: 'temporary-id',
      continuity: 'local continuity',
      local: 'local identity',
      sequence: 9,
      payload: { local: true },
      media: { width: 320, url: 'file:///local.mp4' }
    });
    rows.replace('temporary-id', {
      id: 'server-id',
      continuity: null,
      local: null,
      sequence: 1,
      payload: { server: true },
      media: { width: 0, url: '' }
    });

    expect(rows.find('server-id')).toMatchObject({
      continuity: 'local continuity',
      local: 'local identity',
      sequence: 1,
      payload: { local: true, server: true },
      media: { width: 320, url: 'file:///local.mp4' }
    });
  });

  it('changes a local field only through a local patch after first insert', () => {
    const rows = defineModelRuntime({
      id: 'LocalFieldOwnership',
      name: 'LocalFieldOwnership',
      fields: { localKey: f.str().nullable(), body: f.str() },
      write: { groups: [{ fields: ['localKey'] as const, policy: 'local' }] }
    });
    rows.insert({ id: 'row-1', localKey: 'first', body: 'initial' });
    rows.insert({ id: 'row-1', localKey: 'server', body: 'snapshot' });
    expect(rows.find('row-1')).toMatchObject({ localKey: 'first', body: 'snapshot' });

    rows.update('row-1', { localKey: 'patched' });
    rows.ingest({ updated: { handler: () => ({ upsert: { id: 'row-1', localKey: null, body: 'event' } }) } }).apply('updated', {});

    expect(rows.find('row-1')).toMatchObject({ localKey: 'patched', body: 'event' });
  });

  it('lets a ladder abstain when either nested stage is absent', () => {
    const rows = defineModelRuntime({
      id: 'PolicyLadderAbstain',
      name: 'PolicyLadderAbstain',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: 'c' } });
    rows.insert({ id: 'row-1', blob: {} });
    expect(rows.find('row-1')?.blob).toEqual({});
    rows.insert({ id: 'row-1', blob: { stage: 'a' } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: 'a' });
  });

  it('lets a ladder abstain when the stage is explicitly null, matching the null-as-absent convention', () => {
    const rows = defineModelRuntime({
      id: 'PolicyLadderNullAbstain',
      name: 'PolicyLadderNullAbstain',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { ladder: { path: 'blob.stage', tiers: [['a', 'b'], ['c', 'd', 'e']] } } } }] }
    });
    rows.insert({ id: 'row-1', blob: { stage: null, url: 'file:///local.jpg' } });
    rows.insert({ id: 'row-1', blob: { stage: null, url: 'https://cdn/server.jpg' } });
    expect(rows.find('row-1')?.blob).toEqual({ stage: null, url: 'https://cdn/server.jpg' });
  });

  it('rejects a lower ladder tier and accepts movement within its current tier', () => {
    const rows = defineModelRuntime({
      id: 'PolicyLadderTiers',
      name: 'PolicyLadderTiers',
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
    const rows = defineModelRuntime({
      id: 'PolicyLadderUnknown',
      name: 'PolicyLadderUnknown',
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
    const rows = defineModelRuntime({
      id: 'PolicyLadderTuple',
      name: 'PolicyLadderTuple',
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
    const rows = defineModelRuntime({
      id: 'PolicyAnyAll',
      name: 'PolicyAnyAll',
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
    const rows = defineModelRuntime({
      id: 'PolicyNestedKeys',
      name: 'PolicyNestedKeys',
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
    const rows = defineModelRuntime({
      id: 'PolicyPolicySequence',
      name: 'PolicyPolicySequence',
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
    const newerRows = defineModelRuntime({
      id: 'PolicyPathNewer',
      name: 'PolicyPathNewer',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { newerBy: 'blob.updatedAt' } } }] }
    });
    newerRows.insert({ id: 'row-1', blob: { updatedAt: '2026-01-02T00:00:00Z' } });
    newerRows.insert({ id: 'row-1', blob: { updatedAt: '2026-01-01T00:00:00Z' } });
    expect(newerRows.find('row-1')?.blob).toEqual({ updatedAt: '2026-01-02T00:00:00Z' });

    const tupleRows = defineModelRuntime({
      id: 'PolicyPathTuple',
      name: 'PolicyPathTuple',
      fields: { blob: f.raw<Record<string, unknown>>() },
      write: { groups: [{ fields: ['blob'] as const, policy: { monotonic: { tuple: ['blob.seq'] } } }] }
    });
    tupleRows.insert({ id: 'row-1', blob: { seq: 2 } });
    tupleRows.insert({ id: 'row-1', blob: { seq: 1 } });
    expect(tupleRows.find('row-1')?.blob).toEqual({ seq: 2 });

    const predicateRows = defineModelRuntime({
      id: 'PolicyPathPredicates',
      name: 'PolicyPathPredicates',
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
    const parents = defineModelRuntime({
      id: 'PolicyCounterParent',
      name: 'PolicyCounterParent',
      fields: { childCount: f.num() },
      write: { groups: [{ fields: ['childCount'] as const, policy: { monotonic: { tuple: ['childCount'] }, on: ['patch'] } }] }
    });
    const children = defineModelRuntime({
      id: 'PolicyCounterChild',
      name: 'PolicyCounterChild',
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

describe('policy primitive edges', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
  });

  it('rejects a nonEmpty group when the guarded field is absent from the payload', () => {
    const rows = defineModelRuntime({
      id: 'PolicyNonEmptyAbsent',
      name: 'PolicyNonEmptyAbsent',
      fields: { clientId: f.str(), body: f.str() },
      write: { groups: [{ fields: ['clientId'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', clientId: 'client-1', body: 'first' });
    rows.insert({ id: 'row-1', body: 'second' } as never);

    expect(rows.find('row-1')).toMatchObject({ clientId: 'client-1' });
  });

  it('treats numeric zero as a present nonEmpty value', () => {
    const rows = defineModelRuntime({
      id: 'PolicyNonEmptyZero',
      name: 'PolicyNonEmptyZero',
      fields: { rank: f.num() },
      write: { groups: [{ fields: ['rank'] as const, policy: { monotonic: { nonEmpty: true } } }] }
    });
    rows.insert({ id: 'row-1', rank: 5 });
    rows.insert({ id: 'row-1', rank: 0 });

    expect(rows.find('row-1')).toMatchObject({ rank: 0 });
  });

  it('compares numeric-like tuple parts numerically and falls through equal parts', () => {
    const rows = defineModelRuntime({
      id: 'PolicyTupleNumeric',
      name: 'PolicyTupleNumeric',
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
    const rows = defineModelRuntime({
      id: 'PolicyGroupAtomic',
      name: 'PolicyGroupAtomic',
      fields: { updatedAt: f.str(), body: f.str(), unguarded: f.str() },
      write: { groups: [{ fields: ['updatedAt', 'body'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-02T00:00:00Z', body: 'fresh', unguarded: 'old' });
    rows.insert({ id: 'row-1', updatedAt: '2026-07-01T00:00:00Z', body: 'stale', unguarded: 'new' });

    expect(rows.find('row-1')).toMatchObject({ updatedAt: '2026-07-02T00:00:00Z', body: 'fresh', unguarded: 'new' });
  });
});
