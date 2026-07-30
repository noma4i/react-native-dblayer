import { act } from 'react';
import { configureDb, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

type MomentRow = { id: string; uuid: string; status: string };
type ScopeValue = { uuid: string };
type QueryResponse = { moment: MomentRow };

type CallEntry = { kind: 'query'; operation: { variables: ScopeValue } };

const document = { kind: 'Document', definitions: [] } as never;

const createMoments = () =>
  defineModel({
    id: 'SpecConsumerByUuidMoment',
    name: 'SpecConsumerByUuidMoment',
    fields: {
      id: f.str(),
      uuid: f.str(),
      status: f.str()
    },
    scopes: {
      byUuid: ({ by: { uuid: 'uuid' } })
    }
  });

describe('scope byUuid contracts', () => {
  it('renders one scoped row when a query lands matching by-uuid input', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { moment: { id: 'moment-1', uuid: 'moment-uuid-1', status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const query = moments.query<QueryResponse, ScopeValue, ScopeValue, MomentRow>('single-moment', {
      document,
      vars: value => ({ uuid: value.uuid }),
      select: data => data.moment,
      into: moments.scopes.byUuid
    });

    const scopeReader = renderCounted(() => moments.scopes.byUuid.use({ uuid: 'moment-uuid-1' }));
    const queryReader = renderCountedInProvider(() => query.use({ uuid: 'moment-uuid-1' }));
    const before = scopeReader.renders();

    await settle();

    expect((queryReader.result().data as MomentRow[] | undefined)?.map(row => row.id)).toEqual(['moment-1']);
    expect(scopeReader.result().map(row => row.id)).toEqual(['moment-1']);
    expect(scopeReader.renders() - before).toBe(1);
    expect((transport.calls[0] as CallEntry | undefined)?.kind).toBe('query');

    scopeReader.unmount();
    queryReader.unmount();
  });

  it('keeps byUuid scope isolated from writes to other uuid rows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', uuid: 'moment-uuid-1', status: 'active' });
    moments.insert({ id: 'moment-2', uuid: 'moment-uuid-2', status: 'queued' });

    const scopeReader = renderCounted(() => moments.scopes.byUuid.use({ uuid: 'moment-uuid-1' }));
    const before = scopeReader.renders();

    act(() => {
      moments.insert({ id: 'moment-3', uuid: 'moment-uuid-2', status: 'queued-late' });
      moments.update('moment-2', { status: 'processed' });
    });

    expect(scopeReader.result().map(row => row.id)).toEqual(['moment-1']);
    expect(scopeReader.renders() - before).toBe(0);
    scopeReader.unmount();
  });

  it('rerenders once when a same-uuid row patches and keeps scope membership stable', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', uuid: 'moment-uuid-1', status: 'active' });

    const scopeReader = renderCounted(() => moments.scopes.byUuid.use({ uuid: 'moment-uuid-1' }));
    const before = scopeReader.renders();

    act(() => {
      moments.update('moment-1', { status: 'complete' });
      moments.update('moment-1', { status: 'complete' });
    });

    expect(scopeReader.result().map(row => row.id)).toEqual(['moment-1']);
    expect(scopeReader.result()[0]?.status).toBe('complete');
    expect(scopeReader.renders() - before).toBe(1);
    scopeReader.unmount();
  });
});
