import { mergeOptimisticMedia, mergeOptimisticSnapshot } from '../../../index';

// Named behavioral contracts for the optimistic snapshot/media merge utilities.

describe('mergeOptimisticSnapshot', () => {
  it('returns the other side unchanged when one side is nullish', () => {
    const optimistic = { id: 't-1', body: 'draft' };
    const server = { id: 's-1', body: 'final' };
    expect(mergeOptimisticSnapshot(null, server)).toBe(server);
    expect(mergeOptimisticSnapshot(optimistic, undefined)).toBe(optimistic);
  });

  it('lets server values win except nullish and empty-string placeholders', () => {
    const merged = mergeOptimisticSnapshot(
      { id: 't-1', body: 'draft', mediaUrl: 'local://file', status: 'sending' },
      { id: 's-1', body: 'final', mediaUrl: '', status: null }
    );
    expect(merged).toEqual({ id: 's-1', body: 'final', mediaUrl: 'local://file', status: 'sending' });
  });

  it('with a fields allowlist starts from the server object and merges only listed fields', () => {
    const merged = mergeOptimisticSnapshot(
      { id: 't-1', body: 'draft', note: 'optimistic-only' },
      { id: 's-1', body: '' },
      { fields: ['body'] }
    );
    expect(merged).toEqual({ id: 's-1', body: 'draft' });
  });

  it('applies custom field mergers over the default resolution', () => {
    const merged = mergeOptimisticSnapshot(
      { id: 't-1', count: 9 },
      { id: 's-1', count: 5 },
      { mergers: { count: optimisticValue => optimisticValue } }
    );
    expect(merged).toEqual({ id: 's-1', count: 9 });
  });
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
