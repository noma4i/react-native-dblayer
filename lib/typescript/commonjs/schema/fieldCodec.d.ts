import type { FieldCodec, FieldValueReader } from '../types';
/** Create one typed conversion boundary for a field kind. */
export declare const defineFieldCodec: <TOut>(read: FieldValueReader<TOut>) => FieldCodec<TOut>;
/** Create a runtime-validating codec for one declared string enum. */
export declare const createEnumFieldCodec: <TValue extends string>(values: readonly TValue[]) => {
    read: (value: unknown) => TValue | undefined;
};
/** Canonical codecs used by scalar field builders and internal field-aware reads. */
export declare const scalarFieldCodecs: {
    str: {
        read: (value: unknown) => string | undefined;
    };
    num: {
        read: (value: unknown) => number | undefined;
    };
    int: {
        read: (value: unknown) => number | undefined;
    };
    date: {
        read: (value: unknown) => string | undefined;
    };
    bool: {
        read: (value: unknown) => boolean | undefined;
    };
    id: {
        read: (value: unknown) => string | undefined;
    };
};
//# sourceMappingURL=fieldCodec.d.ts.map