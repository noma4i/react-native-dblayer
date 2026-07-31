import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('model-owned write continuity', () => {
  const createRows = () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    return defineModelRuntime({ id: 'ConsumerWriteMerge', name: 'ConsumerWriteMerge', fields: { body: f.str().nullable(), localUri: f.str().nullable(), count: f.num() }, write: { groups: [{ fields: ['localUri'] as const, policy: 'continuity' }, { fields: ['count'] as const, policy: { monotonic: { tuple: ['count'] } } }] } });
  };

  it('keeps continuity for null server fields', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 1 }); rows.insert({ id: 'row-1', body: 'final', localUri: null, count: 2 }); expect(rows.find('row-1')).toMatchObject({ body: 'final', localUri: 'local://file' }); });
  it('accepts an explicit empty continuity value', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 1 }); rows.insert({ id: 'row-1', body: 'final', localUri: '', count: 2 }); expect(rows.find('row-1')?.localUri).toBe(''); });
  it('merges only declared fields', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 9 }); rows.insert({ id: 'row-1', body: 'final', localUri: 'server://file', count: 5 }); expect(rows.find('row-1')).toMatchObject({ body: 'final', localUri: 'server://file', count: 9 }); });
  it('keeps continuity on replace while monotonic fields use server values', () => { const rows = createRows(); rows.insert({ id: 'row-1', body: 'draft', localUri: 'local://file', count: 9 }); rows.replace('row-1', { id: 'row-2', body: 'final', localUri: null, count: 5 }); expect(rows.find('row-2')).toMatchObject({ localUri: 'local://file', count: 5 }); });
});

describe('model-owned media policy', () => {
  it('preserves optimistic dimensions and sources for event and replace holes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const media = defineModelRuntime({ id: 'ConsumerWriteMedia', name: 'ConsumerWriteMedia', fields: { media: f.raw<Record<string, unknown> | null>() }, write: { groups: [{ fields: ['media'] as const, policy: { keys: { width: 'positive', height: 'positive', url: 'nonEmpty' } } }] } });
    media.insert({ id: 'row-1', media: { width: 320, height: 240, url: 'local://file' } });
    media.ingest({ event: { handler: () => ({ upsert: { id: 'row-1', media: { width: 0, url: '' } } }) } }).apply('event', {});
    expect(media.find('row-1')?.media).toEqual({ width: 320, height: 240, url: 'local://file' });
    media.replace('row-1', { id: 'row-2', media: { width: 0, url: 'https://cdn' } });
    expect(media.find('row-2')?.media).toEqual({ width: 320, height: 240, url: 'https://cdn' });
  });
});
