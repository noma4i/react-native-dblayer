import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { configureDb, createSingletonStatics, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

// App-shaped stress: a large field-sorted chat-list scope, one mounted `useWindow`, one mounted `use.where`,
// and a counters singleton. Every gate is a work-counter equality between a small and a large mount over
// the store-collection write path and the scopeIndex reconcile path: the per-upsert equality guard stays
// at zero hits, same-order page landings stay resort-free, and window materialization stays scale-invariant.
// Scale note: every gate is an equality of work counters between a small and a large mount, so any
// O(rows) component diverges at 8x scale exactly as it did at 30x; the smaller sizes keep the full
// suite inside its 30-second budget. Probativeness is re-proven by the mutation ritual, not by scale.

type ChatRow = { id: string; bucket: string; lastActivityAt: number; [key: string]: unknown };
type CountersRow = { id: string; totalUnread: number };

const CONTENT_FIELD_COUNT = 12;

const buildChatRow = (index: number, contentFieldCount = CONTENT_FIELD_COUNT): ChatRow => {
  const row: ChatRow = { id: `chat-${index}`, bucket: 'all', lastActivityAt: index };
  for (let field = 0; field < contentFieldCount; field += 1) row[`content${field}`] = `value-${index}-${field}`;
  return row;
};

const createChatsModel = (tag: string) =>
  defineModelRuntime({
    id: `SpecLargeScopeChats${tag}`,
    name: `SpecLargeScopeChats${tag}`,
    fields: {
      bucket: f.str(),
      lastActivityAt: f.num(),
      ...Object.fromEntries(Array.from({ length: CONTENT_FIELD_COUNT }, (_, index) => [`content${index}`, f.str()]))
    },
    scopes: {
      active: ({ by: { bucket: 'bucket' }, sort: { field: 'lastActivityAt', dir: 'desc' } })
    }
  });

const createCountersModel = (tag: string) =>
  defineModelRuntime({
    id: `SpecLargeScopeCounters${tag}`,
    name: `SpecLargeScopeCounters${tag}`,
    fields: { totalUnread: f.num() },
    statics: model => createSingletonStatics<CountersRow>(model, 'counters', { id: 'counters', totalUnread: 0 })
  });

const setupRuntime = (): void => {
  configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
};

/** Mounts one `useWindow(pageSize 20)` + one `use.where` + one counters-singleton reader over a seeded chat scope. */
const mountEnsemble = (tag: string, rowCount: number): { root: TestRenderer.ReactTestRenderer; chats: ReturnType<typeof createChatsModel> } => {
  setupRuntime();
  const chats = createChatsModel(tag);
  const counters = createCountersModel(tag);
  chats.insertMany(Array.from({ length: rowCount }, (_, index) => buildChatRow(index)));

  const Reader = () => {
    chats.scopes.active.useWindow({ bucket: 'all' }, { pageSize: 20 });
    chats.use.where({ bucket: 'all' }).rows();
    counters.useCurrent();
    return null;
  };

  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });
  return { root, chats };
};

describe('large scope churn', () => {
  it('(a) keeps bump work constant between 100 and 800 mounted rows', () => {
    const measureBumpWork = (rowCount: number) => {
      const { root, chats } = mountEnsemble(`BumpWork${rowCount}`, rowCount);
      diagnostics().reset();
      act(() => {
        chats.update('chat-0', { lastActivityAt: rowCount + 1 });
      });
      const snapshot = diagnostics().snapshot();
      act(() => root.unmount());
      return snapshot;
    };
    const small = measureBumpWork(100);
    const large = measureBumpWork(800);

    expect(large.scopeReadResorts).toBe(small.scopeReadResorts);
    expect(large.readEngineApplies).toBe(small.readEngineApplies);
    expect(large.readEngineDeltaRows).toBe(small.readEngineDeltaRows);
    expect(large.commitFanoutCandidates).toBe(small.commitFanoutCandidates);
    expect(large.commitFanoutNotified).toBe(small.commitFanoutNotified);
    expect(small.entityUpsertGuardHits).toBe(0);
    expect(large.entityUpsertGuardHits).toBe(0);
  });

  it('(b) keeps same-order page-reconcile fanout constant between 200 and 800 rows', () => {
    const reconcileWork = (rowCount: number) => {
      const { root, chats } = mountEnsemble(`Land${rowCount}`, rowCount);
      const rows = Array.from({ length: rowCount }, (_, index) => buildChatRow(index));
      diagnostics().reset();
      act(() => {
        chats.scopes.active.seed(
          { bucket: 'all' },
          rows.map(row => ({ ...row }))
        );
      });
      const work = diagnostics().snapshot();
      act(() => root.unmount());
      return work;
    };

    const small = reconcileWork(200);
    const large = reconcileWork(800);

    expect(large.commits).toBe(small.commits);
    expect(large.commitFanoutCandidates).toBe(small.commitFanoutCandidates);
    expect(large.commitFanoutNotified).toBe(small.commitFanoutNotified);
    expect(large.scopeReadPasses).toBe(small.scopeReadPasses);
    expect(large.scopeReadResorts).toBe(small.scopeReadResorts);
    expect(small.scopeReadResorts).toBe(0);
    expect(small.commits).toBe(1);
  });

  it('(c) keeps window materialization work steady across repeated bumps at 800 rows', () => {
    const { root, chats } = mountEnsemble('Window', 800);
    const bumpWork = (lastActivityAt: number) => {
      diagnostics().reset();
      act(() => {
        chats.update('chat-0', { lastActivityAt });
      });
      return diagnostics().snapshot();
    };
    /** first and last measure the SAME move class - a tail-to-head reposition - so steady state compares like with like. */
    const first = bumpWork(801);
    for (let index = 0; index < 13; index += 1) bumpWork(index % 2 === 0 ? -1 : 801);
    const last = bumpWork(801);
    act(() => root.unmount());

    expect(last.scopeReadPasses).toBe(first.scopeReadPasses);
    expect(last.scopeReadResorts).toBe(first.scopeReadResorts);
    expect(last.readEngineApplies).toBe(first.readEngineApplies);
    expect(last.readEngineDeltaRows).toBe(first.readEngineDeltaRows);
  });
});
