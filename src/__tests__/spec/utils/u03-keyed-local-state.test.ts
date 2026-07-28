import { createKeyedLocalState } from '../../../core/fetch/keyedLocalState';

/**
 * Contracts of the one reader-local state home shared by defineQuery/defineFetch: a merge that
 * changes nothing is fully silent (no version bump, no listener call), so idempotent flag writes
 * on hot request paths never wake a subscribed reader.
 */
describe('keyed local state', () => {
  it('stays silent for a merge that changes nothing', () => {
    const state = createKeyedLocalState({ isPaused: false, isFetchingNextPage: false });
    let notified = 0;
    state.subscribe('k', () => {
      notified += 1;
    });

    state.set('k', { isPaused: false });
    state.set('k', {});

    expect(state.version('k')).toBe(0);
    expect(notified).toBe(0);
  });

  it('bumps the version and notifies exactly once per real change', () => {
    const state = createKeyedLocalState({ isPaused: false, isFetchingNextPage: false });
    let notified = 0;
    state.subscribe('k', () => {
      notified += 1;
    });

    state.set('k', { isPaused: true });
    state.set('k', { isPaused: true });

    expect(state.get('k')).toEqual({ isPaused: true, isFetchingNextPage: false });
    expect(state.version('k')).toBe(1);
    expect(notified).toBe(1);
  });

  it('scopes state, versions, and listeners per key and resets them on clear', () => {
    const state = createKeyedLocalState({ isPaused: false });
    let otherNotified = 0;
    state.subscribe('other', () => {
      otherNotified += 1;
    });

    state.set('k', { isPaused: true });
    expect(state.get('other')).toEqual({ isPaused: false });
    expect(otherNotified).toBe(0);

    state.clear();
    expect(state.get('k')).toEqual({ isPaused: false });
    expect(state.version('k')).toBe(0);
  });
});
