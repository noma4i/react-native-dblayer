import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { registerReset } from '../../../index';

const assertResetCallbackTypes = (): void => {
  registerReset(() => {});
  // @ts-expect-error reset callbacks are synchronous
  registerReset(async () => {});
};
void assertResetCallbackTypes;

const rootAbs = path.resolve(__dirname, '../../../..');
const rootReal = fs.realpathSync(rootAbs);
const roots = [rootReal, rootAbs].sort((left, right) => right.length - left.length);
const entry = path.join(rootAbs, 'src/index.ts');

const createExportSurface = () => {
  const program = ts.createProgram([entry], {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // Without a jsx mode the program skips .tsx modules, leaving their exports as an unresolved `unknown: any` row.
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error('public barrel source was not loaded');
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error('public barrel symbol was not resolved');
  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .map(symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    checker,
    exports
  };
};

const printSurface = () => {
  const { checker, exports } = createExportSurface();
  const typeFormatFlags =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteTypeArgumentsOfSignature | ts.TypeFormatFlags.NoTypeReduction | ts.TypeFormatFlags.UseFullyQualifiedType;

  const rows = exports.map(exported => {
    const target = exported;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    const exportType = declaration ? checker.getTypeOfSymbolAtLocation(target, declaration) : checker.getDeclaredTypeOfSymbol(target);
    return roots.reduce(
      (row, root) => row.replaceAll(root, '<root>'),
      `${exported.name}: ${checker.typeToString(exportType, undefined, typeFormatFlags)}`
    );
  });

  return rows.sort().join('\n');
};

/**
 * The terminals a model definition offers. The list is the DSL surface a consumer can reach through a
 * model, so it is stated here rather than inferred: an aggregation terminal that reappears would give
 * the package a second home for join/filter/sort next to the scope plane and the live query.
 */
const MODEL_DEFINITION_TERMINALS = ['poller', 'query'];

describe('public type surface', () => {
  it('offers exactly the declared model definition terminals', () => {
    const declaration = fs.readFileSync(path.resolve(__dirname, '../../../types/dsl.model.types.ts'), 'utf8');
    const picked = /export type ModelDefinitions<[^>]*> = Pick<\s*ModelCore<[^>]*>,\s*([^>]*)>/.exec(declaration)?.[1] ?? '';
    const terminals = [...picked.matchAll(/'([a-zA-Z]+)'/g)].map(match => match[1]!).sort();

    expect(terminals).toEqual(MODEL_DEFINITION_TERMINALS);
  });

  it('locks the public signature snapshot', () => {
    const first = printSurface();

    for (const row of first.split('\n')) expect(row).not.toContain('import("/');
    // Blind-spot gate: an `unknown:` row means an export whose symbol the program failed to resolve.
    for (const row of first.split('\n')) expect(row).not.toMatch(/^unknown: /);
    // Intent gate: update the export count and signature snapshot together for reviewed public surface changes.
    expect(first.split('\n')).toHaveLength(63);
    expect(first).toMatchInlineSnapshot(`
"DbDefaults: any
DbProvider: ({ children }: import("<root>/src/types/dsl.dbProvider.types").DbProviderProps) => React.ReactNode
DbProviderProps: any
DbRetryClass: any
DbRetryPolicy: any
DbTransport: any
DbTransportError: any
DbWhere: any
DbWhereOp: any
InferShapeStored: any
LoadMoreOptions: any
LoadMoreTarget: any
LoadingState: any
ModelAction: any
ModelActionHook: any
ModelEventHandle: any
ModelInput: any
ModelStored: any
ModelWaitOptions: any
NumericField: any
PatchModel: any
QueryResult: any
Relation: any
RelationOptions: any
RelationResult: any
RowId: any
RowOperation: any
RowOperationState: any
ScalarValue: any
SingletonModel: any
SingletonStatics: any
StoragePlane: any
WritePlan: any
belongsTo: <TChild, TParent>(model: import("<root>/src/types/core.relations.types").RelationTarget<TParent>, options: { foreignKey: keyof TChild & string; touch?: ((child: TChild, parent: TParent) => Partial<TParent> | null) | undefined; counterCache?: { field: keyof TParent & string; filter?: ((child: TChild) => boolean) | undefined; } | undefined; }) => import("<root>/src/types/core.relations.types").BelongsToDecl<TParent>
configureDb: (options: import("<root>/src/types/dsl.configure.types").ConfigureDbOptions) => void
createIdArrayPatcher: () => import("<root>/src/types/utils.modelPatchers.types").IdArrayPatcher
createKeyedArrayPatcher: <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(shape: TShape, options: { key: TKey; }) => import("<root>/src/types/utils.modelPatchers.types").KeyedArrayPatcher<TSub, TKey>
createNestedObjectPatcher: <TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[], TNested extends object = TRow[TField] & object>(model: import("<root>/src/types/utils.singletonStatics.types").PatchModel<TRow>, field: TField, transform: (current: TNested, ...args: TArgs) => Partial<TNested>) => import("<root>/src/types/utils.modelPatchers.types").NestedObjectPatcher<TRow, TField, TArgs>
createSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options?: import("<root>/src/types/utils.singleFlight.types").SingleFlightOptions | undefined) => (...args: TArgs) => Promise<TResult>
createSingletonStatics: <TStored extends RowId>(model: import("<root>/src/types/utils.singletonStatics.types").SingletonModel<TStored>, recordId: string, defaults: TStored) => import("<root>/src/types/utils.singletonStatics.types").SingletonStatics<TStored>
createThrottledSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: import("<root>/src/types/utils.singleFlight.types").ThrottledSingleFlightOptions<TArgs>) => (...args: TArgs) => Promise<TResult | undefined>
defineModel: <const TKey extends string, TShape extends DbShape<any, AnyFields>, const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>> = Record<never, never>, const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>> = Record<never, never>, const TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>> = Record<never, never>, const TAssociations extends Record<string, RelationDecl<unknown>> = Record<never, never>, TStatics extends Record<string, unknown> = Record<never, never>>(key: TKey, config: import("<root>/src/types/dsl.modelFacade.types").ModelFacadeConfig<TShape, TRelations, TActions, TEvents, TAssociations, TStatics, TKey>) => import("<root>/src/types/dsl.modelFacade.types").ModelFacade<import("<root>/src/types/dsl.modelFacade.types").ModelStoredValue<TShape>, import("<root>/src/types/dsl.modelFacade.types").ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TStatics, TKey>
defineShape: <TInput = unknown>() => <TFields extends ShapeFields<TInput>>(fields: TFields) => import("<root>/src/types/schema.shape.types").DbShape<TInput, import("<root>/src/types/schema.fields.types").DefinedFields<TInput, TFields>>
f: { str: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, string, "required", false>; num: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, number, "required", false>; int: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, number, "required", false>; date: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, string, "required", false>; bool: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, boolean, "required", false>; id: () => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, string, "required", false>; enum: <TValue extends string>(values: readonly TValue[]) => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, TValue, "required", false>; raw: <T>() => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, T, "required", false>; custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<TInput, TOut, "required", false>; object: <TShape extends AnyDbShape>(shape: TShape) => import("<root>/src/types/schema.fieldSpec.types").EmptyDefaultFieldSpec<unknown, import("<root>/src/types/schema.infer.types").InferShapeStored<TShape>, "required", false>; array: <TItem extends ArrayItem>(item: TItem) => import("<root>/src/types/schema.fieldSpec.types").FieldSpec<unknown, import("<root>/src/types/schema.f.types").ArrayItemOut<TItem>[], "required", false>; }
fromNodes: <T>(connection: { nodes?: readonly (T | null | undefined)[] | null | undefined; } | null | undefined) => T[]
generateTempId: (prefix?: string | undefined) => string
hasMany: <_TParent, TChild>(model: import("<root>/src/types/core.relations.types").RelationTarget<TChild>, options: { foreignKey: keyof TChild & string; dependent?: "destroy" | undefined; }) => import("<root>/src/types/core.relations.types").HasManyDecl<TChild>
hasOne: <_TParent, TChild>(model: import("<root>/src/types/core.relations.types").RelationTarget<TChild>, options: { foreignKey: keyof TChild & string; comparator?: ((left: TChild, right: TChild) => number) | undefined; }) => import("<root>/src/types/core.relations.types").HasOneDecl<TChild>
isTempId: (id: string | null | undefined) => boolean
modelRef: <TStored>(key: string) => import("<root>/src/types/core.relations.types").ModelRef<TStored>
pickDefined: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<Pick<TSource, TKey>>
pickPresent: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<{ [K in TKey]: NonNullable<TSource[K]>; }>
projectShape: <TInput, TFields extends ShapeFields<TInput>>(shape: import("<root>/src/types/schema.shape.types").DbShape<TInput, TFields>, source: object, overrides?: Partial<{ [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }> | undefined) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }
readShape: <TInput, TFields extends ShapeFields<TInput>>(shape: import("<root>/src/types/schema.shape.types").DbShape<TInput, TFields>, input: unknown) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; } | undefined
readShapeOrThrow: <TInput, TFields extends ShapeFields<TInput>>(shape: import("<root>/src/types/schema.shape.types").DbShape<TInput, TFields>, input: unknown, label: string) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }
references: <TChild, TRef>(model: import("<root>/src/types/core.relations.types").RelationTarget<TRef>, options: { ids: (child: TChild) => string | readonly (string | null | undefined)[] | null | undefined; }) => import("<root>/src/types/core.relations.types").ReferencesDecl<TRef>
registerReset: <TReset extends Resetter>(reset: import("<root>/src/types/core.reset.types").SyncResetter<TReset>) => () => void
resetRuntime: () => void
scalar: { str: import("<root>/src/types/schema.scalar.types").ScalarValue<string>; num: import("<root>/src/types/schema.scalar.types").ScalarValue<number>; int: import("<root>/src/types/schema.scalar.types").ScalarValue<number>; date: import("<root>/src/types/schema.scalar.types").ScalarValue<string>; bool: import("<root>/src/types/schema.scalar.types").ScalarValue<boolean>; id: import("<root>/src/types/schema.scalar.types").ScalarValue<string>; enum: <TValue extends string>(values: readonly TValue[]) => import("<root>/src/types/schema.scalar.types").ScalarValue<TValue>; }
setFetchNetworkOnline: (nextOnline: boolean) => void
useDbSubscriptions: (active: boolean) => void
useLoadMore: (target: import("<root>/src/types/dsl.pagination.types").LoadMoreTarget, options?: import("<root>/src/types/dsl.pagination.types").LoadMoreOptions | undefined) => () => void
useMergedScopeRows: <TRow extends { id: string; }>(baseRows: readonly TRow[], extraRows: readonly TRow[], options?: import("<root>/src/types/read.liveRead.types").MergeOptions<TRow> | undefined) => readonly TRow[]"
`);
  });
});
