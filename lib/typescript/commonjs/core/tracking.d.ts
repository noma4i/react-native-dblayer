import type { DbTrackEvent, DbTrackSink } from '../types';
/** Set the sink used by declarative mutation tracking. */
export declare const setDbTrackSink: (sink: DbTrackSink | undefined) => void;
/** Return true when declarative mutation tracking has an active sink. */
export declare const hasDbTrackSink: () => boolean;
/** Emit a track event if a sink is configured. */
export declare const emitDbTrackEvent: (event: DbTrackEvent, logPrefix: string, phase: string) => void;
//# sourceMappingURL=tracking.d.ts.map