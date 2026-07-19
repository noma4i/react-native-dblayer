import { type MutationConfig } from './defineMutation';
type CommandConfig<TData, TInput, TStored extends {
    id: string;
}, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe' | 'optimistic'> & {
    dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};
/**
 * Define a model-less GraphQL command with a conventional input-sensitive in-flight guard. Commands use
 * the standard mutation runner and hook lifecycle but cannot perform an optimistic model write. Set
 * `once: true` to retain committed keys until reset, or `dedupe: false` to disable the guard.
 *
 * @param name Stable command namespace used by the default dedupe key.
 * @param config Mutation document, response result field, optional dedupe/once policy, mapping/extract, and lifecycle callbacks.
 * @returns The same `{ run, use }` surface as `defineMutation`.
 */
export declare const defineCommand: <TData, TInput, TStored extends {
    id: string;
} = {
    id: string;
}, TNode = TStored>(name: string, config: CommandConfig<TData, TInput, TStored, TNode>) => {
    run: (input: TInput) => Promise<TData | null>;
    use: () => {
        mutate: (input: TInput, callbacks?: import("./defineMutation").MutateCallbacks<TData> | undefined) => void;
        mutateAsync: (input: TInput) => Promise<TData | null>;
        isPending: boolean;
        error: Error | null;
    };
};
export {};
//# sourceMappingURL=defineCommand.d.ts.map