import * as React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { act, useLayoutEffect } from 'react';
import { bootDb, configureDb, DbProvider } from '../../testApi';
import { createMemoryPlane, createMockTransport, guardDataLoss } from '../helpers/harness';
import { createAppModels } from '../appshape/appModels';

const stamp = (seq: number): string => `2026-07-27T00:${String(seq).padStart(2, '0')}:00Z`;

const message = (seq: number) => ({
  id: `m-${seq}`,
  chatId: 'chat-1',
  userId: 'other',
  body: `body-${seq}`,
  kind: 'text' as const,
  status: 'Sent' as const,
  createdAt: stamp(seq),
  updatedAt: stamp(seq),
  sequenceNumber: seq,
  mediaGroupId: null,
  replyToId: null,
  media: null,
  localPreviewUrl: null
});

guardDataLoss();

/**
 * A mounted scope reader observes every commit made after its first render, including commits that
 * land between that render and the moment its store subscription attaches (React runs the
 * subscribe in a passive effect, after paint; a socket event handled in that window is a normal
 * live-chat interleaving). A row missed there must still be visible on the next frame, not only
 * after the reader remounts.
 */
describe('scope reader subscribe gap', () => {
  it('[R25] a commit landed between the reader render and its subscription reaches the reader without a remount', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const models = createAppModels('ReaderSubscribeGapR25');
    await act(async () => {
      await bootDb();
    });
    models.messages.insert(message(1) as never);
    models.messages.insert(message(2) as never);

    const frames: string[][] = [];
    const Reader = () => {
      frames.push((models.messages.scopes.thread.use({ chatId: 'chat-1' }) as any[]).map((row: any) => row.id));
      return null;
    };
    // Sibling layout effect: commits before any passive effect of the same commit, i.e. after the
    // reader rendered its first snapshot and before the reader subscribed to the store.
    const Writer = () => {
      useLayoutEffect(() => {
        models.messages.insert(message(3) as never);
      }, []);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader), React.createElement(Writer)));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id)).toEqual(['m-3', 'm-2', 'm-1']);
    expect(frames[frames.length - 1]).toEqual(['m-3', 'm-2', 'm-1']);

    // A later unrelated commit must not be the thing that finally surfaces the missed row either.
    models.messages.insert(message(4) as never);
    await act(async () => {
      await Promise.resolve();
    });
    expect(frames[frames.length - 1]).toEqual(['m-4', 'm-3', 'm-2', 'm-1']);
    act(() => root.unmount());
  });

  it('[R26] a builder read (use.count / use.where) sees a commit landed between its render and its subscription', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const models = createAppModels('ReaderSubscribeGapR26');
    await act(async () => {
      await bootDb();
    });
    models.messages.insert(message(1) as never);

    const counts: number[] = [];
    const whereFrames: string[][] = [];
    const Reader = () => {
      counts.push(models.messages.use.count({ chatId: 'chat-1' }));
      whereFrames.push((models.messages.use.where({ chatId: 'chat-1' }).rows() as any[]).map((row: any) => row.id));
      return null;
    };
    const Writer = () => {
      useLayoutEffect(() => {
        models.messages.insert(message(2) as never);
      }, []);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader), React.createElement(Writer)));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect((models.messages.where({ chatId: 'chat-1' }) as any[]).length).toBe(2);
    expect(counts[counts.length - 1]).toBe(2);
    expect(whereFrames[whereFrames.length - 1].sort()).toEqual(['m-1', 'm-2']);
    act(() => root.unmount());
  });
});
