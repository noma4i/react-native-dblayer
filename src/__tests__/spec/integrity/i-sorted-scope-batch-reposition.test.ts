import { configureDb, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('sorted scope batch reposition integrity', () => {
  it('places every changed row against one batch-wide moving set', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const users = defineModel({
      id: 'SortedScopeBatchReposition',
      name: 'SortedScopeBatchReposition',
      fields: {
        bucket: f.str(),
        rank: f.num()
      },
      scopes: {
        byBucket: ({
          by: { bucket: 'bucket' },
          sort: { field: 'rank', dir: 'asc' }
        })
      }
    });
    const bucket = { bucket: 'active' };

    users.scopes.byBucket.seed(bucket, [
      { id: 'anchor-low', bucket: 'active', rank: 0 },
      { id: 'move-last', bucket: 'active', rank: 1 },
      { id: 'move-middle', bucket: 'active', rank: 2 },
      { id: 'anchor-middle', bucket: 'active', rank: 10 }
    ]);

    users.insertMany([
      { id: 'move-last', bucket: 'active', rank: 30 },
      { id: 'move-middle', bucket: 'active', rank: 20 }
    ]);

    expect(users.scopes.byBucket.read(bucket).map(row => row.id)).toEqual([
      'anchor-low',
      'anchor-middle',
      'move-middle',
      'move-last'
    ]);
  });
});
