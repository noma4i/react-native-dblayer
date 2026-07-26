import { configureDb, defineModel, f, mergeOptimisticMedia } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('model-owned write continuity', () => {
  const createRows = () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    return defineModel({ id: 'ConsumerWriteMerge', name: 'ConsumerWriteMerge', fields: { body: f.str().nullable(), localUri: f.str().nullable(), count: f.num() }, write: { groups: [{ fields: ['localUri'] as const, policy: 'continuity' }, { fields: ['count'] as const, policy: { merge: current => current } }] } });
  };

  it('keeps continuity for null server fields', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 1 }); rows.insert({ id: 'row-1', body: 'final', localUri: null, count: 2 }); expect(rows.find('row-1')).toMatchObject({ body: 'final', localUri: 'local://file' }); });
  it('accepts an explicit empty continuity value', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 1 }); rows.insert({ id: 'row-1', body: 'final', localUri: '', count: 2 }); expect(rows.find('row-1')?.localUri).toBe(''); });
  it('merges only declared fields', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 9 }); rows.insert({ id: 'row-1', body: 'final', localUri: 'server://file', count: 5 }); expect(rows.find('row-1')).toMatchObject({ body: 'final', localUri: 'server://file', count: 9 }); });
  it('uses model policy for every replacement write', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 9 }); rows.replace('row-1', { id: 'row-2', body: 'final', localUri: null, count: 5 }); expect(rows.find('row-2')).toMatchObject({ localUri: 'local://file', count: 9 }); });
});

describe('mergeOptimisticMedia', () => {
  it('returns non-object server values as-is', () => {
    expect(mergeOptimisticMedia({ width: 100 }, null)).toBeNull();
    expect(mergeOptimisticMedia({ width: 100 }, undefined)).toBeUndefined();
  });

  it('keeps positive optimistic dimensions when server dimensions are missing or zero', () => {
    expect(mergeOptimisticMedia({ width: 320, height: 240 }, { width: 0, url: 'srv' })).toEqual({ width: 320, height: 240, url: 'srv' });
  });

  it('lets real server dimensions win', () => {
    expect(mergeOptimisticMedia({ width: 320, height: 240 }, { width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });

  it('prefers non-empty server source keys and falls back to optimistic non-empty strings', () => {
    expect(mergeOptimisticMedia({ url: 'local://file' }, { url: '' }, { sourceKeys: ['url'] })).toEqual({ url: 'local://file' });
    expect(mergeOptimisticMedia({ url: 'local://file' }, { url: 'https://cdn' }, { sourceKeys: ['url'] })).toEqual({ url: 'https://cdn' });
  });
});
