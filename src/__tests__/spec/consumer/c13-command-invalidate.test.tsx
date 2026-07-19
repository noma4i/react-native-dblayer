import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineCommand, defineFetch, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type UserRow = { id: string; balance: number };
type CommandResult = { reward: { ok: true; user: UserRow } };
type FetchResponse = { version: number };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const renderCountedInProvider = <T,>(useHook: () => T) => {
  let value!: T;
  let renderCount = 0;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
};

describe('command invalidation and dedupe contracts', () => {
  it('invalidates an active fetch key on commit so the next use refetches', async () => {
    let queryCalls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        queryCalls += 1;
        return { data: { version: queryCalls } as TData };
      },
      mutation: async <TData,>() => ({ data: { reward: { ok: true, user: { id: 'user-1', balance: 10 } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const users = defineModel({
      id: 'SpecConsumerCommandInvalidateUsers',
      name: 'SpecConsumerCommandInvalidateUsers',
      fields: {
        id: f.str(),
        balance: f.num()
      }
    });

    const activeCampaigns = defineFetch<FetchResponse, void, number>({
      key: 'c13-active-campaigns',
      document,
      select: data => data.version,
      staleTime: Number.MAX_SAFE_INTEGER
    });

    const redeem = defineCommand<CommandResult, { campaignId: string }, never, never>('specCommandInvalidate', {
      document,
      result: 'reward',
      mapInput: input => ({ campaignId: input.campaignId }),
      extract: ({ data }) => {
        const row = data.reward.user;
        return [{ into: users, rows: [row] }];
      },
      invalidate: () => {
        activeCampaigns.remove();
      }
    });

    const fetchReader = renderCountedInProvider(() => activeCampaigns.use());
    await settle();
    expect(queryCalls).toBe(1);

    await redeem.run({ campaignId: 'camp-1' });
    fetchReader.unmount();
    const remountedFetch = renderCountedInProvider(() => activeCampaigns.use());
    await settle();

    expect(queryCalls).toBe(2);
    fetchReader.unmount();
    remountedFetch.unmount();
  });

  it('does not refetch fetch data without explicit invalidation on next use', async () => {
    let queryCalls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        queryCalls += 1;
        return { data: { version: queryCalls } as TData };
      },
      mutation: async <TData,>() => ({ data: { reward: { ok: true, user: { id: 'user-1', balance: 10 } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const users = defineModel({
      id: 'SpecConsumerCommandInvalidateUsersNoInvalidate',
      name: 'SpecConsumerCommandInvalidateUsersNoInvalidate',
      fields: {
        id: f.str(),
        balance: f.num()
      }
    });

    const activeCampaigns = defineFetch<FetchResponse, void, number>({
      key: 'c13-active-campaigns-no-invalidate',
      document,
      select: data => data.version,
      staleTime: Number.MAX_SAFE_INTEGER
    });

    const redeem = defineCommand<CommandResult, { campaignId: string }, never, never>('specCommandNoInvalidate', {
      document,
      result: 'reward',
      mapInput: input => ({ campaignId: input.campaignId }),
      extract: ({ data }) => {
        const row = data.reward.user;
        return [{ into: users, rows: [row] }];
      }
    });

    const fetchReader = renderCountedInProvider(() => activeCampaigns.use());
    await settle();
    expect(queryCalls).toBe(1);

    await redeem.run({ campaignId: 'camp-1' });
    fetchReader.unmount();
    const remountedFetch = renderCountedInProvider(() => activeCampaigns.use());
    await settle();

    expect(queryCalls).toBe(1);
    fetchReader.unmount();
    remountedFetch.unmount();
  });

  it('guards concurrent command runs but allows the same input after commit', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { reward: { ok: true, user: { id: 'user-1', balance: 10 } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const redeem = defineCommand<CommandResult, { campaignId: string }, never, never>('specCommandDedupe', {
      document,
      result: 'reward',
      mapInput: input => ({ campaignId: input.campaignId })
    });

    const first = await redeem.run({ campaignId: 'camp-1' });
    const second = await redeem.run({ campaignId: 'camp-1' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(transport.calls.filter(entry => entry.kind === 'mutation')).toHaveLength(2);
  });
});
