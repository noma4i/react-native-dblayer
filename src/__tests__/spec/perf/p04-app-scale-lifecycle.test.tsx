import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import { AppState } from 'react-native';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, createSingletonStatics, defineModel, defineModelRuntime, defineShape, f , DB_FORMAT_VERSION, computeSchemaFingerprints, writePersistenceManifest } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle, diagnostics } from '../helpers/harness';

type ChatRow = { id: string; status: string; kind: string; lastActivityAt: string; memberIds: string[] };
type MessageRow = { id: string; chatId: string; sequenceNumber: number; body: string };
type CountersRow = { id: string; totalUnread: number };
type DigestData = { value: number };
type DigestVariables = { value: number };
type DigestRow = { id: string; value: number };

const CHAT_DOCUMENT = { kind: 'Document', definitions: [] } as never;
const MESSAGE_DOCUMENT = { kind: 'Document', definitions: [] } as never;
const DIGEST_DOCUMENT: TypedDocumentNode<DigestData, DigestVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const DigestSchema = defineShape<DigestRow>()({ value: f.num() });

const CHAT_STATUSES = ['open', 'archived', 'pending'] as const;
const CHATS_PER_STATUS = 100;
const THREAD_IDS = Array.from({ length: 20 }, (_, index) => `thread-${index}`);
const MOUNTED_THREAD_IDS = THREAD_IDS.slice(0, 9);
const MESSAGES_PER_THREAD = 25;
const USER_COUNT = 300;

const createChatsModel = () =>
  defineModelRuntime({
    id: 'SpecAppScaleChats',
    name: 'SpecAppScaleChats',
    fields: { status: f.str(), kind: f.str(), lastActivityAt: f.str(), memberIds: f.array(f.str()) },
    scopes: {
      active: ({ by: { status: 'status' }, member: row => row.kind !== 'system', sort: { field: 'lastActivityAt', dir: 'desc' } })
    }
  });

const createMessagesModel = () =>
  defineModelRuntime({
    id: 'SpecAppScaleMessages',
    name: 'SpecAppScaleMessages',
    fields: { chatId: f.str(), sequenceNumber: f.num(), body: f.str() },
    scopes: {
      thread: ({ by: { chatId: 'chatId' }, sort: { comparator: (left, right) => left.sequenceNumber - right.sequenceNumber } })
    }
  });

const createUsersModel = () =>
  defineModelRuntime({
    id: 'SpecAppScaleUsers',
    name: 'SpecAppScaleUsers',
    fields: { name: f.str() }
  });

const createCountersModel = () =>
  defineModelRuntime({
    id: 'SpecAppScaleCounters',
    name: 'SpecAppScaleCounters',
    fields: { totalUnread: f.num() },
    statics: model => createSingletonStatics<CountersRow>(model, 'counters', { id: 'counters', totalUnread: 0 })
  });

const seedChats = (chats: ReturnType<typeof createChatsModel>): void => {
  const rows: ChatRow[] = [];
  for (const status of CHAT_STATUSES) {
    for (let index = 0; index < CHATS_PER_STATUS; index += 1) {
      const globalIndex = rows.length;
      rows.push({
        id: `chat-${status}-${index}`,
        status,
        kind: index % 10 === 0 ? 'system' : 'normal',
        lastActivityAt: new Date(2026, 0, 1, 0, 0, globalIndex).toISOString(),
        memberIds: [`user-${globalIndex % USER_COUNT}`]
      });
    }
  }
  chats.insertMany(rows);
};

const seedMessages = (messages: ReturnType<typeof createMessagesModel>): void => {
  const rows: MessageRow[] = [];
  for (const chatId of THREAD_IDS) {
    for (let sequenceNumber = 0; sequenceNumber < MESSAGES_PER_THREAD; sequenceNumber += 1) {
      rows.push({ id: `${chatId}-msg-${sequenceNumber}`, chatId, sequenceNumber, body: `body-${sequenceNumber}` });
    }
  }
  messages.insertMany(rows);
};

const seedUsers = (users: ReturnType<typeof createUsersModel>): void => {
  users.insertMany(Array.from({ length: USER_COUNT }, (_, index) => ({ id: `user-${index}`, name: `User ${index}` })));
};

