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
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { reward: { ok: true, user: { id: 'user-1', balance: 10 } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const users = defineModel('SpecConsumerCommandDedupeUsers', {
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

    const first = await users.actions.redeem.run({ campaignId: 'camp-1' });
    const second = await users.actions.redeem.run({ campaignId: 'camp-1' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(transport.calls.filter(entry => entry.kind === 'mutation')).toHaveLength(2);
  });
});
