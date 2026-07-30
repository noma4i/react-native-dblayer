import { configureDb, defineModel, f } from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

type ChatRow = { id: string; inboxId: string; premium: boolean; kind: string };
type QueryResponse = { chats: ChatRow[] };

const document = { kind: 'Document', definitions: [] } as never;

const createMemberChats = (suffix: string) =>
  defineModel({
    id: `SpecScopeMember${suffix}`,
    name: `SpecScopeMember${suffix}`,
    fields: { id: f.str(), inboxId: f.str(), premium: f.bool(), kind: f.str() },
    scopes: {
      primary: ({ by: { inboxId: 'inboxId' }, member: row => row.premium && row.kind !== 'system' })
    }
  });

const createQueryChats = () =>
  defineModel({
    id: 'SpecScopeMemberQuery',
    name: 'SpecScopeMemberQuery',
    fields: { id: f.str(), inboxId: f.str(), premium: f.bool(), kind: f.str() },
    scopes: {
      remote: ({ member: () => false })
    }
  });

describe('scope member predicate', () => {
  it('detaches and restores a by-derived member when the predicate changes', () => {
    setupSpecRuntime();
    const chats = createMemberChats('Transitions');
    chats.insert({ id: 'chat-1', inboxId: 'primary', premium: true, kind: 'direct' });
    expect(chats.scopes.primary.read({ inboxId: 'primary' }).map(row => row.id)).toEqual(['chat-1']);

    chats.update('chat-1', { premium: false });
    expect(chats.scopes.primary.read({ inboxId: 'primary' })).toEqual([]);
    chats.update('chat-1', { premium: true });

    expect(chats.scopes.primary.read({ inboxId: 'primary' }).map(row => row.id)).toEqual(['chat-1']);
  });

  it('does not insert a by-derived row that fails member', () => {
    setupSpecRuntime();
    const chats = createMemberChats('Insert');

    chats.insert({ id: 'chat-1', inboxId: 'primary', premium: false, kind: 'direct' });

    expect(chats.scopes.primary.read({ inboxId: 'primary' })).toEqual([]);
  });

  it('ignores member for query-destination scopes without by', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => ({ data: { chats: [{ id: 'chat-1', inboxId: 'primary', premium: false, kind: 'system' }] } as TData })
      })
    });
    const chats = createQueryChats();
    const query = chats.query<QueryResponse, void, Record<string, never>, ChatRow>('remote', {
      document,
      key: 'scope-member-query',
      select: data => data.chats,
      into: chats.scopes.remote
    });

    await query.fetch({});

    expect(chats.scopes.remote.read({}).map(row => row.id)).toEqual(['chat-1']);
  });
});
