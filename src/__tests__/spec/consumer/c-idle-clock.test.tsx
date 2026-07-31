import { act } from 'react';
import { defineModelRuntime, f } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type Note = { id: string; bucket: string; rank: number; body: string };

/**
 * Time passing is not an event this package reacts to. A screen the user left an hour ago holds the
 * same rows when they come back, and nothing behind the runtime - not a retention timer of a
 * dependency, not a scheduler of ours - drops data while the app simply sits idle.
 *
 * The reader has to mount and LEAVE before the idle stretch: a retention timer arms when the last
 * subscriber goes, so a test that never releases one proves nothing about retention.
 */
const IDLE_MINUTES = 60;

const idleFor = async (minutes: number): Promise<void> => {
  // Retention timers arm from a microtask and sweep from an idle callback: draining one queue and
  // not the other silently skips the very thing under test.
  await Promise.resolve();
  jest.advanceTimersByTime(minutes * 60 * 1000);
  await Promise.resolve();
  jest.runOnlyPendingTimers();
  await Promise.resolve();
  jest.runOnlyPendingTimers();
};

const ROWS: Note[] = [
  { id: 'n-1', bucket: 'a', rank: 1, body: 'first' },
  { id: 'n-2', bucket: 'a', rank: 2, body: 'second' },
  { id: 'n-3', bucket: 'a', rank: 3, body: 'third' }
];

let suffix = 0;
const createNotes = () => {
  setupSpecRuntime();
  const notes = defineModelRuntime({
    id: `SpecIdleClock${(suffix += 1)}`,
    name: `SpecIdleClock${suffix}`,
    fields: { bucket: f.str(), rank: f.num(), body: f.str() },
    scopes: {
      feed: { by: { bucket: 'bucket' }, sort: { comparator: (left: Note, right: Note) => left.rank - right.rank, orderFields: ['rank'] } }
    }
  });
  notes.scopes.feed.seed({ bucket: 'a' }, ROWS);
  return notes;
};

/** Mount a scope reader and let it go: this is what arms a retention timer on the collections behind it. */
const visitAndLeave = (notes: ReturnType<typeof createNotes>): string[] => {
  const reader = renderCounted(() => notes.scopes.feed.use({ bucket: 'a' }));
  const ids = reader.result().map(row => row.id);
  reader.unmount();
  return ids;
};

describe('idle clock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves the same rows to a reader that returns after an hour away', async () => {
    const notes = createNotes();
    expect(visitAndLeave(notes)).toEqual(['n-1', 'n-2', 'n-3']);

    await idleFor(IDLE_MINUTES);

    expect(visitAndLeave(notes)).toEqual(['n-1', 'n-2', 'n-3']);
  });

  it('keeps direct reads answering after an hour with nothing mounted', async () => {
    const notes = createNotes();
    visitAndLeave(notes);

    await idleFor(IDLE_MINUTES);

    expect(notes.find('n-2')).toMatchObject({ id: 'n-2', body: 'second' });
    expect(notes.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['n-1', 'n-2', 'n-3']);
  });

  it('accepts a write after an hour idle and shows it to the next reader', async () => {
    const notes = createNotes();
    visitAndLeave(notes);

    await idleFor(IDLE_MINUTES);
    notes.scopes.feed.seed({ bucket: 'a' }, [...ROWS, { id: 'n-4', bucket: 'a', rank: 4, body: 'fourth' }]);

    expect(visitAndLeave(notes)).toEqual(['n-1', 'n-2', 'n-3', 'n-4']);
  });

  it('keeps a reader that mounted before the idle stretch live through it', async () => {
    const notes = createNotes();
    visitAndLeave(notes);
    const reader = renderCounted(() => notes.scopes.feed.use({ bucket: 'a' }));

    await idleFor(IDLE_MINUTES);
    act(() => {
      notes.scopes.feed.seed({ bucket: 'a' }, [...ROWS, { id: 'n-5', bucket: 'a', rank: 5, body: 'fifth' }]);
    });

    expect(reader.result().map(row => row.id)).toEqual(['n-1', 'n-2', 'n-3', 'n-5']);
    reader.unmount();
  });
});
