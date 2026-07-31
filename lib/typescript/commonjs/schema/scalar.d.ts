import type { ScalarValue } from '../types';
/**
 * Read individual transport values through the same codecs as `f.*` fields.
 *
 * `read` returns the stored scalar type or `undefined`; `require` returns the stored type or throws
 * an error naming the invalid input.
 */
export declare const scalar: {
    str: ScalarValue<string>;
    num: ScalarValue<number>;
    int: ScalarValue<number>;
    date: ScalarValue<string>;
    bool: ScalarValue<boolean>;
    id: ScalarValue<string>;
    enum: <TValue extends string>(values: readonly TValue[]) => ScalarValue<TValue>;
};
//# sourceMappingURL=scalar.d.ts.map