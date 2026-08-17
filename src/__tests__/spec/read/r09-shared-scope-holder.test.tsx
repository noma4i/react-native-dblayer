import * as React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { act } from 'react';
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

type Diagnostics = { snapshot(): { scopeReadPasses: number }; reset(): void };
type ReadWork = { snapshot(): { incrementalRows: number }; reset(): void };

const diagnostics = (): Diagnostics => (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as Diagnostics;
const readWork = (): ReadWork => (globalThis as Record<string, unknown>).__DBLAYER_SCOPE_READ_WORK__ as ReadWork;

guardDataLoss();

/**
 * Readers of one scope key share one materialization: the incremental work a commit costs is paid
 * once per key, not once per mounted reader, and every reader renders the same row objects.
 */
describe('shared scope holder', () => {
  const measure = async (readers: number): Promise<{ passes: number; incrementalRows: number; sameRows: boolean }> => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const models = createAppModels(`SharedScopeHolder${readers}`);
    await act(async () => {
      await bootDb();
    });
    for (let seq = 1; seq <= 20; seq += 1) models.messages.insert(message(seq) as never);

    const frames: unknown[][] = [];
    const Reader = () => {
      frames.push(models.messages.scopes.thread.use({ chatId: 'chat-1' }) as unknown[]);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        React.createElement(DbProvider, null, ...Array.from({ length: readers }, (_, index) => React.createElement(Reader, { key: index })))
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    diagnostics().reset();
    readWork().reset();
    frames.length = 0;
    for (let seq = 21; seq <= 30; seq += 1) {
      models.messages.insert(message(seq) as never);
      await act(async () => {
        await Promise.resolve();
      });
    }
    const passes = diagnostics().snapshot().scopeReadPasses;
    const incrementalRows = readWork().snapshot().incrementalRows;
    const lastFrames = frames.slice(-readers);
    const sameRows = lastFrames.length === readers && lastFrames.every(rows => rows.length === 30 && rows.every((row, index) => row === lastFrames[0]![index]));
    act(() => root.unmount());
    return { passes, incrementalRows, sameRows };
  };

  it('[R28] 5 readers of one key cost the same incremental work per commit as 1 reader and render the same row objects', async () => {
    const single = await measure(1);
    const many = await measure(5);
    expect(single.sameRows).toBe(true);
    expect(many.sameRows).toBe(true);
    expect(single.passes).toBe(10);
    expect(many.passes).toBe(single.passes);
    expect(many.incrementalRows).toBe(single.incrementalRows);
  });
});
