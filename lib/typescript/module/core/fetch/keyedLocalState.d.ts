/**
 * The ONE home for per-key reader-local state that react-query's vocabulary cannot express
 * (offline pause, next-page distinction). Remote relation queries keep their
 * per-key flags, change versions, and listener fan-out here instead of hand-rolling the
 * same three maps each.
 */
import type { KeyedLocalState } from '../../types';
export declare const createKeyedLocalState: <TState extends Record<string, unknown>>(initial: TState) => KeyedLocalState<TState>;
//# sourceMappingURL=keyedLocalState.d.ts.map