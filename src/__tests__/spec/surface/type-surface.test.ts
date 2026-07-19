import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../..');
const entry = path.join(root, 'src/index.ts');

const createExportSurface = () => {
  const program = ts.createProgram([entry], {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
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
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.WriteTypeArgumentsOfSignature |
    ts.TypeFormatFlags.NoTypeReduction |
    ts.TypeFormatFlags.UseFullyQualifiedType;

  const rows = exports.map(exported => {
    const target = exported;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    const exportType = declaration
      ? checker.getTypeOfSymbolAtLocation(target, declaration)
      : checker.getDeclaredTypeOfSymbol(target);
    return `${exported.name}: ${checker.typeToString(exportType, undefined, typeFormatFlags)}`;
  });

  return rows.sort().join('\n');
};

describe('public type surface', () => {
  it('keeps signature snapshot stable across runs', () => {
    const first = printSurface();
    const second = printSurface();

    expect(first).toEqual(second);
    expect(first).toMatchInlineSnapshot(`
"BootDbOptions: any
DbDefaults: any
DbRetryClass: any
DbRetryPolicy: any
DbTransport: any
DbWhere: any
ExtractSink: any
FetchResult: any
GcReport: any
InferShapeStored: any
IngestDecl: any
LiveQueryHandle: any
LoadingState: any
MaintenanceReport: any
ModelInput: any
ModelStored: any
MutateCallbacks: any
QueryResult: any
ScopeCoverage: any
ScopeHandle: any
ScopePlacement: any
ScopeSpec: any
StoragePlane: any
belongsTo: <TChild, TParent>(model: import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").ModelRef<TParent>, options: { foreignKey: keyof TChild & string; touch?: ((child: TChild, parent: TParent) => Partial<TParent> | null) | undefined; counterCache?: { field: keyof TParent & string; filter?: ((child: TChild) => boolean) | undefined; } | undefined; }) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").RelationDecl
bootDb: (options?: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/lifecycle").BootDbOptions) => Promise<{ replayed: number; gc: import("/Users/noma4i/yupi/react-native-dblayer/src/core/gc").GcReport; maintenance: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/maintenanceRegistry").MaintenanceReport[]; }>
collectGarbage: () => import("/Users/noma4i/yupi/react-native-dblayer/src/core/gc").GcReport
configureDb: (options: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/configure").ConfigureDbOptions) => void
createDbSubscriptionEffects: <TEffects extends Record<keyof TEffects, (...args: any[]) => void>>(noopEffects: TEffects) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/subscriptionRuntime").DbSubscriptionEffectsChannel<TEffects>
createDbSubscriptionRuntime: <TPayload = unknown>(entries: readonly import("/Users/noma4i/yupi/react-native-dblayer/src/core/subscriptionRuntime").DbSubscriptionEntry<TPayload>[]) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/subscriptionRuntime").DbSubscriptionRuntime
createIdArrayPatcher: () => import("/Users/noma4i/yupi/react-native-dblayer/src/utils/runtimePrimitives").IdArrayPatcher
createKeyedArrayPatcher: <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(shape: TShape, options: { key: TKey; }) => import("/Users/noma4i/yupi/react-native-dblayer/src/utils/runtimePrimitives").KeyedArrayPatcher<TSub, TKey>
createNestedObjectPatcher: <TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[], TNested extends object = TRow[TField] & object>(model: PatchModel<TRow>, field: TField, transform: (current: TNested, ...args: TArgs) => Partial<TNested>) => import("/Users/noma4i/yupi/react-native-dblayer/src/utils/runtimePrimitives").NestedObjectPatcher<TRow, TField, TArgs>
createSingletonStatics: <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => { recordId: string; defaults: TStored; current: () => TStored | undefined; useCurrent: () => TStored; upsertCurrent: (input: Partial<TStored>) => void; patchClamped: <TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min?: number) => boolean; }
createThrottledSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: import("/Users/noma4i/yupi/react-native-dblayer/src/utils/runtimePrimitives").ThrottledSingleFlightOptions<TArgs>) => (...args: TArgs) => Promise<TResult | undefined>
defineCommand: <TData, TInput, TStored extends { id: string; } = { id: string; }, TNode = TStored>(name: string, config: CommandConfig<TData, TInput, TStored, TNode>) => { run: (input: TInput) => Promise<TData | null>; use: () => { mutate: (input: TInput, callbacks?: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/defineMutation").MutateCallbacks<TData> | undefined) => void; mutateAsync: (input: TInput) => Promise<TData | null>; isPending: boolean; error: Error | null; }; }
defineDbSubscriptionEntry: <TDocument extends TypedDocumentNode<any, any>, TKey extends Extract<keyof ResultOf<TDocument>, string>>(entry: TypedDbSubscriptionEntry<TDocument, TKey>) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/subscriptionRuntime").DbSubscriptionEntry<unknown>
defineFetch: <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>) => { use: (input: TInput) => import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/defineFetch").FetchResult<TSelected>; fetch: (input: TInput) => Promise<TSelected>; remove: () => void; }
defineModel: <const TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(config: ModelConfig<TFields, TScopes, TExt>) => Omit<import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/defineModel").ModelCore<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, { [K in keyof (Partial<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }> & Pick<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, BuildStoredRequiredKeys<TFields>>)]: (Partial<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }> & Pick<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, BuildStoredRequiredKeys<TFields>>)[K]; }>, "use" | "scopes"> & { use: RequiredReadUse<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, "id" | Extract<keyof TFields, "id" | RequiredKeys<TFields> | OptionalKeys<TFields>>>; scopes: { [K in keyof TScopes]: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/defineModel").ScopeHandle<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/defineModel").ScopeValueOf<TScopes[K]>, { [K in keyof (Partial<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }> & Pick<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, BuildStoredRequiredKeys<TFields>>)]: (Partial<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }> & Pick<{ [K in keyof ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })]: ({ id: string; } & { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; })[K]; }, BuildStoredRequiredKeys<TFields>>)[K]; }>; }; } & TExt
defineShape: <TInput = unknown>() => <TFields extends ShapeFields<TInput>>(fields: TFields) => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/shape").DbShape<TInput, import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fields").DefinedFields<TInput, TFields>>
f: { str: () => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, string, "required", false>; num: () => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, number, "required", false>; bool: () => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, boolean, "required", false>; id: () => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, string, "required", false>; enum: <T>() => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, T, "required", false>; raw: <T>() => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, T, "required", false>; custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<TInput, TOut, "required", false>; object: <TShape extends AnyDbShape>(shape: TShape) => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").EmptyDefaultFieldSpec<unknown, import("/Users/noma4i/yupi/react-native-dblayer/src/schema/infer").InferShapeStored<TShape>, "required", false>; array: <TItem extends ArrayItem>(item: TItem) => import("/Users/noma4i/yupi/react-native-dblayer/src/schema/fieldSpec").FieldSpec<unknown, ArrayItemOut<TItem>[], "required", false>; }
flushPersistence: () => void
generateTempId: (prefix?: string | undefined) => string
getDbTransport: () => import("/Users/noma4i/yupi/react-native-dblayer/src/types").DbTransport
hasMany: <TParent, TChild>(model: import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").ModelRef<TChild>, options: { foreignKey: keyof TChild & string; dependent?: "destroy" | undefined; }) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").RelationDecl
hasOne: <TParent, TChild>(model: import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").ModelRef<TChild>, options: { foreignKey: keyof TChild & string; comparator?: ((left: TChild, right: TChild) => number) | undefined; }) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").RelationDecl
isIncomingNewer: (existingUpdatedAt: string | null | undefined, incomingUpdatedAt: string | null | undefined) => boolean
isTempId: (id: string | null | undefined) => boolean
mergeOptimisticMedia: { <TMedia extends MediaRecord>(optimistic: TMedia | null | undefined, server: TMedia | null | undefined, options?: import("/Users/noma4i/yupi/react-native-dblayer/src/utils/optimisticMedia").MergeOptimisticMediaOptions<TMedia> | undefined): TMedia | null | undefined; (optimistic: unknown, server: unknown, options?: import("/Users/noma4i/yupi/react-native-dblayer/src/utils/optimisticMedia").MergeOptimisticMediaOptions<MediaRecord> | undefined): unknown; }
mergeOptimisticSnapshot: <TOptimistic extends object, TServer extends object>(optimistic: TOptimistic | null | undefined, server: TServer | null | undefined, options?: import("/Users/noma4i/yupi/react-native-dblayer/src/mutations/base/mergeOptimisticSnapshot").MergeOptimisticSnapshotOptions<TOptimistic, TServer> | undefined) => TOptimistic | TServer | (TOptimistic & TServer) | null | undefined
mmkvStoragePlane: () => import("/Users/noma4i/yupi/react-native-dblayer/src/core/planes/storagePlane").StoragePlane
patchWhenRowExists: <TStored extends { id: string; }>(model: WaiterModel<TStored>, id: string, patch: import("/Users/noma4i/yupi/react-native-dblayer/src/core/rowWaiters").RowPatch<TStored>, options: import("/Users/noma4i/yupi/react-native-dblayer/src/core/rowWaiters").PatchWhenRowExistsOptions) => void
pickDefined: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<Pick<TSource, TKey>>
pickPresent: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<{ [K in TKey]: NonNullable<TSource[K]>; }>
projectShape: <TInput, TFields extends ShapeFields<TInput>>(shape: import("/Users/noma4i/yupi/react-native-dblayer/src/schema/shape").DbShape<TInput, TFields>, source: object, overrides?: Partial<{ [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }> | undefined) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }
readShape: <TInput, TFields extends ShapeFields<TInput>>(shape: import("/Users/noma4i/yupi/react-native-dblayer/src/schema/shape").DbShape<TInput, TFields>, input: unknown) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; } | undefined
readShapeOrThrow: <TInput, TFields extends ShapeFields<TInput>>(shape: import("/Users/noma4i/yupi/react-native-dblayer/src/schema/shape").DbShape<TInput, TFields>, input: unknown, label: string) => { [K in keyof ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })]: ({ [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>; } & { [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]> | undefined; })[K]; }
reconcileOptimisticRows: <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(model: SnapshotModel<TStored>, nodes: TNode[], options: import("/Users/noma4i/yupi/react-native-dblayer/src/utils/runtimePrimitives").ReconcileOptimisticRowsOptions<TStored, TNode>) => TNode[]
references: <TChild, TRef>(model: import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").ModelRef<TRef>, options: { ids: (child: TChild) => string | readonly (string | null | undefined)[] | null | undefined; }) => import("/Users/noma4i/yupi/react-native-dblayer/src/core/relations").RelationDecl
registerReset: (reset: () => void | Promise<void>) => () => void
resetRuntime: () => void
scope: <TStored>(spec: import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/scope").ScopeSpec<TStored>) => import("/Users/noma4i/yupi/react-native-dblayer/src/dsl/scope").ScopeSpec<TStored>
setDbTransport: (transport: import("/Users/noma4i/yupi/react-native-dblayer/src/types").DbTransport) => void
stringifyNullish: (v: unknown) => string | null | undefined
suspendDb: () => void
unknown: any
unknown: any
waitForRow: <TStored extends { id: string; }>(model: WaiterModel<TStored>, id: string, options: import("/Users/noma4i/yupi/react-native-dblayer/src/core/rowWaiters").WaitForRowOptions) => Promise<TStored | undefined>"
`);
  });
});
