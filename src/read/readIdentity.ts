import { compositeKey, semanticValue } from '../core/serialize';

/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
export const incrementalSignature = (kind: string, ...values: unknown[]): string => compositeKey(kind, ...values.map(semanticValue));
