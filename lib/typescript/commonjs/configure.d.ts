import type { DbExtractSink, DbMutationExtractResolver } from './core/extract';
import type { DbLogger, DbTransport, StorageAdapter } from './types';
export type ConfigureDbOptions = {
    /** GraphQL executor used by query and mutation runtimes. */
    transport: DbTransport;
    /**
     * Persistence backend for collections.
     * @default MMKV-backed adapter
     */
    storage?: StorageAdapter;
    /**
     * Logger for request and mutation runtime diagnostics.
     * @default no-op logger
     */
    logger?: DbLogger;
    /** Optional side-load extract seam. */
    extract?: {
        /**
         * Applies resolved extract payloads to application collections.
         * @default no-op
         */
        sink?: DbExtractSink;
        /**
         * Resolves mutation extract specs with server results.
         * @default no-op
         */
        mutationResolver?: DbMutationExtractResolver;
    };
};
/**
 * Configure package-wide transport, storage, logger, and extract seams.
 * @param options Runtime seams for the DB layer.
 * @returns void
 *
 * @example
 * configureDb({ transport, storage, logger });
 */
export declare const configureDb: (options: ConfigureDbOptions) => void;
//# sourceMappingURL=configure.d.ts.map