type EnsembleModels = {
  chats: ReturnType<typeof createChatsModel>;
  messages: ReturnType<typeof createMessagesModel>;
  users: ReturnType<typeof createUsersModel>;
  counters: ReturnType<typeof createCountersModel>;
};

const createModels = (): EnsembleModels => {
  const chats = createChatsModel();
  const messages = createMessagesModel();
  const users = createUsersModel();
  const counters = createCountersModel();
  writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
  seedChats(chats);
  seedMessages(messages);
  seedUsers(users);
  return { chats, messages, users, counters };
};

/** Configures the runtime with a transport that resolves immediately unless `resuming.current` is set, in
 * which case a resume-triggered refetch parks on a deferred promise pushed to `releaseQueue` for manual,
 * chunk-by-chunk release. Must run before any model is seeded. */
const setupEnsembleTransport = (resuming: { current: boolean }, releaseQueue: Array<() => void>, chunkSize = 4) => {
  const transport = createMockTransport({
    query: async <TData, TVariables = Record<string, unknown>>(operation: { query: unknown; variables?: TVariables }) => {
      const variables = operation.variables as unknown as { value: number; status?: string; chatId?: string } | undefined;
      if (operation.query === DIGEST_DOCUMENT) return { data: { value: variables!.value } as TData };
      const result =
        operation.query === CHAT_DOCUMENT
          ? { rows: [{ id: `${variables!.status}-refresh`, status: variables!.status, kind: 'normal', lastActivityAt: new Date().toISOString(), memberIds: [] }] }
          : { rows: [{ id: `${variables!.chatId}-refresh`, chatId: variables!.chatId, sequenceNumber: 999, body: 'refresh' }] };
      if (resuming.current) {
        return new Promise<{ data: TData }>(resolve => releaseQueue.push(() => resolve({ data: result as TData })));
      }
      return { data: result as TData };
    }
  });
  configureDb({ storage: createMemoryPlane(), transport, defaults: { resumeStaleTime: 1000, resumeRefetch: { chunkSize } } });
  return transport;
};

type MountedQuery = { key: string; unmount: () => void };

/** Mounts the "app in miniature" ensemble: 12 defineQuery reads, 2 model relation reads, 6 renderKeys scope reads,
 * 2 view reads with includes, and 1 counters-singleton reader, all live at once. `inactiveCount` unmounts
 * that many of the 12 query readers right after first render, leaving their cache entries but no observer. */
