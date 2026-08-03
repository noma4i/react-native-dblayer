import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type UserRow = { id: string; fullName: string };
type MessageRow = { id: string; chatId: string; body: string };
type WalletTransactionRow = { id: string; amount: number };
type CurrentUserRow = { id: string; balance: number };
type GiftInput = { userId: string; giftId: string };
type GiftData = {
  giftSend: {
    user: UserRow;
    message: MessageRow;
    wallet: { balance: number };
    transaction: WalletTransactionRow;
  };
};
type GiftVariables = { input: GiftInput };

const document: TypedDocumentNode<GiftData, GiftVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const UserSchema = defineShape<UserRow>()({ fullName: f.str() });
const MessageSchema = defineShape<MessageRow>()({ chatId: f.str(), body: f.str() });
const CurrentUserSchema = defineShape<CurrentUserRow>()({ balance: f.num() });
const WalletTransactionSchema = defineShape<WalletTransactionRow>()({ amount: f.num() });

const createModels = (suffix: string) => {
  const users = defineModel(`SpecConsumerCmdUsers${suffix}`, { schema: UserSchema });
  const messages = defineModel(`SpecConsumerCmdMessages${suffix}`, { schema: MessageSchema });
  const walletTransactions = defineModel(`SpecConsumerCmdWallet${suffix}`, { schema: WalletTransactionSchema });
  const currentUser = defineModel(`SpecConsumerCmdCurrentUser${suffix}`, {
    schema: CurrentUserSchema,
    actions: owner => ({
      sendGift: owner.gql.action(document, {
        mode: 'request',
        result: 'giftSend',
        variables: (input: GiftInput) => ({ input }),
        dedupe: false,
        root: {
          update: {
            select: ({ data }) => ({ id: 'me', patch: { balance: data.giftSend.wallet.balance } })
          }
        },
        write: ({ data }, plan) => {
          plan.upsert(users, data.giftSend.user);
          plan.upsert(messages, data.giftSend.message);
          plan.upsert(walletTransactions, data.giftSend.transaction);
        }
      })
    })
  });
  return { users, messages, currentUser, walletTransactions };
};

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
    currentUser.insert({ id: 'me', balance: 100 });
    const unrelated = defineModel('SpecConsumerCmdUnrelated', { schema: defineShape<{ id: string; value: string }>()({ value: f.str() }) });
    unrelated.insert({ id: 'x', value: 'before' });

    const userReader = renderCounted(() => users.useFind('user-1'));
    const messageReader = renderCounted(() => messages.useFind('msg-1'));
    const currentUserReader = renderCounted(() => currentUser.useFind('me'));
    const walletReader = renderCounted(() => walletTransactions.useFind('tx-1'));
    const unrelatedReader = renderCounted(() => unrelated.useFind('x'));
    const before = {
      user: userReader.renders(),
      message: messageReader.renders(),
      currentUser: currentUserReader.renders(),
      wallet: walletReader.renders(),
      unrelated: unrelatedReader.renders()
    };

    await act(async () => {
      await currentUser.actions.sendGift.run({ userId: 'user-1', giftId: 'gift-1' });
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
    currentUser.insert({ id: 'me', balance: 100 });

    await expect(currentUser.actions.sendGift.run({ userId: 'user-1', giftId: 'gift-1' })).rejects.toThrow('network down');

    expect(users.where({}).read()).toEqual([]);
    expect(messages.where({}).read()).toEqual([]);
    expect(walletTransactions.where({}).read()).toEqual([]);
    expect(currentUser.find('me')?.balance).toBe(100);
  });
});
