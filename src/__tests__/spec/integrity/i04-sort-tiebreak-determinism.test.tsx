import { act } from 'react';
import { defineModel, f } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// A2 audit guards: equal-sort-key ordering is deterministic and identical across read surfaces.
// Comparator canon: NULLS LAST, implicit locale-independent id tie-break, no session-local
// tie-break state. Scope reads (membership join) and model builder reads must never diverge
// on ties, and order must survive unmount/remount.


const createItems = (suffix: string) =>
  defineModel({
    id: `SpecIntegrityTiebreak${suffix}`,
    name: `SpecIntegrityTiebreak${suffix}`,
    fields: { id: f.str(), status: f.str(), score: f.num() },
    scopes: {
      list: ({ by: { status: 'status' }, sort: { field: 'score', dir: 'desc' } })
    }
  });

describe('sort tie-break determinism (A2)', () => {
  it('orders equal-key rows identically in scope reads and builder reads (id tie-break)', () => {
    setupSpecRuntime();
    const items = createItems('CrossSurface');

    const scopeReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    act(() => {
      items.insert({ id: 'b-row', status: 'ready', score: 5 });
    });
    act(() => {
      items.insert({ id: 'a-row', status: 'ready', score: 5 });
    });

    const builderReader = renderCounted(() => items.use.where({ status: 'ready' }).orderBy('score', 'desc').rows());

    expect(scopeReader.result().map(row => row.id)).toEqual(builderReader.result().map(row => row.id));
    expect(builderReader.result().map(row => row.id)).toEqual(['a-row', 'b-row']);

    scopeReader.unmount();
    builderReader.unmount();
  });

  it('keeps live scope order for equal-key rows unchanged across unmount/remount', () => {
    setupSpecRuntime();
    const items = createItems('Remount');

    const liveReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    act(() => {
      items.insert({ id: 'b-row', status: 'ready', score: 5 });
    });
    act(() => {
      items.insert({ id: 'a-row', status: 'ready', score: 5 });
    });
    const liveOrder = liveReader.result().map(row => row.id);
    liveReader.unmount();

    const remountedReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    const remountedOrder = remountedReader.result().map(row => row.id);
    remountedReader.unmount();

    expect(remountedOrder).toEqual(liveOrder);
    expect(remountedOrder).toEqual(['a-row', 'b-row']);
  });

  it('orders NaN after finite values and resolves NaN ties by id on every field-sort surface', () => {
    setupSpecRuntime();
    const items = createItems('NaN');
    const scopeReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));

    act(() => {
      items.insertMany([
        { id: 'nan-z', status: 'ready', score: Number.NaN },
        { id: 'finite', status: 'ready', score: 5 },
        { id: 'nan-a', status: 'ready', score: Number.NaN }
      ]);
    });

    const builderReader = renderCounted(() => items.use.where({ status: 'ready' }).orderBy('score', 'desc').rows());
    const expected = ['finite', 'nan-a', 'nan-z'];

    expect(scopeReader.result().map(row => row.id)).toEqual(expected);
    expect(builderReader.result().map(row => row.id)).toEqual(expected);

    scopeReader.unmount();
    builderReader.unmount();
  });

  it('orders a scope by a declared key list: primary desc, secondary desc, nulls last, id tie-break', () => {
    setupSpecRuntime();
    const messages = defineModel({
      id: 'SpecIntegrityMultiKeySort',
      name: 'SpecIntegrityMultiKeySort',
      fields: { id: f.str(), chatId: f.str(), seq: f.num().nullable(), createdAt: f.str() },
      scopes: {
        thread: ({
          by: { chatId: 'chatId' },
          sort: [
            { field: 'seq', dir: 'desc' },
            { field: 'createdAt', dir: 'desc' }
          ]
        })
      }
    });

    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    act(() => {
      messages.insert({ id: 'm-old', chatId: 'chat-1', seq: 1, createdAt: '2026-01-01T00:00:00Z' });
      messages.insert({ id: 'm-new', chatId: 'chat-1', seq: 3, createdAt: '2026-01-03T00:00:00Z' });
      messages.insert({ id: 'b-pending', chatId: 'chat-1', seq: null, createdAt: '2026-01-05T00:00:00Z' });
      messages.insert({ id: 'a-pending', chatId: 'chat-1', seq: null, createdAt: '2026-01-05T00:00:00Z' });
      messages.insert({ id: 'm-mid', chatId: 'chat-1', seq: 2, createdAt: '2026-01-02T00:00:00Z' });
    });

    expect(reader.result().map(row => row.id)).toEqual(['m-new', 'm-mid', 'm-old', 'a-pending', 'b-pending']);
    reader.unmount();
  });
});
