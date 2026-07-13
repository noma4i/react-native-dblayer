import { getDbLogger } from './logger';
import { createConfiguredSlot } from './configuredSlot';
import type { DbTrackEvent, DbTrackSink } from '../types';

const currentDbTrackSink = createConfiguredSlot<DbTrackSink | undefined>(undefined);

/** Set the sink used by declarative mutation and command tracking. */
export const setDbTrackSink = (sink: DbTrackSink | undefined): void => {
  currentDbTrackSink.set(sink);
};

/** Return true when declarative mutation and command tracking has an active sink. */
export const hasDbTrackSink = (): boolean => currentDbTrackSink.get() !== undefined;

/** Emit a track event if a sink is configured. */
export const emitDbTrackEvent = (event: DbTrackEvent, logPrefix: string, phase: string): void => {
  const sink = currentDbTrackSink.get();
  if (!sink) return;

  try {
    sink(event);
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
  if (!currentDbTrackSink.get()) return;
  if (!resolve) return;

  try {
    const event = resolve(...args);
    if (event) emitDbTrackEvent(event, logPrefix, phase);
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', phase, error);
  }
};
