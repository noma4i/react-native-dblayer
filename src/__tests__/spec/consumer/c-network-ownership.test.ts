import { onlineManager } from '@tanstack/react-query';
import { isFetchNetworkOnline, setFetchNetworkOnline, subscribeFetchNetwork } from '../../testApi';

/**
 * Connectivity is one fact, so it gets one owner. A private copy alongside the query runtime's own
 * would drift the moment one of them is told something the other is not, and the retry gate, the
 * fetch paths and the subscription runtime would each act on a different answer. These cases fail
 * the moment the package starts keeping its own boolean again.
 */
describe('connectivity ownership', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('reads what the query runtime was told', () => {
    onlineManager.setOnline(false);

    expect(isFetchNetworkOnline()).toBe(false);
  });

  it('tells the query runtime what the host reported', () => {
    setFetchNetworkOnline(false);

    expect(onlineManager.isOnline()).toBe(false);
  });

  it('notifies subscribers once per change and never for a repeat', () => {
    const changes: boolean[] = [];
    const release = subscribeFetchNetwork(() => changes.push(isFetchNetworkOnline()));

    setFetchNetworkOnline(false);
    setFetchNetworkOnline(false);
    onlineManager.setOnline(true);

    release();
    expect(changes).toEqual([false, true]);
  });
});
