import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ScopeRow = { id: string; bucket: string; rank: number };
const createScopeModel = () =>
  defineModel({
    id: 'SpecIntegrityScopeOrderReset',
    name: 'SpecIntegrityScopeOrderReset',
    fields: {
      id: f.str(),
      bucket: f.str(),
      rank: f.num()
    },
    scopes: {
      byBucket: scope<ScopeRow>({
        by: { bucket: 'bucket' },
        sort: { comparator: (left: ScopeRow, right: ScopeRow) => left.rank - right.rank }
      })
    }
  });

describe('scope order cache reset contract', () => {
  it('rebuilds comparator scope membership from fresh rows after resetRuntime', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = createScopeModel();

    act(() => {
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'a-2', bucket: 'shared', rank: 2 },
          { id: 'a-1', bucket: 'shared', rank: 1 }
        ]
      );
    });
    const initialReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));
    expect(initialReader.result().map(row => row.id)).toEqual(['a-1', 'a-2']);
    initialReader.unmount();

    act(() => {
      resetRuntime();
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'b-3', bucket: 'shared', rank: 3 },
          { id: 'b-1', bucket: 'shared', rank: 1 }
        ]
      );
    });
    const freshReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));

    expect(freshReader.result().map(row => row.id)).toEqual(['b-1', 'b-3']);
    freshReader.unmount();
  });
});
