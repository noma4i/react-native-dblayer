import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle, renderCountedInProvider } from '../helpers/harness';

type UserRow = { id: string; balance: number };
type CampaignRow = { id: string; version: number };
type CommandResult = { reward: { ok: true; user: UserRow } };
type ActionInput = { campaignId: string };
type FetchResponse = { version: number };
type QueryVariables = Record<string, never>;

const queryDocument: TypedDocumentNode<FetchResponse, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const actionDocument: TypedDocumentNode<CommandResult, ActionInput> = { kind: Kind.DOCUMENT, definitions: [] };
const UserSchema = defineShape<UserRow>()({ balance: f.num() });
const CampaignSchema = defineShape<CampaignRow>()({ version: f.num() });

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

    const Campaign = defineModel('SpecConsumerCommandInvalidateCampaigns', {
      schema: CampaignSchema,
      relations: owner => ({
        active: {
          remote: owner.gql.single(queryDocument, {
            variables: () => ({}),
            select: data => ({ id: 'active-campaigns', version: data.version }),
            staleTime: Number.MAX_SAFE_INTEGER
          })
        }
      })
    });
    const activeCampaigns = Campaign.active({});
    const users = defineModel('SpecConsumerCommandInvalidateUsers', {
      schema: UserSchema,
      actions: owner => ({
        redeem: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'reward',
          variables: (input: ActionInput) => input,
          dedupe: false,
          root: { insert: { select: ({ data }) => data.reward.user } },
          write: (_context, plan) => plan.invalidate(activeCampaigns)
        })
      })
    });

    const fetchReader = renderCountedInProvider(() => activeCampaigns.use());
    await settle();
    expect(queryCalls).toBe(1);

    await users.actions.redeem.run({ campaignId: 'camp-1' });
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

    const Campaign = defineModel('SpecConsumerCommandInvalidateCampaignsNoInvalidate', {
      schema: CampaignSchema,
      relations: owner => ({
        active: {
          remote: owner.gql.single(queryDocument, {
            variables: () => ({}),
            select: data => ({ id: 'active-campaigns-no-invalidate', version: data.version }),
            staleTime: Number.MAX_SAFE_INTEGER
          })
        }
      })
    });
    const activeCampaigns = Campaign.active({});
    const users = defineModel('SpecConsumerCommandInvalidateUsersNoInvalidate', {
      schema: UserSchema,
      actions: owner => ({
        redeem: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'reward',
          variables: (input: ActionInput) => input,
          dedupe: false,
          root: { insert: { select: ({ data }) => data.reward.user } }
        })
      })
    });

    const fetchReader = renderCountedInProvider(() => activeCampaigns.use());
    await settle();
    expect(queryCalls).toBe(1);

    await users.actions.redeem.run({ campaignId: 'camp-1' });
    fetchReader.unmount();
    const remountedFetch = renderCountedInProvider(() => activeCampaigns.use());
    await settle();

    expect(queryCalls).toBe(1);
    fetchReader.unmount();
    remountedFetch.unmount();
  });

  it('guards concurrent command runs but allows the same input after commit', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let served = 0;
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        served += 1;
        if (served === 1) await gate;
        return { data: { reward: { ok: true, user: { id: 'user-1', balance: served * 10 } } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const users = defineModel('SpecConsumerCommandDedupeUsers', {
      schema: UserSchema,
      actions: owner => ({
        redeem: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'reward',
          variables: (input: ActionInput) => input,
          dedupe: { key: input => input.campaignId },
          root: { insert: { select: ({ data }) => data.reward.user } }
        })
      })
    });

    // While the first run is in flight, a same-key run is guarded: it returns null and never
    // reaches the transport.
    const firstPromise = users.actions.redeem.run({ campaignId: 'camp-1' });
    const guarded = await users.actions.redeem.run({ campaignId: 'camp-1' });
    expect(guarded).toBeNull();
    expect(transport.calls.filter(entry => entry.kind === 'mutation')).toHaveLength(1);

    release();
    await expect(firstPromise).resolves.toEqual({ ok: true, user: { id: 'user-1', balance: 10 } });
    expect(users.find('user-1')).toEqual({ id: 'user-1', balance: 10 });

    // After commit the same input runs again and lands the fresh server value.
    await expect(users.actions.redeem.run({ campaignId: 'camp-1' })).resolves.toEqual({ ok: true, user: { id: 'user-1', balance: 20 } });
    expect(users.find('user-1')).toEqual({ id: 'user-1', balance: 20 });
    const mutations = transport.calls.filter(entry => entry.kind === 'mutation');
    expect(mutations).toHaveLength(2);
    expect(mutations.map(entry => (entry.operation as { variables: unknown }).variables)).toEqual([{ campaignId: 'camp-1' }, { campaignId: 'camp-1' }]);
  });
});