const mountEnsemble = (models: EnsembleModels, options?: { inactiveCount?: number }) => {
  const { chats, messages, users, counters } = models;

  const chatQueries = CHAT_STATUSES.map(status =>
    chats.query<{ rows: ChatRow[] }, { status: string }, { status: string }, ChatRow>(`active-${status}`, {
      document: CHAT_DOCUMENT,
      vars: scopeValue => ({ status: scopeValue.status }),
      select: data => data.rows,
      into: chats.scopes.active,
      staleTime: Infinity
    })
  );
  const messageQueries = MOUNTED_THREAD_IDS.map(chatId =>
    messages.query<{ rows: MessageRow[] }, { chatId: string }, { chatId: string }, MessageRow>(`thread-${chatId}`, {
      document: MESSAGE_DOCUMENT,
      vars: scopeValue => ({ chatId: scopeValue.chatId }),
      select: data => data.rows,
      into: messages.scopes.thread,
      staleTime: Infinity
    })
  );

  const Digest = defineModel('SpecAppScaleDigest', {
    schema: DigestSchema,
    relations: owner => ({
      byValue: {
        remote: owner.gql.single(DIGEST_DOCUMENT, {
          variables: (params: DigestVariables) => params,
          select: data => ({ id: 'digest-' + data.value, value: data.value }),
          staleTime: Infinity
        })
      }
    })
  });
  const digestA = Digest.byValue({ value: 1 });
  const digestB = Digest.byValue({ value: 2 });


  const renders: Record<string, number> = {};
  const bump = (key: string): void => {
    renders[key] = (renders[key] ?? 0) + 1;
  };

  const chatQueryScopes: Array<{ status: string }> = CHAT_STATUSES.map(status => ({ status }));
  const messageQueryScopes: Array<{ chatId: string }> = MOUNTED_THREAD_IDS.map(chatId => ({ chatId }));

  const ChatQueryReader = ({ index }: { index: number }) => {
    chatQueries[index]!.use(chatQueryScopes[index]!);
    bump(`chatQuery-${index}`);
    return null;
  };
  const MessageQueryReader = ({ index }: { index: number }) => {
    messageQueries[index]!.use(messageQueryScopes[index]!);
    bump(`messageQuery-${index}`);
    return null;
  };
  const DigestAReader = () => {
    digestA.use();
    bump('digestA');
    return null;
  };
  const DigestBReader = () => {
    digestB.use();
    bump('digestB');
    return null;
  };
  const ChatScopeReader = ({ status }: { status: string }) => {
    chats.scopes.active.use({ status }, { renderKeys: ['id'] });
    bump(`chatScope-${status}`);
    return null;
  };
  const MessageScopeReader = ({ chatId }: { chatId: string }) => {
    messages.scopes.thread.use({ chatId }, { renderKeys: ['id'] });
    bump(`messageScope-${chatId}`);
    return null;
  };
  const ViewReader = ({ status }: { status: string }) => {
    const rows = chats.scopes.active.use({ status }, { renderKeys: ['id', 'memberIds'] });
    users.use.byIds(rows.flatMap(chat => chat.memberIds), { renderKeys: ['id', 'name'] });
    bump(`view-${status}`);
    return null;
  };
  const CountersReader = () => {
    counters.useCurrent();
    bump('counters');
    return null;
  };

  const inactiveCount = options?.inactiveCount ?? 0;
  const excludedChatQueryIndices = new Set(Array.from({ length: inactiveCount }, (_, index) => chatQueries.length - 1 - index));

  const Ensemble = () => (
    <>
      {chatQueries.map((_, index) =>
        excludedChatQueryIndices.has(index) ? null : (
          <ChatQueryReader
            key={`chat-query-${index}`}
            index={index}
          />
        )
      )}
      {messageQueries.map((_, index) => (
        <MessageQueryReader
          key={`message-query-${index}`}
          index={index}
        />
      ))}
      <DigestAReader />
      <DigestBReader />
      <ChatScopeReader status="open" />
      <ChatScopeReader status="archived" />
      <ChatScopeReader status="pending" />
      <MessageScopeReader chatId={MOUNTED_THREAD_IDS[0]!} />
      <MessageScopeReader chatId={MOUNTED_THREAD_IDS[1]!} />
      <MessageScopeReader chatId={MOUNTED_THREAD_IDS[2]!} />
      <ViewReader status="open" />
      <ViewReader status="archived" />
      <CountersReader />
    </>
  );

  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Ensemble)));
  });

  const inactiveMounted: MountedQuery[] = [];
  for (const index of excludedChatQueryIndices) {
    // Mounted standalone (outside the persistent Ensemble, which excludes this index) so it is the ONLY
    // observer of its query; unmounting it leaves a cache entry with zero observers.
    const key = `standalone-inactive-${index}`;
    let standaloneRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      standaloneRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(ChatQueryReader, { index })));
    });
    inactiveMounted.push({ key, unmount: () => act(() => standaloneRoot.unmount()) });
  }

  return { root, renders, chatQueries, messageQueries, digestA, digestB, inactiveMounted, chatQueryScopes, messageQueryScopes };
};

