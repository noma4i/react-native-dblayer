import type { QueryClient } from '@tanstack/react-query';
import type { CollectionModel } from '../types';
export declare const setDbQueryClient: (queryClient: QueryClient | null | undefined) => void;
export declare const getDbQueryClient: () => QueryClient | null;
export declare const invalidateDbRequests: (key: readonly unknown[]) => Promise<void>;
export declare const invalidateModel: (model: CollectionModel<any, any>, scope?: object) => void;
export declare const refetchDbRequests: (key: readonly unknown[], opts?: {
    exact?: boolean;
}) => Promise<void>;
export declare const resetDbQueryRuntime: () => Promise<void>;
//# sourceMappingURL=queryClient.d.ts.map