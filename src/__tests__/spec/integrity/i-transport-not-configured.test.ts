import { getDbTransport, setDbTransport } from '../../testApi';

// This file must run before any other spec configures a transport, so it imports core/transport.ts
// directly (no configureDb/harness helpers) to observe the module's pristine never-configured state.

describe('transport not-configured guard', () => {
  it('throws a clear error when query/mutation is called before setDbTransport', () => {
    expect(() => getDbTransport().query({} as never)).toThrow('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
    expect(() => getDbTransport().mutation({} as never)).toThrow('transport not configured');
  });

  it('routes query and mutation to the configured transport after setDbTransport', async () => {
    const seen: unknown[] = [];
    setDbTransport({
      query: async operation => {
        seen.push(['query', operation]);
        return { data: { id: 'row-1' } } as never;
      },
      mutation: async operation => {
        seen.push(['mutation', operation]);
        return { data: { id: 'row-2' } } as never;
      }
    });

    await expect(getDbTransport().query({ variables: { bucket: 'main' } } as never)).resolves.toEqual({ data: { id: 'row-1' } });
    await expect(getDbTransport().mutation({ variables: { body: 'draft' } } as never)).resolves.toEqual({ data: { id: 'row-2' } });
    expect(seen).toEqual([
      ['query', { variables: { bucket: 'main' } }],
      ['mutation', { variables: { body: 'draft' } }]
    ]);
  });
});
