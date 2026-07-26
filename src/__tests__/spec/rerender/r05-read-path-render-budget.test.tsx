import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo, defineModel, f, hasMany, hasOne, scope } from '../../../index';
import { setupSpecRuntime, diagnostics } from '../helpers/harness';

type ScopeRow = { id: string; groupId: string; title: string };
type ProjectedScopeRow = { id: string; title: string };
type AuthorRow = { id: string; name: string };
type PostRow = { id: string; authorId: string; title: string };
type ChildRow = { id: string; parentId: string; title: string; rank: number };

const createScopeRows = () =>
  defineModel({
    id: 'SpecReadPathBudgetScopeRows',
    name: 'SpecReadPathBudgetScopeRows',
    fields: { groupId: f.str(), title: f.str() },
    scopes: {
      byGroup: scope<ScopeRow>({ by: { groupId: 'groupId' } })
    }
  });

const createRelatedRows = () => {
  const authors = defineModel({
    id: 'SpecReadPathBudgetAuthors',
    name: 'SpecReadPathBudgetAuthors',
    fields: { name: f.str() }
  });
  const posts = defineModel({
    id: 'SpecReadPathBudgetPosts',
    name: 'SpecReadPathBudgetPosts',
    fields: { authorId: f.str(), title: f.str() },
    relations: () => ({ author: belongsTo(authors, { foreignKey: 'authorId' }) })
  });
  return { authors, posts };
};

const createCollectionRelations = () => {
  const children = defineModel({
    id: 'SpecReadPathBudgetChildren',
    name: 'SpecReadPathBudgetChildren',
    fields: { parentId: f.str(), title: f.str(), rank: f.num() }
  });
  const parents = defineModel({
    id: 'SpecReadPathBudgetParents',
    name: 'SpecReadPathBudgetParents',
    fields: { name: f.str() },
    relations: () => ({
      children: hasMany(children, { foreignKey: 'parentId' }),
      firstChild: hasOne(children, { foreignKey: 'parentId', comparator: (left, right) => Number(left.rank) - Number(right.rank) })
    })
  });
  return { children, parents };
};

const createFanoutRows = (suffix: string) =>
  defineModel({
    id: `SpecReadPathBudgetFanout${suffix}`,
    name: `SpecReadPathBudgetFanout${suffix}`,
    fields: { value: f.num() }
  });

const rerender = (force: () => void, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    act(() => {
      force();
    });
  }
};

