import { configureDb, defineFetch } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type FetchInput = { at?: Date; value?: bigint | null | number };
type FetchResponse = { version: number };

const document = { kind: 'Document', definitions: [] } as never;

const createFetch = () => {
  const transport = createMockTransport({
    query: async <TData,>() => ({ data: { version: 1 } as TData })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const fetch = defineFetch<FetchResponse, FetchInput, number>({
    key: 'c18-serialization',
    document,
    vars: input => input,
    select: data => data.version,
    staleTime: Number.MAX_SAFE_INTEGER
  });
  return { fetch, transport };
};

describe('scope-key serialization', () => {
  it('uses distinct fetch cache entries for distinct Date filters', async () => {
    const { fetch, transport } = createFetch();

    await fetch.fetch({ at: new Date('2026-01-01T00:00:00.000Z') });
    await fetch.fetch({ at: new Date('2026-01-02T00:00:00.000Z') });

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(2);
  });

  it('uses distinct fetch cache entries for NaN and null filters', async () => {
    const { fetch, transport } = createFetch();

    await fetch.fetch({ value: Number.NaN });
    await fetch.fetch({ value: null });

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(2);
  });

  it('derives a fetch cache key for a bigint filter without throwing', async () => {
    const { fetch, transport } = createFetch();

    await expect(fetch.fetch({ value: 1n })).resolves.toBe(1);

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(1);
  });
});
