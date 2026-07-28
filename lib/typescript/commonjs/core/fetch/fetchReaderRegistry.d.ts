import type { QueryKey } from '@tanstack/react-query';
import type { ActiveFetchReader } from '../../types';
/** Register one live query/fetch reader for loss-driven refetch and foreground resume; returns the release callback. */
export declare const registerActiveFetchReaders: (reader: ActiveFetchReader) => (() => void);
/** Refetch every active reader of one query key: invalidation stays lazy for keys nobody is reading. */
export declare const refetchActiveFetchReaders: (queryKey: QueryKey) => void;
/** Resume every active reader whose freshness lapsed, in provider-owned chunks. */
export declare const resumeFetchReaders: (chunkSize: number, isCurrent: () => boolean) => Promise<number>;
//# sourceMappingURL=fetchReaderRegistry.d.ts.map