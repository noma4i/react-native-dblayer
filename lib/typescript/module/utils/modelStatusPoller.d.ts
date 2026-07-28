import type { ModelStatusPoller, ModelStatusPollerConfig } from '../types';
/**
 * Create a refcounted per-id status poller for model-backed async status updates.
 *
 * Sessions start on first attach, stop on classified payloads, exhausted attempt budget, reset, or
 * last detach, and dedupe overlapping fetches per id. Fetch errors consume attempts, are logged,
 * and never throw from scheduled interval ticks.
 *
 * @param config Status fetch, apply, classification, interval, and attempt-budget callbacks.
 * @returns Refcounted polling controls plus stable synchronous and reactive phase snapshots.
 */
export declare const createModelStatusPoller: <TResult>(config: ModelStatusPollerConfig<TResult>) => ModelStatusPoller;
//# sourceMappingURL=modelStatusPoller.d.ts.map