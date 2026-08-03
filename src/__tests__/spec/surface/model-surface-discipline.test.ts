import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(__dirname, '../../../..');
const sourceRoot = resolve(root, 'src');
const entry = resolve(sourceRoot, 'index.ts').split('/').join('/');
const fixtureName = resolve(root, 'model-action-surface.fixture.ts');

const options: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
  skipLibCheck: true,
  noEmit: true
};

const packageFiles = new Map<string, ts.SourceFile | undefined>();
let fixtureSource = '';
let previousProgram: ts.Program | undefined;
const host = ts.createCompilerHost(options);
const readPackageFile = host.getSourceFile.bind(host);

host.fileExists = fileName => fileName === fixtureName || ts.sys.fileExists(fileName);
host.readFile = fileName => (fileName === fixtureName ? fixtureSource : ts.sys.readFile(fileName));
host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
  if (fileName === fixtureName) return ts.createSourceFile(fileName, fixtureSource, languageVersion, true);
  if (!packageFiles.has(fileName)) packageFiles.set(fileName, readPackageFile(fileName, languageVersion, onError, shouldCreateNewSourceFile));
  return packageFiles.get(fileName);
};

const compileFixture = (source: string): readonly ts.Diagnostic[] => {
  fixtureSource = source;
  const program = ts.createProgram([fixtureName], options, host, previousProgram);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  previousProgram = program;
  return diagnostics;
};

const diagnosticsText = (diagnostics: readonly ts.Diagnostic[]): string[] =>
  diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

type SourceEntry = { name: string; file: ts.SourceFile };

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(directoryEntry => {
    const file = resolve(directory, directoryEntry.name);
    if (directoryEntry.isDirectory()) return directoryEntry.name === '__tests__' ? [] : sourceFiles(file);
    return /\.tsx?$/.test(directoryEntry.name) ? [file] : [];
  });

const sourceEntries = sourceFiles(sourceRoot).map<SourceEntry>(file => {
  const name = relative(sourceRoot, file);
  const source = readFileSync(file, 'utf8');
  return {
    name,
    file: ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  };
});

const visit = (node: ts.Node, callback: (candidate: ts.Node) => void): void => {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
};

const declarationName = (node: ts.Node): string | undefined => {
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
    return node.name?.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
};

const propertyName = (node: ts.Node): string | undefined => {
  if (!('name' in node)) return undefined;
  const name = (node as ts.NamedDeclaration).name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

const publicExports = (): string[] => {
  const index = sourceEntries.find(source => source.name === 'index.ts');
  if (!index) throw new Error('Missing src/index.ts');
  return index.file.statements.flatMap(statement => {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return [];
    return statement.exportClause.elements.map(element => element.name.text);
  });
};

const typeElementProperties = (typeNode: ts.TypeNode): string[] => {
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap(typeElementProperties);
  }
  if (!ts.isTypeLiteralNode(typeNode)) return [];
  return typeNode.members.flatMap(member => {
    const name = propertyName(member);
    return name ? [name] : [];
  });
};

const actionTypeProperties = (): Array<{ declaration: string; property: string }> => {
  const properties: Array<{ declaration: string; property: string }> = [];
  for (const source of sourceEntries) {
    visit(source.file, node => {
      const declaration = declarationName(node);
      if (!declaration || !/(?:Action|Durable|Optimistic|Poll)/.test(declaration)) return;
      const names = ts.isInterfaceDeclaration(node)
        ? node.members.flatMap(member => {
            const name = propertyName(member);
            return name ? [name] : [];
          })
        : ts.isTypeAliasDeclaration(node)
          ? typeElementProperties(node.type)
          : [];
      properties.push(...names.map(property => ({ declaration, property })));
    });
  }
  return properties;
};

const clientIdentityReferences = (): string[] => {
  const references: string[] = [];
  for (const source of sourceEntries) {
    visit(source.file, node => {
      if (ts.isIdentifier(node) && /^client(?:Mutation)?Id$/i.test(node.text)) references.push(`${source.name}:${node.text}`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^client(?:Mutation)?Id$/i.test(node.text)) {
        references.push(`${source.name}:${node.text}`);
      }
    });
  }
  return references;
};

