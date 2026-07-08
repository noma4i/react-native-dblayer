import { getDbLogger } from './logger';
import type { DbTrackEvent, DbTrackSink } from '../types';

let currentDbTrackSink: DbTrackSink | undefined;

/** Set the sink used by declarative mutation and command tracking. */
export const setDbTrackSink = (sink: DbTrackSink | undefined): void => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation and command tracking has an active sink. */
export const hasDbTrackSink = (): boolean => currentDbTrackSink !== undefined;

/** Emit a track event if a sink is configured. */
export const emitDbTrackEvent = (event: DbTrackEvent, logPrefix: string, phase: string): void => {
  if (!currentDbTrackSink) return;

  try {
    currentDbTrackSink(event);
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track sink failed', phase, error);
  }
};

/** Resolve and emit a configured track event when a sink is active. */
export const emitConfiguredTrackEvent = <TArgs extends unknown[]>(
  resolve: ((...args: TArgs) => DbTrackEvent | null | undefined) | undefined,
  args: TArgs,
  logPrefix: string,
  phase: string
): void => {
  if (!currentDbTrackSink) return;
  if (!resolve) return;

  try {
    const event = resolve(...args);
    if (event) emitDbTrackEvent(event, logPrefix, phase);
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', phase, error);
  }
};
