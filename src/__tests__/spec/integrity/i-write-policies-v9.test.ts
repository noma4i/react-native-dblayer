import { belongsTo, configureDb, defineModel, f } from '../../../index';
import { isIncomingNewer } from '../../../core/invariants';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

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
      write: { groups: [{ fields: ['media'] as const, policy: { media: { dimensionKeys: ['width', 'height'], sourceKeys: ['fileUrl'], transcodeGuard: { statusField: 'status', progressField: 'progress' } } } }] }
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
          { fields: ['media'] as const, policy: { media: { dimensionKeys: ['width'], sourceKeys: ['url'] } } }
        ]
      }
    });
    rows.insert({ id: 'temporary-id', continuity: 'local', sequence: 9, payload: { local: true }, media: { width: 320, url: 'file:///local.mp4' } });
    rows.replace('temporary-id', { id: 'server-id', continuity: null, sequence: 1, payload: { server: true }, media: { width: 0, url: 'https://cdn/server.mp4' } });

    expect(rows.find('server-id')).toMatchObject({ continuity: null, sequence: 1, payload: { server: true }, media: { width: 0, url: 'https://cdn/server.mp4' } });
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
