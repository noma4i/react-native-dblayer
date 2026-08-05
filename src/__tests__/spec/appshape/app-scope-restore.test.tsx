import { act } from 'react';
import { bootDb, configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, recordTimeline } from '../helpers/harness';
import { createAppModels } from './appModels';

const time = '2026-07-27T00:00:00Z';
const ownId = 'me';

const chatRow = () => ({
  id: 'chat-1', uuid: null, kind: 'personal' as const, status: 'active' as const, premium: false, name: null, logoUrl: null, description: null,
  isPublic: false, history: 'all' as const, pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: time,
  lastMessageAt: null, lastSequenceNumber: null, lastMessageId: null, readMarksSummary: null, summary: null, connectionStatus: null,
  userIds: [], ownerId: null, createdAt: time, updatedAt: time
});

const videoMessage = (id: string, sequenceNumber: number) => ({
  id,
  chatId: 'chat-1',
  userId: ownId,
  body: '',
  kind: 'video' as const,
  status: 'Sent' as const,
  createdAt: `2026-07-27T00:0${sequenceNumber}:00Z`,
  updatedAt: `2026-07-27T00:0${sequenceNumber}:00Z`,
  sequenceNumber,
  mediaGroupId: null,
  replyToId: null,
  media: { id: `media-${id}`, kind: 'video', fileUrl: `https://cdn/${id}.mp4` },
  localPreviewUrl: null
});

const CircleSchema = defineShape()({
  chatId: f.str(),
  userId: f.str(),
  body: f.str(),
  kind: f.str(),
  status: f.str(),
  createdAt: f.str(),
  updatedAt: f.str(),
  sequenceNumber: f.num().nullable(),
  mediaGroupId: f.str().nullable(),
  replyToId: f.str().nullable(),
  mediaBucket: f.str(),
  media: f.raw<Record<string, unknown>>(),
  localPreviewUrl: f.str().nullable()
});

type CircleInput = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sequenceNumber: number | null;
  mediaGroupId: string | null;
  replyToId: string | null;
  mediaBucket: string;
  media: Record<string, unknown>;
  localPreviewUrl: string | null;
};
type CircleData = { send: { message: CircleInput } };

const createCircleModel = (key: string) =>
  defineModel(key, {
    schema: CircleSchema,
    relations: () => ({
      thread: { by: { chatId: 'chatId' }, sort: { field: 'sequenceNumber', dir: 'desc' } },
      media: { by: { chatId: 'chatId', mediaBucket: 'mediaBucket' }, sort: { field: 'sequenceNumber', dir: 'desc' } }
    }),
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      send: owner.gql.action<CircleData, Record<string, never>, Omit<CircleInput, 'id'>, 'send'>({ kind: 'Document', definitions: [] } as never, {
        mode: 'request',
        result: 'send',
        variables: () => ({}),
        optimistic: { root: { insert: { select: ({ input, tempId }) => ({ id: tempId, ...input }) } } },
        root: { insert: { select: ({ data }) => data.send.message } }
      })
    })
  });

/**
 * Two scopes of one model over the same rows must come back together.
 *
 * The reported failure is exactly an asymmetry between them: the chat thread is empty on screen
 * while the Media screen of the SAME chat still lists every clip, so the rows are alive and only one
 * scope lost its members. A scope reader treats a scope as unresolved until its generation leaves
 * zero, so a membership value that fails to come back reads as an empty screen rather than as an
 * error - and the next refetch hides it again.
 */
describe('app-shaped scope restore', () => {
  it('S1 restores the thread scope and the media scope together after a process restart', async () => {
    const storage = createMemoryPlane();
    const build = () => {
      configureDb({ storage, transport: createMockTransport(), dataVersion: 'app-scope-restore' });
      return createAppModels('ScopeRestore');
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    before.chats.insert(chatRow());
    before.messages.insertMany([1, 2, 3].map(index => videoMessage(`m-${index}`, index)));
    const threadBefore = before.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id);
    const mediaBefore = before.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' }).map((row: any) => row.id);
    expect(threadBefore).toHaveLength(3);
    expect(mediaBefore).toHaveLength(3);

    const after = build();
    await act(async () => {
      await bootDb();
    });
    const threadReader = recordTimeline(() => after.messages.scopes.thread.use({ chatId: 'chat-1' }));
    const mediaReader = recordTimeline(() => after.messages.scopes.media.use({ chatId: 'chat-1', mediaBucket: 'visual' }));

    const threadAfter = (threadReader.last() as any[]).map(row => row.id);
    const mediaAfter = (mediaReader.last() as any[]).map(row => row.id);
    threadReader.unmount();
    mediaReader.unmount();

    // Neither scope may come back emptier than the other: one empty reader beside one full reader is
    // the screen the report shows.
    expect({ thread: threadAfter, media: mediaAfter }).toEqual({ thread: threadBefore, media: mediaBefore });
  });

  it('[R21] S2 keeps both scopes after a circle is sent and the process restarts', async () => {
    const storage = createMemoryPlane();
    const serverCircle = { ...videoMessage('server-circle', 4), mediaBucket: 'visual' };
    const build = () => {
      configureDb({
        storage,
        transport: createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: serverCircle } } as TData }) }),
        dataVersion: 'app-scope-restore'
      });
      return createCircleModel('AppScopeRestoreCircleMessage');
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    before.insertMany([1, 2, 3].map(index => ({ ...videoMessage(`m-${index}`, index), mediaBucket: 'visual' })));

    // The real circle path: an optimistic row carrying local media, a patch that rewrites the whole
    // media object, the identity replace, and the transcode patch that lands afterwards.
    const optimistic = { ...videoMessage('ignored', 4), status: 'Sending' as const, sequenceNumber: null, mediaBucket: 'visual', media: { id: 'local-circle', kind: 'video', fileUrl: 'file:///spooled.mp4' } };
    await act(async () => {
      await before.actions.send.run(optimistic);
    });
    before.update('server-circle', { media: { ...serverCircle.media, transcodeStatus: 'ready' } });

    const threadBefore = before.thread({ chatId: 'chat-1' }).read().map(row => row.id);
    const mediaBefore = before.media({ chatId: 'chat-1', mediaBucket: 'visual' }).read().map(row => row.id);
    expect(threadBefore).toHaveLength(4);
    expect(mediaBefore).toHaveLength(4);

    const after = build();
    await act(async () => {
      await bootDb();
    });
    const threadReader = recordTimeline(() => after.thread({ chatId: 'chat-1' }).use().data);
    const mediaReader = recordTimeline(() => after.media({ chatId: 'chat-1', mediaBucket: 'visual' }).use().data);
    const threadAfter = threadReader.last().map(row => row.id);
    const mediaAfter = mediaReader.last().map(row => row.id);
    threadReader.unmount();
    mediaReader.unmount();

    expect({ thread: threadAfter, media: mediaAfter }).toEqual({ thread: threadBefore, media: mediaBefore });
  });
});
