import { getDbTransport, setDbTransport } from '../../../core/transport';

// This file must run before any other spec configures a transport, so it imports core/transport.ts
// directly (no configureDb/harness helpers) to observe the module's pristine never-configured state.

describe('transport not-configured guard', () => {
  it('throws a clear error when query/mutation is called before setDbTransport', () => {
    expect(() => getDbTransport().query({} as never)).toThrow('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
    expect(() => getDbTransport().mutation({} as never)).toThrow('transport not configured');
  });

  it('resolves to the configured transport after setDbTransport', () => {
    const transport = { query: jest.fn(), mutation: jest.fn() };
    setDbTransport(transport);
    expect(getDbTransport()).toBe(transport);
  });
});
