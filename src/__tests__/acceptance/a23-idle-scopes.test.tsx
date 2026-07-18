import { act } from 'react-test-renderer';
import { collectGarbage, defineModel, f, flushPersistence, replayJournal, scope } from '../../index';
import { createMemoryPlane, renderCounted, setupAcceptanceRuntime } from './harness';

const scopeValue = { group: 'group' };

describe('A23 idle scopes', () => {
  it('idle scope is removed and its rows evicted', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Idle',
        name: 'Idle',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      act(() => {
        model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
        jest.advanceTimersByTime(101);
        collectGarbage();
      });

      expect(model.scopes.feed.read(scopeValue)).toEqual([]);
      expect(model.use.where({}).read()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recently read scope survives', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Recent',
        name: 'Recent',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      act(() => {
        model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
        jest.advanceTimersByTime(101);
      });
      expect(model.scopes.feed.read(scopeValue)).toEqual([{ id: 'row', group: 'group', title: 'row' }]);
      act(() => {
        jest.advanceTimersByTime(99);
        collectGarbage();
      });

      expect(model.scopes.feed.read(scopeValue)).toEqual([{ id: 'row', group: 'group', title: 'row' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('mounted scope reader protects an idle scope', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Mounted',
        name: 'Mounted',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
      const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
      const renders = reader.renders();
      act(() => {
        jest.advanceTimersByTime(10_000);
        collectGarbage();
      });

      expect(reader.result()).toEqual([{ id: 'row', group: 'group', title: 'row' }]);
      expect(reader.renders()).toBe(renders);
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hydration grace', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      const storage = createMemoryPlane();
      setupAcceptanceRuntime({ storage });
      const first = defineModel({
        id: 'A23Hydration',
        name: 'Hydration',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      first.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
      flushPersistence();

      jest.advanceTimersByTime(10_000);
      setupAcceptanceRuntime({ storage });
      const restarted = defineModel({
        id: 'A23Hydration',
        name: 'Hydration',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      replayJournal();
      collectGarbage();

      expect(restarted.scopes.feed.read(scopeValue)).toEqual([{ id: 'row', group: 'group', title: 'row' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('models without the config never idle-collect', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Disabled',
        name: 'Disabled',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
      });
      act(() => {
        model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
        jest.advanceTimersByTime(10_000);
        collectGarbage();
      });

      expect(model.scopes.feed.read(scopeValue)).toEqual([{ id: 'row', group: 'group', title: 'row' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('view re-renders do not refresh scope access', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23ViewAccess',
        name: 'ViewAccess',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
      const view = model.view('feed-view', { source: 'feed', include: {}, select: row => ({ id: row.id, title: row.title }) });
      const reader = renderCounted(() => view.use(scopeValue));

      act(() => {
        jest.advanceTimersByTime(90);
        reader.rerender();
        reader.rerender();
        reader.rerender();
      });
      reader.unmount();
      act(() => {
        jest.advanceTimersByTime(11);
        collectGarbage();
      });

      expect(model.scopes.feed.read(scopeValue)).toEqual([]);
      expect(model.use.where({}).read()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('unmounted scope reader no longer protects an idle scope', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Unmounted',
        name: 'Unmounted',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      model.scopes.feed.__apply!(scopeValue, [{ id: 'row', group: 'group', title: 'row' }], 'complete');
      const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
      reader.unmount();
      act(() => {
        jest.advanceTimersByTime(101);
        collectGarbage();
      });

      expect(model.scopes.feed.read(scopeValue)).toEqual([]);
      expect(model.get('row')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('idle collection of another scope preserves mounted scope identity', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      setupAcceptanceRuntime();
      const model = defineModel({
        id: 'A23Identity',
        name: 'Identity',
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) },
        maintenance: { dropIdleScopesAfterMs: 100 }
      });
      const scopeA = { group: 'a' };
      const scopeB = { group: 'b' };
      model.scopes.feed.__apply!(scopeA, [{ id: 'a', group: 'a', title: 'a' }], 'complete');
      model.scopes.feed.__apply!(scopeB, [{ id: 'b', group: 'b', title: 'b' }], 'complete');
      const reader = renderCounted(() => model.scopes.feed.use(scopeA));
      const initial = reader.result();
      const renders = reader.renders();
      act(() => {
        jest.advanceTimersByTime(101);
        collectGarbage();
      });

      expect(reader.renders()).toBe(renders);
      expect(reader.result()).toBe(initial);
      expect(model.scopes.feed.read(scopeB)).toEqual([]);
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});
