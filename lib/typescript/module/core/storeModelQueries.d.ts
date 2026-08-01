import type { ModelQueryPlane, ModelQueryPlaneOptions } from '../types';
/**
 * Model reads as live queries of the collection engine. The declared filter, order and limit are
 * compiled once into a query the engine maintains incrementally; this package no longer keeps a
 * second engine that answers the same declaration by scanning rows itself.
 */
export declare const createModelQueryPlane: (options: ModelQueryPlaneOptions) => ModelQueryPlane;
//# sourceMappingURL=storeModelQueries.d.ts.map