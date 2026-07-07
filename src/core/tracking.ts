import { getDbLogger } from './logger';
import type { DbTrackEvent, DbTrackSink } from '../types';

let currentDbTrackSink: DbTrackSink | undefined;

/** Set the sink used by declarative mutation tracking. */
export const setDbTrackSink = (sink: DbTrackSink | undefined): void => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation tracking has an active sink. */
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