const forbiddenDeclarations = (): string[] => {
  const forbidden = new Set(['defineCommand', 'defineDetachedOperation']);
  const declarations: string[] = [];
  for (const source of sourceEntries) {
    visit(source.file, node => {
      const name = declarationName(node);
      if (name && (forbidden.has(name) || /(?:Action|Graphql).*Adapter/.test(name))) declarations.push(`${source.name}:${name}`);
    });
  }
  return declarations;
};

describe('model action surface discipline', () => {
  it('infers only the terminals owned by each action mode', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import * as dbl from '${entry}';
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
      type Expect<T extends true> = T;
      type Row = { id: string; label: string; status: 'pending' | 'done' };
      type Input = { id: string; label: string };
      type Data = { save: { row: Row } };
      type Variables = { input: Input };
      declare const document: TypedDocumentNode<Data, Variables>;
      const schema = dbl.defineShape<Row>()({ label: dbl.f.str(), status: dbl.f.enum(['pending', 'done'] as const) });
      const rows = dbl.defineModel('typed-action-terminals', {
        schema,
        maintenance: { dropTempRowsAfterMs: 60_000 },
        actions: owner => ({
          request: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input, context) => {
              type _RequestTempId = Expect<Equal<typeof context.tempId, string | null>>;
              type _RequestOperationId = Expect<Equal<typeof context.operationId, string>>;
              return { input };
            },
            root: {
              insert: {
                select: context => {
                  type _ResponseInput = Expect<Equal<typeof context.input, Input>>;
                  type _ResponseData = Expect<Equal<typeof context.data, Data>>;
                  return context.data.save.row;
                }
              }
            },
            write: (context, _plan) => {
              type _WriteInput = Expect<Equal<typeof context.input, Input>>;
              type _WriteData = Expect<Equal<typeof context.data, Data>>;
            }
          }),
          optimisticInsert: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input, _context) => ({ input }),
            optimistic: {
              root: {
                insert: {
                  select: context => {
                    type _OptimisticInput = Expect<Equal<typeof context.input, Input>>;
                    type _OptimisticTempId = Expect<Equal<typeof context.tempId, string>>;
                    type _OptimisticOperationId = Expect<Equal<typeof context.operationId, string>>;
                    return { id: context.tempId, label: context.input.label, status: 'pending' as const };
                  }
                }
              }
            },
            root: {
              insert: {
                select: context => {
                  type _ResponseInput = Expect<Equal<typeof context.input, Input>>;
                  type _ResponseData = Expect<Equal<typeof context.data, Data>>;
                  return context.data.save.row;
                }
              }
            }
          }),
          optimisticUpdate: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input, _context) => ({ input }),
            optimistic: {
              root: {
                update: {
                  select: context => {
                    type _OptimisticInput = Expect<Equal<typeof context.input, Input>>;
                    type _OptimisticTempId = Expect<Equal<typeof context.tempId, string>>;
                    type _OptimisticOperationId = Expect<Equal<typeof context.operationId, string>>;
                    return { id: context.input.id, patch: { label: context.input.label } };
                  }
                }
              }
            },
            root: {
              update: {
                select: context => {
                  type _ResponseInput = Expect<Equal<typeof context.input, Input>>;
                  type _ResponseData = Expect<Equal<typeof context.data, Data>>;
                  return { id: context.data.save.row.id, patch: context.data.save.row };
                }
              }
            }
          }),
          optimisticDestroy: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input, _context) => ({ input }),
            optimistic: {
              root: {
                destroy: {
                  select: context => {
                    type _OptimisticInput = Expect<Equal<typeof context.input, Input>>;
                    type _OptimisticTempId = Expect<Equal<typeof context.tempId, string>>;
                    type _OptimisticOperationId = Expect<Equal<typeof context.operationId, string>>;
                    return context.input.id;
                  }
                }
              }
            },
            root: {
              destroy: {
                select: context => {
                  type _ResponseInput = Expect<Equal<typeof context.input, Input>>;
                  type _ResponseData = Expect<Equal<typeof context.data, Data>>;
                  return context.data.save.row.id;
                }
              }
            }
          }),
          durable: owner.gql.action(document, {
            mode: 'durable',
            result: 'save',
            variables: (input: Input, _transportInput: { token: string }, context) => {
              type _DurableTempId = Expect<Equal<typeof context.tempId, string>>;
              type _DurableOperationId = Expect<Equal<typeof context.operationId, string>>;
              return { input };
            },
            optimistic: {
              root: {
                insert: {
                  select: context => {
                    type _OptimisticInput = Expect<Equal<typeof context.input, Input>>;
                    type _OptimisticTempId = Expect<Equal<typeof context.tempId, string>>;
                    type _OptimisticOperationId = Expect<Equal<typeof context.operationId, string>>;
                    return { id: context.tempId, label: context.input.label, status: 'pending' as const };
                  }
                }
              }
            },
            root: {
              insert: {
                select: context => {
                  type _ResponseInput = Expect<Equal<typeof context.input, Input>>;
                  type _ResponseData = Expect<Equal<typeof context.data, Data>>;
                  return context.data.save.row;
                }
              }
            }
          }),
          poll: owner.gql.action(document, {
            mode: 'poll',
            variables: (input: Input, context) => {
              type _PollSessionKey = Expect<Equal<typeof context.sessionKey, string>>;
              return { input };
            },
            root: {
              update: {
                select: data => {
                  type _PollData = Expect<Equal<typeof data, Data>>;
                  return { id: data.save.row.id, patch: data.save.row };
                }
              }
            },
            write: (data, _plan) => {
              type _PollWriteData = Expect<Equal<typeof data, Data>>;
            },
            poll: {
              key: input => {
                type _PollInput = Expect<Equal<typeof input, Input>>;
                return input.id;
              },
              intervalMs: 100,
              maxAttempts: 2,
              classify: data => {
                type _PollClassifyData = Expect<Equal<typeof data, Data>>;
                return data.save.row.status === 'done' ? 'ready' : null;
              }
            }
          })
        })
      });
      type _Public = Expect<Equal<Extract<keyof typeof dbl, 'gql' | 'defineCommand' | 'defineDetachedOperation'>, never>>;
      type _Request = Expect<Equal<keyof typeof rows.actions.request, 'run' | 'use'>>;
      type _OptimisticInsert = Expect<Equal<keyof typeof rows.actions.optimisticInsert, 'discard' | 'retry' | 'run' | 'use'>>;
      type _OptimisticUpdate = Expect<Equal<keyof typeof rows.actions.optimisticUpdate, 'discard' | 'retry' | 'run' | 'use'>>;
      type _OptimisticDestroy = Expect<Equal<keyof typeof rows.actions.optimisticDestroy, 'discard' | 'retry' | 'run' | 'use'>>;
      type _Durable = Expect<Equal<keyof typeof rows.actions.durable, 'resume' | 'start'>>;
      type _Poll = Expect<Equal<keyof typeof rows.actions.poll, 'run' | 'use'>>;
      type _NoDetachedModelTerminal = Expect<Equal<Extract<keyof typeof rows, 'detached'>, never>>;
      const requestResult = rows.actions.request.run({ id: 'row-1', label: 'row' });
      type _RequestResult = Expect<Equal<Awaited<typeof requestResult>, Data['save'] | null>>;
      const handle = rows.actions.durable.start({ id: 'row-1', label: 'row' });
      type _Handle = Expect<Equal<keyof typeof handle, 'cancel' | 'execute' | 'operationId' | 'tempId'>>;
      const durableResult = handle.execute({ token: 'token' });
      type _DurableResult = Expect<Equal<Awaited<typeof durableResult>, Data['save'] | null>>;
      void handle;
    `);

    expect(diagnosticsText(diagnostics)).toEqual([]);
  });

  it('rejects removed declaration fields and non-insert durable roots', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Input = { id: string; label: string };
      type Data = { save: { row: Row } };
      type Variables = { input: Input };
      declare const document: TypedDocumentNode<Data, Variables>;
      const schema = defineShape<Row>()({ label: f.str() });
      defineModel('object-actions-rejected', {
        schema,
        // @ts-expect-error actions must be an owner factory
        actions: { invalid: true }
      });
      const rows = defineModel('removed-action-fields', {
        schema,
        maintenance: { dropTempRowsAfterMs: 60_000 },
        actions: owner => ({
          kind: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            root: { insert: { select: context => context.data.save.row } },
            // @ts-expect-error action kind is derived from its owner terminal
            kind: 'insert'
          }),
          select: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            root: { insert: { select: context => context.data.save.row } },
            // @ts-expect-error response selection belongs to root
            select: (data: Data) => data.save.row
          }),
          id: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            root: { insert: { select: context => context.data.save.row } },
            // @ts-expect-error row identity belongs to root
            id: (data: Data) => data.save.row.id
          }),
          handler: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            root: { insert: { select: context => context.data.save.row } },
            // @ts-expect-error action landing uses root instead of handler
            handler: (data: Data) => data.save.row
          }),
          patches: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error optimistic status and patch callbacks are not public action fields
            optimistic: {
              status: () => 'failed',
              root: {
                insert: {
                  select: context => ({ id: context.tempId, label: context.input.label }),
                  onFailurePatch: () => ({ label: 'failed' }),
                  onRetryPatch: () => ({ label: 'pending' })
                }
              }
            },
            root: { insert: { select: context => context.data.save.row } }
          }),
          durableUpdate: owner.gql.action(document, {
            // @ts-expect-error durable actions accept optimistic insert roots only
            mode: 'durable',
            result: 'save',
            // @ts-expect-error durable actions accept optimistic insert roots only
            variables: (input: Input, _transportInput: { token: string }) => ({ input }),
            // @ts-expect-error durable actions accept optimistic insert roots only
            optimistic: { root: { update: { select: () => null } } },
            root: { update: { select: () => null } }
          }),
          durableDestroy: owner.gql.action(document, {
            // @ts-expect-error durable actions accept optimistic insert roots only
            mode: 'durable',
            result: 'save',
            // @ts-expect-error durable actions accept optimistic insert roots only
            variables: (input: Input, _transportInput: { token: string }) => ({ input }),
            // @ts-expect-error durable actions accept optimistic insert roots only
            optimistic: { root: { destroy: { select: () => null } } },
            root: { destroy: { select: () => null } }
          })
        })
      });
      const handle = rows.actions.durableUpdate.start({ id: 'row-1', label: 'row' });
      // @ts-expect-error consumer cannot complete with raw response data
      handle.complete({ save: { row: { id: 'row-1', label: 'row' } } });
      // @ts-expect-error consumer cannot set ledger status
      handle.setStatus('failed');
    `);

    expect(diagnosticsText(diagnostics)).toEqual([]);
  });

  it('rejects optimistic insert arrays and correlation on update or destroy', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Input = { id: string; label: string };
      type Data = { save: { row: Row } };
      type Variables = { input: Input };
      declare const document: TypedDocumentNode<Data, Variables>;
      const schema = defineShape<Row>()({ label: f.str() });
      defineModel('optimistic-action-restrictions', {
        schema,
        maintenance: { dropTempRowsAfterMs: 60_000 },
        actions: owner => ({
          insertArray: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error one action owns exactly one optimistic temp row
            optimistic: {
              root: {
                insert: {
                  select: () => [{ id: 'temp-row', label: 'label' }]
                }
              }
            },
            root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } }
          }),
          updateCorrelation: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error correlation is available only for optimistic insert
            optimistic: {
              root: {
                update: {
                  select: () => ({ id: 'row-1', patch: { label: 'label' } })
                }
              },
              correlate: () => 'row-1'
            },
            root: { update: { select: () => ({ id: 'row-1', patch: { label: 'label' } }) } }
          }),
          destroyCorrelation: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error correlation is available only for optimistic insert
            optimistic: {
              root: {
                destroy: {
                  select: () => 'row-1'
                }
              },
              correlate: () => 'row-1'
            },
            root: { destroy: { select: () => 'row-1' } }
          }),
          updateArray: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error one action owns exactly one optimistic update
            optimistic: { root: { update: { select: () => [{ id: 'row-1', patch: { label: 'label' } }] } } },
            root: { update: { select: () => ({ id: 'row-1', patch: { label: 'label' } }) } }
          }),
          destroyArray: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error one action owns exactly one optimistic destroy id
            optimistic: { root: { destroy: { select: () => ['row-1'] } } },
            root: { destroy: { select: () => 'row-1' } }
          }),
          mismatchedInsertResponse: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error optimistic insert must use a response insert root
            optimistic: { root: { insert: { select: () => ({ id: 'temp-row', label: 'label' }) } } },
            root: { update: { select: () => ({ id: 'row-1', patch: { label: 'label' } }) } }
          }),
          mismatchedUpdateResponse: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error optimistic update must use a response update root
            optimistic: { root: { update: { select: () => ({ id: 'row-1', patch: { label: 'label' } }) } } },
            root: { destroy: { select: () => 'row-1' } }
          }),
          mismatchedDestroyResponse: owner.gql.action(document, {
            mode: 'request',
            result: 'save',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error optimistic destroy must use a response destroy root
            optimistic: { root: { destroy: { select: () => 'row-1' } } },
            root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } }
          }),
          durableDedupe: owner.gql.action(document, {
            // @ts-expect-error durable actions do not accept request dedupe
            mode: 'durable',
            result: 'save',
            // @ts-expect-error durable actions do not accept request dedupe
            variables: (input: Input, _transportInput: { token: string }) => ({ input }),
            // @ts-expect-error durable actions do not accept request dedupe
            optimistic: { root: { insert: { select: () => ({ id: 'temp-row', label: 'label' }) } } },
            root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } },
            dedupe: false
          }),
          durableOnce: owner.gql.action(document, {
            // @ts-expect-error durable actions do not accept request once
            mode: 'durable',
            result: 'save',
            // @ts-expect-error durable actions do not accept request once
            variables: (input: Input, _transportInput: { token: string }) => ({ input }),
            // @ts-expect-error durable actions do not accept request once
            optimistic: { root: { insert: { select: () => ({ id: 'temp-row', label: 'label' }) } } },
            root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } },
            once: true
          }),
          pollOptimistic: owner.gql.action(document, {
            // @ts-expect-error poll actions do not accept optimistic declarations
            mode: 'poll',
            variables: (input: Input) => ({ input }),
            // @ts-expect-error poll actions do not accept optimistic declarations
            optimistic: { root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } } },
            root: { insert: { select: () => ({ id: 'row-1', label: 'label' }) } },
            poll: { key: () => 'poll-key', intervalMs: 100, maxAttempts: 2 }
          })
        })
      });
    `);

    expect(diagnosticsText(diagnostics)).toEqual([]);
  });

  it('removes legacy action surfaces and client identity from source declarations', () => {
    const exports = publicExports();
    const bannedProperties = new Set(['kind', 'select', 'id', 'handler', 'onFailurePatch', 'onRetryPatch', 'complete', 'setStatus']);
    const leakedProperties = actionTypeProperties().filter(({ property }) => bannedProperties.has(property));
    const sourceNames = sourceEntries.map(source => source.name);

    expect(exports).not.toEqual(expect.arrayContaining(['gql', 'defineCommand', 'defineDetachedOperation']));
    expect(sourceNames).not.toEqual(expect.arrayContaining(['dsl/defineCommand.ts', 'dsl/defineDetachedOperation.ts']));
    expect(leakedProperties).toEqual([]);
    expect(clientIdentityReferences()).toEqual([]);
    expect(forbiddenDeclarations()).toEqual([]);
  });
});
