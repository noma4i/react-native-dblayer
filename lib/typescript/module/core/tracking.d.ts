import type { DbTrackEvent, DbTrackSink } from '../types';
/** Set the sink used by declarative mutation and command tracking. */
export declare const setDbTrackSink: (sink: DbTrackSink | undefined) => void;
/** Return true when declarative mutation and command tracking has an active sink. */
export declare const hasDbTrackSink: () => boolean;
/** Emit a track event if a sink is configured. */
export declare const emitDbTrackEvent: (event: DbTrackEvent, logPrefix: string, phase: string) => void;
/** Resolve and emit a configured track event when a sink is active. */
export declare const emitConfiguredTrackEvent: <TArgs extends unknown[]>(resolve: ((...args: TArgs) => DbTrackEvent | null | undefined) | undefined, args: TArgs, logPrefix: string, phase: string) => void;
//# sourceMappingURL=tracking.d.ts.map