describe('read path render budget', () => {
  it('does zero scope projection work across idle parent rerenders and keeps the array identity', () => {
    setupSpecRuntime();
    const rows = createScopeRows();
    rows.insertStoredMany(Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, groupId: 'group-1', title: `title-${index}` })));

    let selectCalls = 0;
    const select = (row: ScopeRow): ProjectedScopeRow => {
      selectCalls += 1;
      return { id: row.id, title: row.title };
    };
    let result!: ProjectedScopeRow[];
    let force!: () => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [, setRevision] = React.useState(0);
      force = () => setRevision(current => current + 1);
      result = rows.scopes.byGroup.use({ groupId: 'group-1' }, { select });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const initial = result;
    selectCalls = 0;

    rerender(force, 5);

    expect(selectCalls).toBe(0);
    expect(result).toBe(initial);
    act(() => root.unmount());
  });

  it('projects a changed scope snapshot once and preserves unaffected row identities', () => {
    setupSpecRuntime();
    const rows = createScopeRows();
    rows.insertStoredMany(Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, groupId: 'group-1', title: `title-${index}` })));

    let selectCalls = 0;
    const select = (row: ScopeRow): ProjectedScopeRow => {
      selectCalls += 1;
      return { id: row.id, title: row.title };
    };
    let result!: ProjectedScopeRow[];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = rows.scopes.byGroup.use({ groupId: 'group-1' }, { select });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const initial = result;
    selectCalls = 0;

    act(() => {
      rows.patch('row-25', { title: 'updated' });
    });

    expect(selectCalls).toBe(50);
    expect(result).not.toBe(initial);
    expect(result.map((row, index) => row === initial[index])).toEqual(initial.map((_, index) => index !== 25));
    act(() => root.unmount());
  });

  it('recomputes a related reader only for a dependency commit or dependency signature change', () => {
    setupSpecRuntime();
    const { authors, posts } = createRelatedRows();
    authors.insertStoredMany([
      { id: 'author-1', name: 'One' },
      { id: 'author-2', name: 'Two' }
    ]);
    posts.insertStoredMany([
      { id: 'post-1', authorId: 'author-1', title: 'First' },
      { id: 'post-2', authorId: 'author-2', title: 'Second' }
    ]);

    let reads = 0;
    const get = authors.get;
    authors.get = ((id: string | null | undefined) => {
      reads += 1;
      return get(id);
    }) as typeof authors.get;

    let result!: AuthorRow | undefined;
    let force!: () => void;
    let setPostId!: (id: string) => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [postId, setCurrentPostId] = React.useState('post-1');
      const [, setRevision] = React.useState(0);
      force = () => setRevision(current => current + 1);
      setPostId = setCurrentPostId;
      result = posts.use.related(postId, 'author') as AuthorRow | undefined;
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const afterMount = reads;

    rerender(force, 5);

    expect(reads).toBe(afterMount);
    act(() => {
      authors.patch('author-1', { name: 'One Updated' });
    });
    expect(reads).toBe(afterMount + 1);
    expect(result?.name).toBe('One Updated');

    act(() => {
      setPostId('post-2');
    });
    expect(reads).toBe(afterMount + 2);
    expect(result?.name).toBe('Two');
    act(() => root.unmount());
  });

  it('switches hasMany rows immediately when the parent id changes without a commit', () => {
    setupSpecRuntime();
    const { children, parents } = createCollectionRelations();
    parents.insertStoredMany([
      { id: 'parent-a', name: 'A' },
      { id: 'parent-b', name: 'B' }
    ]);
    children.insertStoredMany([
      { id: 'child-a', parentId: 'parent-a', title: 'A child', rank: 1 },
      { id: 'child-b', parentId: 'parent-b', title: 'B child', rank: 1 }
    ]);

    let result!: ChildRow[];
    let setParentId!: (id: string) => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [parentId, setCurrentParentId] = React.useState('parent-a');
      setParentId = setCurrentParentId;
      result = parents.use.related(parentId, 'children') as ChildRow[];
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    expect(result.map(row => row.id)).toEqual(['child-a']);

    act(() => {
      setParentId('parent-b');
    });

    expect(result.map(row => row.id)).toEqual(['child-b']);
    act(() => root.unmount());
  });

  it('switches hasOne rows immediately when the parent id changes without a commit', () => {
    setupSpecRuntime();
    const { children, parents } = createCollectionRelations();
    parents.insertStoredMany([
      { id: 'parent-a', name: 'A' },
      { id: 'parent-b', name: 'B' }
    ]);
    children.insertStoredMany([
      { id: 'child-a', parentId: 'parent-a', title: 'A child', rank: 1 },
      { id: 'child-b', parentId: 'parent-b', title: 'B child', rank: 1 }
    ]);

    let result!: ChildRow | undefined;
    let setParentId!: (id: string) => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [parentId, setCurrentParentId] = React.useState('parent-a');
      setParentId = setCurrentParentId;
      result = parents.use.related(parentId, 'firstChild') as ChildRow | undefined;
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    expect(result?.id).toBe('child-a');

    act(() => {
      setParentId('parent-b');
    });

    expect(result?.id).toBe('child-b');
    act(() => root.unmount());
  });

  it('adds a newly matching hasMany row to a related reader', () => {
    setupSpecRuntime();
    const { children, parents } = createCollectionRelations();
    parents.insertStored({ id: 'parent-1', name: 'Parent' });
    children.insertStored({ id: 'child-1', parentId: 'parent-1', title: 'First', rank: 1 });
    let result!: ChildRow[];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = parents.use.related('parent-1', 'children') as ChildRow[];
      return null;
    };
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    expect(result.map(row => row.id)).toEqual(['child-1']);
    act(() => children.insertStored({ id: 'child-2', parentId: 'parent-1', title: 'Second', rank: 2 }));
    expect(result.map(row => row.id)).toEqual(['child-1', 'child-2']);
    act(() => root.unmount());
  });

  it('updates a shared foreign-key index before related readers observe an unrelated insert', () => {
    setupSpecRuntime();
    const { children, parents } = createCollectionRelations();
    parents.insertStoredMany([
      { id: 'parent-1', name: 'One' },
      { id: 'parent-2', name: 'Two' }
    ]);
    children.insertStoredMany([
      { id: 'child-1', parentId: 'parent-1', title: 'One', rank: 1 },
      { id: 'child-2', parentId: 'parent-2', title: 'Two', rank: 1 }
    ]);
    let result!: ChildRow[];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = parents.use.related('parent-1', 'children') as ChildRow[];
      return null;
    };
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const initial = result;
    act(() => children.insertStored({ id: 'outside', parentId: 'outside', title: 'Outside', rank: 1 }));
    expect(result).toBe(initial);
    act(() => root.unmount());
  });

  it('moves related rows between shared foreign-key buckets', () => {
    setupSpecRuntime();
    const { children, parents } = createCollectionRelations();
    parents.insertStoredMany([
      { id: 'parent-1', name: 'One' },
      { id: 'parent-2', name: 'Two' }
    ]);
    children.insertStored({ id: 'child-1', parentId: 'parent-1', title: 'First', rank: 1 });
    let result!: [ChildRow[], ChildRow[]];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = [parents.use.related('parent-1', 'children') as ChildRow[], parents.use.related('parent-2', 'children') as ChildRow[]];
      return null;
    };
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    act(() => children.patch('child-1', { parentId: 'parent-2' }));
    expect(result.map(rows => rows.map(row => row.id))).toEqual([[], ['child-1']]);
    act(() => root.unmount());
  });

  it('does not apply read engines during idle parent rerenders', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const rows = createScopeRows();
    rows.insertStored({ id: 'row-1', groupId: 'group-1', title: 'Title' });

    let force!: () => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [, setRevision] = React.useState(0);
      force = () => setRevision(current => current + 1);
      rows.use.where({ groupId: 'group-1' }).rows();
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const before = diagnostics().snapshot().readEngineApplies;

    rerender(force, 5);

    expect(diagnostics().snapshot().readEngineApplies).toBe(before);
    act(() => root.unmount());
  });

  it('limits commit fanout candidates to subscribers of the changed model', () => {
    setupSpecRuntime();
    const modelA = createFanoutRows('A');
    const modelB = createFanoutRows('B');
    const countA = 6;
    const countB = 4;
    modelA.insertStoredMany(Array.from({ length: countA }, (_, index) => ({ id: `a-${index}`, value: index })));
    modelB.insertStoredMany(Array.from({ length: countB }, (_, index) => ({ id: `b-${index}`, value: index })));
    diagnostics().reset();

    let modelARenders = 0;
    let root!: TestRenderer.ReactTestRenderer;
    const ModelAReader = ({ id }: { id: string }) => {
      modelA.use.field(id, 'value');
      modelARenders += 1;
      return null;
    };
    const ModelBReader = ({ id }: { id: string }) => {
      modelB.use.field(id, 'value');
      return null;
    };

    act(() => {
      root = TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          ...Array.from({ length: countA }, (_, index) => React.createElement(ModelAReader, { key: `a-${index}`, id: `a-${index}` })),
          ...Array.from({ length: countB }, (_, index) => React.createElement(ModelBReader, { key: `b-${index}`, id: `b-${index}` }))
        )
      );
    });
    const beforeModelARenders = modelARenders;

    act(() => {
      modelB.patch('b-0', { value: 100 });
    });

    const snapshot = diagnostics().snapshot();
    expect(snapshot.commitFanoutCandidates).toBe(countB);
    expect(snapshot.commitFanoutNotified).toBeLessThanOrEqual(countB);
    expect(modelARenders).toBe(beforeModelARenders);
    act(() => root.unmount());
  });

  it('moves a subscriber to the next model bucket when its dependencies change', () => {
    setupSpecRuntime();
    const modelA = createFanoutRows('MoveA');
    const modelB = createFanoutRows('MoveB');
    modelA.insertStored({ id: 'row', value: 1 });
    modelB.insertStored({ id: 'row', value: 2 });

    let renders = 0;
    let setActiveModel!: (model: 'a' | 'b') => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [activeModel, setCurrentModel] = React.useState<'a' | 'b'>('a');
      setActiveModel = setCurrentModel;
      const model = activeModel === 'a' ? modelA : modelB;
      model.use.field('row', 'value');
      renders += 1;
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    act(() => {
      setActiveModel('b');
    });
    const beforeCommits = renders;

    act(() => {
      modelA.patch('row', { value: 3 });
    });
    expect(renders).toBe(beforeCommits);
    act(() => {
      modelB.patch('row', { value: 4 });
    });
    expect(renders).toBe(beforeCommits + 1);
    act(() => root.unmount());
  });

  it('keeps multi-scope membership content stable', () => {
    setupSpecRuntime();
    const rows = createScopeRows();
    const groupIds = ['group-0', 'group-1', 'group-2', 'group-3', 'group-4', 'group-5'];
    rows.insertStoredMany(groupIds.map((groupId, index) => ({ id: `row-${index}`, groupId, title: groupId })));

    let result!: ProjectedScopeRow[][];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = groupIds.map(groupId => rows.scopes.byGroup.use({ groupId }));
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });

    expect(result.map(scopeRows => scopeRows.map(row => row.id))).toEqual(groupIds.map((_, index) => [`row-${index}`]));
    act(() => root.unmount());
  });

});
