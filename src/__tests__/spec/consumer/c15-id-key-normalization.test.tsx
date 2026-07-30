import { act } from 'react';
import { configureDb, defineModel, f } from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

type MomentRow = { id: string; userId: string; status: string };
type ScopeValue = { userId: string };
type QueryResponse = { moment: { id: string | number; userId: number; status: string } };
type PatchResponse = { updateMoment: MomentRow };
type RespondResponse = { send: MomentRow; sink: { id: number; userId: string; status: string } };

const document = { kind: 'Document', definitions: [] } as never;

const createMoments = () =>
  defineModel({
    id: 'SpecConsumerIdKeyMoment',
    name: 'SpecConsumerIdKeyMoment',
    fields: {
      id: f.str(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: ({ by: { userId: 'userId' } })
    }
  });

describe('id-key normalization contracts (LC20)', () => {
  it('files a numeric-transport userId into the same scope bucket a string read key resolves', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { moment: { id: 'moment-1', userId: 54, status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const query = moments.query<QueryResponse, ScopeValue, ScopeValue, MomentRow>('single-moment', {
      document,
      vars: value => ({ userId: value.userId }),
      select: data => data.moment,
      into: moments.scopes.byUser
    });

    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['moment-1']);

    scopeReader.unmount();
    queryReader.unmount();
  });

  it('matches a stored id-typed field against a numeric where filter', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.where({ userId: 54 as unknown as string }).rows());

    expect(reader.result().map(row => row.id)).toEqual(['moment-1']);
    reader.unmount();
  });

  it('resolves a point read when the id argument arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.find(54 as unknown as string));

    expect(reader.result()?.id).toBe('54');
    reader.unmount();
  });

  it('resolves byIds when an id argument arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds([54 as unknown as string]));

    expect(reader.result().rows.map(row => (row as { id: string }).id)).toEqual(['54']);
    reader.unmount();
  });

  it('keys a present byIds row by its actual id when an earlier requested id is missing', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'present', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds(['missing', 'present']));

    expect(reader.result().rows).toHaveLength(1);
    expect(reader.result().byId.get('present')?.id).toBe('present');
    expect(reader.result().byId.get('missing')).toBeUndefined();
    reader.unmount();
  });

  it('keeps byIds map keys independent of a renderKeys projection that excludes id', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'present', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds(['missing', 'present'], { renderKeys: ['status'] }));

    expect(reader.result().rows).toHaveLength(1);
    expect(reader.result().byId.has('present')).toBe(true);
    expect(reader.result().byId.has('missing')).toBe(false);
    reader.unmount();
  });

  it('accepts a numeric primary id from the transport and reads it by string id', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { moment: { id: 77, userId: 54, status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const query = moments.query<QueryResponse, ScopeValue, ScopeValue, MomentRow>('single-moment', {
      document,
      vars: value => ({ userId: value.userId }),
      select: data => data.moment,
      into: moments.scopes.byUser
    });

    const rowReader = renderCounted(() => moments.use.find('77'));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(rowReader.result()?.id).toBe('77');

    rowReader.unmount();
    queryReader.unmount();
  });

  it('patches a string-keyed row when the write id arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    moments.update(54 as unknown as string, { status: 'patched' });

    expect(moments.find('54')?.status).toBe('patched');
  });

  it('destroys a string-keyed row when the write id arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    moments.destroy(54 as unknown as string);

    expect(moments.find('54')).toBeUndefined();
  });

  it('destroys a string-keyed row for a numeric ingest payload id', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    const ingest = moments.ingest({ removed: { apply: 'destroy' } });
    moments.insert({ id: '54', userId: '54', status: 'active' });

    ingest.apply('removed', { id: 54 });

    expect(moments.find('54')).toBeUndefined();
  });

  it('tracks a numeric-id method patch through the normalized string lookup key', async () => {
    let resolveMutation!: (value: { data: PatchResponse }) => void;
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        await new Promise<{ data: TData }>(resolve => {
          resolveMutation = resolve as unknown as (value: { data: PatchResponse }) => void;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const update = moments.mutation<PatchResponse, { id: string }, MomentRow, MomentRow>('numeric-pending', {
      document,
      result: 'updateMoment',
      dedupe: false,
      optimistic: { method: 'patch', model: moments, selectId: input => input.id, selectPatch: () => ({ status: 'pending' }) }
    });
    moments.insert({ id: '54', userId: '54', status: 'active' });
    const reader = renderCounted(() => moments.use.pending('54'));
    let request!: Promise<PatchResponse['updateMoment'] | null>;

    act(() => {
      request = update.run({ id: 54 as unknown as string });
    });
    const pendingWhileInFlight = reader.result();
    resolveMutation({ data: { updateMoment: { id: '54', userId: '54', status: 'pending' } } });
    await act(async () => {
      await request;
    });

    expect(pendingWhileInFlight).toBe(true);
    expect(reader.result()).toBe(false);
    reader.unmount();
  });

  it('rolls back a numeric-id respond extract sink after transport failure', async () => {
    let rejectMutation!: (error: Error) => void;
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        await new Promise<{ data: TData }>((_resolve, reject) => {
          rejectMutation = reject;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const send = moments.mutation<RespondResponse, void, MomentRow, MomentRow>('numeric-respond-inverse', {
      document,
      result: 'send',
      dedupe: false,
      optimistic: {
        model: moments,
        respond: () => ({ send: { id: '', userId: '54', status: 'sending' }, sink: { id: 54, userId: '54', status: 'sink' } }),
        selectServerNode: data => data.send
      },
      extract: ({ data }) => [{ into: moments, rows: [data.sink] }]
    });
    let request!: ReturnType<typeof send.run>;

    act(() => {
      request = send.run(undefined);
    });
    expect(moments.find('54')).toMatchObject({ id: '54', status: 'sink' });

    rejectMutation(new Error('send failed'));
    await act(async () => {
      await expect(request).rejects.toThrow('send failed');
    });

    expect(moments.find('54')).toBeUndefined();
  });

  it('matches a numeric where filter against the primary id key when id is not a declared field', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const widgets = defineModel({
      id: 'SpecConsumerIdKeyWidget',
      name: 'SpecConsumerIdKeyWidget',
      fields: { label: f.str() }
    });
    widgets.insert({ id: '54', label: 'w' } as never);

    const reader = renderCounted(() => widgets.use.where({ id: 54 as unknown as string }).rows());

    expect(reader.result().map(row => (row as { id: string }).id)).toEqual(['54']);
    reader.unmount();
  });

  it('reads a scope bucket when the scope value arrives numeric (read-write key symmetry)', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.scopes.byUser.use({ userId: 54 as unknown as string }));

    expect(reader.result().map(row => row.id)).toEqual(['moment-1']);
    reader.unmount();
  });
});
