import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as dbl from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

const DbProvider = (
  dbl as unknown as {
    DbProvider: React.ComponentType<{ children: React.ReactNode; bootOptions?: { wipe?: boolean } }>;
  }
).DbProvider;
const settle = async () => {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
};

describe('ephemeral fetch sufficiency', () => {
  it('fetches without GraphQL, refetches, and removes cached data before the next use', async () => {
    setupSpecRuntime();
    let calls = 0;
    const request = dbl.defineFetch<string, void, string>({
      key: 'spec-ephemeral',
      fetcher: async () => `value-${++calls}`,
      select: (data: string) => data
    } as never) as ReturnType<typeof dbl.defineFetch<string, void, string>> & { remove(): void };
    let result!: ReturnType<typeof request.use>;
    const Reader = () => {
      result = request.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(result.data).toBe('value-1');
    act(() => result.refetch());
    await settle();
    expect(result.data).toBe('value-2');
    act(() => root.unmount());
    act(() => request.remove());

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(result.data).toBe('value-3');
    expect(calls).toBe(3);
    act(() => root.unmount());
  });

  it('rejects a definition with both document and fetcher at define time', () => {
    setupSpecRuntime();

    expect(() =>
      dbl.defineFetch({
        key: 'spec-invalid-fetch',
        document: { kind: 'Document', definitions: [] } as never,
        fetcher: async () => ({ value: 'invalid' }),
        select: (data: { value: string }) => data.value
      } as never)
    ).toThrow('defineFetch requires exactly one of document or fetcher');
  });
});
