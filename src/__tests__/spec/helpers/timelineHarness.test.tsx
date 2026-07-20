import React from 'react';
import { act } from 'react-test-renderer';
import { recordTimeline, setupSpecRuntime } from './harness';

describe('recordTimeline', () => {
  it('captures every rendered value in order', () => {
    setupSpecRuntime();
    let external = 0;
    const listeners = new Set<() => void>();
    const timeline = recordTimeline(() => {
      const [, force] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        const listener = () => force();
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }, []);
      return external;
    });

    act(() => {
      external = 1;
      listeners.forEach(listener => listener());
    });
    act(() => {
      external = 2;
      listeners.forEach(listener => listener());
    });

    expect(timeline.frames()).toEqual([0, 1, 2]);
    expect(timeline.last()).toBe(2);
    timeline.unmount();
  });
});
