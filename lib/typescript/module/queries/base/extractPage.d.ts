import type { ConnectionResult, ConnectionWithEdges, ConnectionWithNodes } from '../../types';
export declare const makePageExtractor: <TData, TNode>(selectPage: (data: TData) => ConnectionWithNodes | ConnectionWithEdges | null | undefined) => ((data: TData) => ConnectionResult<TNode>);
//# sourceMappingURL=extractPage.d.ts.map