import type { eq, inArray, like } from '@tanstack/db';
/** Boolean expression accepted by the collection engine's `where` clause. */
export type WhereExpression = ReturnType<typeof eq>;
/** Anything the engine accepts on either side of a comparison: a field reference, a literal, or an expression. */
export type WhereOperand = Parameters<typeof inArray>[0];
/** Row reference handed to a query builder callback: field name to comparable operand. */
export type WhereRowRef = Record<string, WhereOperand>;
/** Operand the engine accepts on either side of a string pattern comparison. */
export type WhereStringOperand = Parameters<typeof like>[0];
//# sourceMappingURL=core.whereExpression.types.d.ts.map