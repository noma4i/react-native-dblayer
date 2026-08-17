import * as React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { act, useLayoutEffect } from 'react';
import { bootDb, configureDb, DbProvider } from '../../testApi';
import { createMemoryPlane, createMockTransport, guardDataLoss } from '../helpers/harness';
import { createAppModels } from '../appshape/appModels';

const user = (id: string, fullName: string) => ({
  id,
  fullName,
  username: `u-${id}`,
  avatarUrl: null,
  connectionStatus: null,
  lastInteraction: null,
  online: false,
  lastSeenAt: null,
  createdAt: '2026-07-27T00:00:00Z',
  updatedAt: '2026-07-27T00:00:00Z'
});

guardDataLoss();

/**
 * A reader whose dependencies change (a new id, a parent repointed by data) must not open a
 * window where its subscription still names the OLD dependencies: a commit on the new
 * dependency between that render and the effect that would have moved the subscription is a
 * normal live interleaving and must reach the reader without a remount.
 */
describe('live read deps gap', () => {
  it('[R27] use.find sees a commit on the NEW id landed between the render that switched ids and its effect', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const models = createAppModels('LiveReadDepsGapR27');
    await act(async () => {
      await bootDb();
    });
    models.users.insert(user('a', 'Alice') as never);
    models.users.insert(user('b', 'Bob') as never);

    const frames: Array<string | undefined> = [];
    const Reader = ({ id }: { id: string }) => {
      frames.push((models.users.use.find(id) as { fullName: string } | undefined)?.fullName);
      return null;
    };
    // The writer mounts only on the SECOND render (id b): its layout effect commits after the
    // reader rendered with the new id and before any passive effect of that commit ran.
    const Writer = () => {
      useLayoutEffect(() => {
        models.users.update('b', { fullName: 'Bob Renamed' } as never);
      }, []);
      return null;
    };
    const Tree = ({ id, write }: { id: string; write: boolean }) =>
      React.createElement(DbProvider, null, React.createElement(Reader, { id }), write ? React.createElement(Writer) : null);
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Tree, { id: 'a', write: false }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(frames[frames.length - 1]).toBe('Alice');

    act(() => {
      root.update(React.createElement(Tree, { id: 'b', write: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect((models.users.find('b') as { fullName: string }).fullName).toBe('Bob Renamed');
    expect(frames[frames.length - 1]).toBe('Bob Renamed');
    act(() => root.unmount());
  });

  it('[R27] use.related follows a parent repointed by data and sees the new parent change landed in the same window', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const models = createAppModels('LiveReadDepsGapR27b');
    await act(async () => {
      await bootDb();
    });
    models.users.insert(user('u1', 'One') as never);
    models.users.insert(user('u2', 'Two') as never);
    const message = (userId: string) => ({
      id: 'm-1',
      chatId: 'chat-1',
      userId,
      body: 'hi',
      kind: 'text' as const,
      status: 'Sent' as const,
      createdAt: '2026-07-27T00:01:00Z',
      updatedAt: '2026-07-27T00:01:00Z',
      sequenceNumber: 1,
      mediaGroupId: null,
      replyToId: null,
      media: null,
      localPreviewUrl: null
    });
    models.messages.insert(message('u1') as never);

    const frames: Array<string | undefined> = [];
    const Reader = () => {
      frames.push((models.messages.use.related('m-1', 'user') as { fullName: string } | undefined)?.fullName);
      return null;
    };
    const Writer = () => {
      useLayoutEffect(() => {
        models.users.update('u2', { fullName: 'Two Renamed' } as never);
      }, []);
      return null;
    };
    const Tree = ({ write }: { write: boolean }) => React.createElement(DbProvider, null, React.createElement(Reader), write ? React.createElement(Writer) : null);
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Tree, { write: false }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(frames[frames.length - 1]).toBe('One');

    // Repoint the parent by data: the reader recomputes on the bus notification and re-renders
    // with deps [m-1, u2]; the writer mounts in that same commit and updates u2 in its layout effect.
    act(() => {
      models.messages.update('m-1', { userId: 'u2' } as never);
      root.update(React.createElement(Tree, { write: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(frames[frames.length - 1]).toBe('Two Renamed');
    act(() => root.unmount());
  });
});
