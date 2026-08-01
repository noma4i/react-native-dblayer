import { act } from 'react';
import { bootDb, configureDb, flushPersistence, suspendDb } from '../../testApi';
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
  localPreviewUrl: null,
  clientId: null
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
    flushPersistence();
    suspendDb();

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

  it('S2 keeps both scopes after a circle is sent and the process restarts', async () => {
    const storage = createMemoryPlane();
    const serverCircle = { ...videoMessage('server-circle', 4), clientId: 'temp-circle' };
    const build = () => {
      configureDb({
        storage,
        transport: createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: serverCircle } } as TData }) }),
        dataVersion: 'app-scope-restore'
      });
      return createAppModels('ScopeRestoreCircle');
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    before.chats.insert(chatRow());
    before.messages.insertMany([1, 2, 3].map(index => videoMessage(`m-${index}`, index)));

    // The real circle path: an optimistic row carrying local media, a patch that rewrites the whole
    // media object, the identity replace, and the transcode patch that lands afterwards.
    const optimistic = { ...videoMessage('temp-circle', 4), status: 'Sending' as const, sequenceNumber: null, clientId: 'temp-circle', media: { id: 'local-circle', kind: 'video', fileUrl: 'file:///circle.mp4' } };
    before.messages.insert(optimistic as never);
    before.messages.update('temp-circle', { media: { ...optimistic.media, fileUrl: 'file:///spooled.mp4' } } as never);
    const send = before.messages.mutation('send', {
      document: { kind: 'Document', definitions: [] } as never,
      result: 'send',
      optimistic: { model: before.messages, existingTempId: () => 'temp-circle', build: () => optimistic, selectServerNode: (data: any) => data.send.message }
    });
    await act(async () => {
      await send.run({});
    });
    before.messages.update('server-circle', { media: { ...serverCircle.media, transcodeStatus: 'ready' } } as never);

    const threadBefore = before.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id);
    const mediaBefore = before.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' }).map((row: any) => row.id);
    expect(threadBefore).toHaveLength(4);
    expect(mediaBefore).toHaveLength(4);
    flushPersistence();
    suspendDb();

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

    expect({ thread: threadAfter, media: mediaAfter }).toEqual({ thread: threadBefore, media: mediaBefore });
  });
});
