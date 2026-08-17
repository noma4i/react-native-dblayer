import * as React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { act } from 'react';
import { configureDb, DbProvider, defineModelRuntime, f } from '../../testApi';
import * as fetchReaderRegistry from '../../../core/fetch/fetchReaderRegistry';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Row = { id: string; bucket: string; label: string };
type PageResponse = { page: { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };

const document = { kind: 'Document', definitions: [] } as never;

/**
 * A mounted query reader that renders again without a new landing does no write and no
 * registration: the query record is written once per landing and the reader registers once per
 * key, however many times React renders the component (typing, scrolling, sibling state).
 */
describe('query reader render budget', () => {
  it('[F59] 20 renders of a mounted query reader without a new landing = 0 additional query record writes and 0 additional registrations', async () => {
    const plane = createMemoryPlane();
    const writes: string[] = [];
    const storage = {
      ...plane,
      set: (key: string, value: string | null) => {
        writes.push(key);
        plane.set(key, value);
      }
    };
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({ data: { page: { nodes: [{ id: 'row-1', bucket: 'main', label: 'one' }], pageInfo: { hasNextPage: true, endCursor: 'c-1' } } } }) as TData
    });
    configureDb({ storage, transport });
    const rows = defineModelRuntime({
      id: 'SpecQueryReaderRenderBudget',
      name: 'SpecQueryReaderRenderBudget',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { bucket: { by: { bucket: 'bucket' }, sort: 'server-order' } }
    });
    const query = rows.query<PageResponse, { bucket: string }, { bucket: string }, Row>('bucket', {
      document,
      vars: scope => ({ bucket: scope.bucket }),
      page: data => data.page,
      into: rows.scopes.bucket,
      coverage: 'page'
    });
    const registrations = jest.spyOn(fetchReaderRegistry, 'registerActiveFetchReaders');

    let force!: () => void;
    let result!: ReturnType<typeof query.use>;
    const Reader = () => {
      const [, setRevision] = React.useState(0);
      force = () => setRevision(current => current + 1);
      result = query.use({ bucket: 'main' });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(result.data).toHaveLength(1);

    const queryRecordWrites = (): number => writes.filter(key => key.includes('query')).length;
    const writesAfterLanding = queryRecordWrites();
    const registrationsAfterLanding = registrations.mock.calls.length;
    for (let render = 0; render < 20; render += 1) {
      act(() => {
        force();
      });
    }

    expect(queryRecordWrites() - writesAfterLanding).toBe(0);
    expect(registrations.mock.calls.length - registrationsAfterLanding).toBe(0);
    act(() => root.unmount());
  });
});