describe('app-scale lifecycle', () => {
  let appStateHandler: ((state: string) => void) | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    }) as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('drains one resume in chunks, refetching every active query exactly once and landing its rows', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    const transport = setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root } = mountEnsemble(models);
    try {
      await settle();
      diagnostics().reset();

      const callsBeforeResume = transport.calls.length;
      resuming.current = true;
      act(() => {
        jest.advanceTimersByTime(1001);
        appStateHandler?.('background');
        appStateHandler?.('active');
      });
      await settle(2);

      const callsAfterFirstTick = transport.calls.length - callsBeforeResume;
      // resumeRefetch.chunkSize is 4, so the first drain starts exactly four deferred transport calls.
      expect(callsAfterFirstTick).toBe(4);

      while (releaseQueue.length > 0) {
        act(() => {
          releaseQueue.splice(0).forEach(release => release());
        });
        await settle(2);
      }
      resuming.current = false;

      // Every active query was refetched exactly once during the drain.
      const keyOf = (variables: { status?: string; chatId?: string; value?: number }): string =>
        variables.status !== undefined ? `chat:${variables.status}` : variables.chatId !== undefined ? `thread:${variables.chatId}` : `digest:${variables.value}`;
      const resumeKeys = transport.calls
        .slice(callsBeforeResume)
        .map(call => keyOf((call.operation as { variables: { status?: string; chatId?: string; value?: number } }).variables))
        .sort();
      const expectedKeys = [
        ...CHAT_STATUSES.map(status => `chat:${status}`),
        ...MOUNTED_THREAD_IDS.map(chatId => `thread:${chatId}`),
        'digest:1',
        'digest:2'
      ].sort();
      expect(resumeKeys).toEqual(expectedKeys);

      // The refetched rows landed and are readable through the models.
      expect(models.chats.find('open-refresh')).toMatchObject({ id: 'open-refresh', status: 'open', kind: 'normal' });
      expect(models.messages.find('thread-0-refresh')).toMatchObject({ id: 'thread-0-refresh', chatId: 'thread-0', sequenceNumber: 999, body: 'refresh' });

      // One resume produces one drain: nothing keeps refetching after the queue is empty.
      const callsAfterDrain = transport.calls.length;
      await settle(2);
      expect(transport.calls.length).toBe(callsAfterDrain);
      expect(diagnostics().snapshot().resumeDrains).toBe(1);
    } finally {
      resuming.current = false;
      act(() => root.unmount());
    }
  });

  it('does not refetch inactive (unmounted) queries on resume', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    const transport = setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root, inactiveMounted } = mountEnsemble(models, { inactiveCount: 1 });
    try {
      await settle();
      inactiveMounted.forEach(entry => entry.unmount());
      await settle();
      diagnostics().reset();

      const callsBeforeResume = transport.calls.length;
      resuming.current = true;
      act(() => {
        jest.advanceTimersByTime(1001);
        appStateHandler?.('background');
        appStateHandler?.('active');
      });
      await settle(2);

      while (releaseQueue.length > 0) {
        act(() => {
          releaseQueue.splice(0).forEach(release => release());
        });
        await settle(2);
      }
      resuming.current = false;

      // 14 active relation readers total; the unmounted query reader has zero observers, so exactly 13 transport refetch calls remain eligible.
      const activeRefetchCalls = transport.calls.length - callsBeforeResume;
      expect(activeRefetchCalls).toBe(13);
      expect(diagnostics().snapshot().resumeDrains).toBe(1);
    } finally {
      resuming.current = false;
      act(() => root.unmount());
    }
  });

  it('stops draining further chunks once the provider unmounts mid-drain', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    const transport = setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root } = mountEnsemble(models);
    try {
      await settle();
      diagnostics().reset();

      const callsBeforeResume = transport.calls.length;
      resuming.current = true;
      act(() => {
        jest.advanceTimersByTime(1001);
        appStateHandler?.('background');
        appStateHandler?.('active');
      });
      await settle(2);

      // chunkSize is 4, so only the first chunk's deferred calls are in flight when the provider unmounts.
      expect(transport.calls.length - callsBeforeResume).toBe(4);
      act(() => root.unmount());

      act(() => {
        releaseQueue.splice(0).forEach(release => release());
      });
      await settle(2);
      resuming.current = false;

      // A second chunk of 4 more calls would fire here if the drain loop kept running past unmount.
      expect(transport.calls.length - callsBeforeResume).toBe(4);
    } finally {
      resuming.current = false;
      if (releaseQueue.length > 0) act(() => releaseQueue.splice(0).forEach(release => release()));
    }
  });

  it('rejects a non-positive resumeRefetch.chunkSize at configureDb time', () => {
    expect(() => configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never, defaults: { resumeRefetch: { chunkSize: 0 } } })).toThrow(
      'chunkSize must be a positive integer'
    );
  });

  it('keeps commit fanout narrow for a single-row update', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root, renders } = mountEnsemble(models);
    try {
      await settle();
      diagnostics().reset();
      const beforeRenders = { ...renders };

      act(() => {
        models.chats.update('chat-open-1', { lastActivityAt: new Date(2026, 0, 2).toISOString() });
      });

      const snapshot = diagnostics().snapshot();
      // 23 mounted readers total; candidates-index scopes fanout to the touched model's own bucket, so
      // notified subscribers must stay a small fraction of the whole ensemble, not fan out globally.
      expect(snapshot.commitFanoutNotified).toBeLessThan(23 * 0.25);

      for (const key of Object.keys(renders)) {
        const delta = renders[key]! - (beforeRenders[key] ?? 0);
        if (key === 'chatQuery-0' || key === 'chatScope-open' || key === 'view-open') {
          expect(delta).toBeGreaterThan(0);
        } else {
          expect(delta).toBe(0);
        }
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps churn steady-state: resorts stay thread-scoped and per-commit read-engine cost does not grow', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root, renders } = mountEnsemble(models);
    try {
      await settle();
      diagnostics().reset();
      const beforeChatRenders = renders['chatQuery-0']!;
      const beforeUserRenders = renders['view-open']!;

      const perCommitWork: number[] = [];
      const workNow = (): number => {
        const snapshot = diagnostics().snapshot();
        return snapshot.readEngineDeltaRows + snapshot.readEngineScanRows;
      };
      for (let index = 0; index < 50; index += 1) {
        const before = workNow();
        act(() => {
          // Alternates the patched row between the front and back of the sort order so every commit
          // forces a genuine reorder of thread-0 (a monotonically increasing sequenceNumber would only
          // ever append at the tail, which the scope index can fast-add without a resort).
          models.messages.update('thread-0-msg-12', { sequenceNumber: index % 2 === 0 ? -1 : MESSAGES_PER_THREAD + 1 });
        });
        perCommitWork.push(workNow() - before);
      }

      expect(diagnostics().snapshot().scopeReadResorts).toBeGreaterThan(0);
      expect(renders['chatQuery-0']).toBe(beforeChatRenders);
      expect(renders['view-open']).toBe(beforeUserRenders);

      const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
      const firstTen = average(perCommitWork.slice(0, 10));
      const lastTen = average(perCommitWork.slice(-10));
      expect(lastTen).toBeLessThan(Math.max(firstTen, 1) * 3);
    } finally {
      act(() => root.unmount());
    }
  });

  it('runs churn during a resume drain without a deadlock or a second drain, and leaves reads consistent', async () => {
    const resuming = { current: false };
    const releaseQueue: Array<() => void> = [];
    setupEnsembleTransport(resuming, releaseQueue);
    const models = createModels();
    const { root } = mountEnsemble(models);
    try {
      await settle();
      diagnostics().reset();

      resuming.current = true;
      act(() => {
        jest.advanceTimersByTime(1001);
        appStateHandler?.('background');
        appStateHandler?.('active');
      });
      await settle(2);

      // thread-15 has no active mounted query (only threads 0..8 are mounted), so its coverage is never
      // touched by a resume refetch - isolates "does churn corrupt/deadlock the drain" from the
      // unrelated, and separately covered, "complete coverage evicts rows outside the response" behavior.
      act(() => {
        models.messages.insert({ id: 'thread-15-during-resume', chatId: 'thread-15', sequenceNumber: 5000, body: 'during-resume' });
      });
      await settle(2);

      while (releaseQueue.length > 0) {
        act(() => {
          releaseQueue.splice(0).forEach(release => release());
        });
        await settle(2);
      }
      resuming.current = false;

      expect(diagnostics().snapshot().resumeDrains).toBe(1);
      expect(models.messages.scopes.thread.read({ chatId: 'thread-15' }).some(row => row.id === 'thread-15-during-resume')).toBe(true);
    } finally {
      resuming.current = false;
      act(() => root.unmount());
    }
  });
});
