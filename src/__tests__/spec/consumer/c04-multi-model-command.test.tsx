import { act } from 'react-test-renderer';
import { configureDb, defineCommand, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

// Mirrors yupi_v2 src/db/mutations/walletMutations.ts sendGift: one model-less defineCommand whose
// `extract` sinks fan a single response out into 4 independent models in ONE apply transaction.

type UserRow = { id: string; fullName: string };
type MessageRow = { id: string; chatId: string; body: string };
type WalletTransactionRow = { id: string; amount: number };

const document = { kind: 'Document', definitions: [] } as never;

const createModels = (suffix: string) => ({
  users: defineModel({ id: `SpecConsumerCmdUsers${suffix}`, name: `SpecConsumerCmdUsers${suffix}`, fields: { id: f.str(), fullName: f.str() } }),
  messages: defineModel({ id: `SpecConsumerCmdMessages${suffix}`, name: `SpecConsumerCmdMessages${suffix}`, fields: { id: f.str(), chatId: f.str(), body: f.str() } }),
  currentUser: defineModel({ id: `SpecConsumerCmdCurrentUser${suffix}`, name: `SpecConsumerCmdCurrentUser${suffix}`, fields: { id: f.str(), balance: f.num() } }),
  walletTransactions: defineModel({ id: `SpecConsumerCmdWallet${suffix}`, name: `SpecConsumerCmdWallet${suffix}`, fields: { id: f.str(), amount: f.num() } })
});

describe('multi-model command consumer contracts', () => {
  it('writes User + Message + CurrentUser(balance) + WalletTransaction in one commit: each model reader renders once, unrelated readers zero', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        ({
          data: {
            giftSend: {
              user: { id: 'user-1', fullName: 'Ada' } satisfies UserRow,
              message: { id: 'msg-1', chatId: 'chat-1', body: 'sent a gift' } satisfies MessageRow,
              wallet: { balance: 90 },
              transaction: { id: 'tx-1', amount: -10 } satisfies WalletTransactionRow
            }
          }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const { users, messages, currentUser, walletTransactions } = createModels('Commit');
    currentUser.insertStored({ id: 'me', balance: 100 });
    const unrelated = defineModel({ id: 'SpecConsumerCmdUnrelated', name: 'SpecConsumerCmdUnrelated', fields: { id: f.str(), value: f.str() } });
    unrelated.insertStored({ id: 'x', value: 'before' });

    const sendGift = defineCommand<
      { giftSend: { user: UserRow; message: MessageRow; wallet: { balance: number }; transaction: WalletTransactionRow } },
      { userId: string; giftId: string },
      never,
      never
    >('sendGift', {
      document,
      result: 'giftSend',
      dedupe: false,
      extract: ({ data }) => [
        { into: users, rows: [data.giftSend.user] },
        { into: messages, rows: [data.giftSend.message] },
        { into: currentUser, rows: [{ id: 'me', balance: data.giftSend.wallet.balance }] },
        { into: walletTransactions, rows: [data.giftSend.transaction] }
      ]
    });

    const userReader = renderCounted(() => users.use.row('user-1'));
    const messageReader = renderCounted(() => messages.use.row('msg-1'));
    const currentUserReader = renderCounted(() => currentUser.use.row('me'));
    const walletReader = renderCounted(() => walletTransactions.use.row('tx-1'));
    const unrelatedReader = renderCounted(() => unrelated.use.row('x'));
    const before = {
      user: userReader.renders(),
      message: messageReader.renders(),
      currentUser: currentUserReader.renders(),
      wallet: walletReader.renders(),
      unrelated: unrelatedReader.renders()
    };

    await act(async () => {
      await sendGift.run({ userId: 'user-1', giftId: 'gift-1' });
    });

    expect(userReader.renders() - before.user).toBe(1);
    expect(messageReader.renders() - before.message).toBe(1);
    expect(currentUserReader.renders() - before.currentUser).toBe(1);
    expect(walletReader.renders() - before.wallet).toBe(1);
    expect(unrelatedReader.renders() - before.unrelated).toBe(0);

    expect(userReader.result()?.fullName).toBe('Ada');
    expect(messageReader.result()?.body).toBe('sent a gift');
    expect(currentUserReader.result()?.balance).toBe(90);
    expect(walletReader.result()?.amount).toBe(-10);

    userReader.unmount();
    messageReader.unmount();
    currentUserReader.unmount();
    walletReader.unmount();
    unrelatedReader.unmount();
  });

  it('leaves no partial writes when the command errors: all four models stay untouched', async () => {
    const transport = createMockTransport({
      mutation: async () => {
        throw new Error('network down');
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const { users, messages, currentUser, walletTransactions } = createModels('Error');
    currentUser.insertStored({ id: 'me', balance: 100 });

    const sendGift = defineCommand<
      { giftSend: { user: UserRow; message: MessageRow; wallet: { balance: number }; transaction: WalletTransactionRow } },
      { userId: string; giftId: string },
      never,
      never
    >('sendGift', {
      document,
      result: 'giftSend',
      dedupe: false,
      extract: ({ data }) => [
        { into: users, rows: [data.giftSend.user] },
        { into: messages, rows: [data.giftSend.message] },
        { into: currentUser, rows: [{ id: 'me', balance: data.giftSend.wallet.balance }] },
        { into: walletTransactions, rows: [data.giftSend.transaction] }
      ]
    });

    await expect(sendGift.run({ userId: 'user-1', giftId: 'gift-1' })).rejects.toThrow('network down');

    expect(users.getAll()).toEqual([]);
    expect(messages.getAll()).toEqual([]);
    expect(walletTransactions.getAll()).toEqual([]);
    expect(currentUser.get('me')?.balance).toBe(100);
  });
});
