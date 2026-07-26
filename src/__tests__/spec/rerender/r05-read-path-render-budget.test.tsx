import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo, defineModel, f, hasMany, hasOne, scope } from '../../../index';
import { setupSpecRuntime, diagnostics } from '../helpers/harness';

type ScopeRow = { id: string; groupId: string; title: string };
type ProjectedScopeRow = { id: string; title: string };
type AuthorRow = { id: string; name: string };
type PostRow = { id: string; authorId: string; title: string };
type ChildRow = { id: string; parentId: string; title: string; rank: number };
type ViewRow = { id: string; groupId: string; title: string };
type CommentRow = { id: string; parentId: string; body: string };

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

const createViewRelations = () => {
  const comments = defineModel({
    id: 'SpecReadPathBudgetComments',
    name: 'SpecReadPathBudgetComments',
    fields: { parentId: f.str(), body: f.str() }
  });
  const rows = defineModel({
    id: 'SpecReadPathBudgetViewRows',
    name: 'SpecReadPathBudgetViewRows',
    fields: { groupId: f.str(), title: f.str() },
    scopes: { byGroup: scope<ViewRow>({ by: { groupId: 'groupId' } }) },
    relations: () => ({ comments: hasMany(comments, { foreignKey: 'parentId' }) })
  });
  return { comments, rows };
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
    rows.insertMany(Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, groupId: 'group-1', title: `title-${index}` })));

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
    rows.insertMany(Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, groupId: 'group-1', title: `title-${index}` })));

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
      rows.update('row-25', { title: 'updated' });
    });

    expect(selectCalls).toBe(50);
    expect(result).not.toBe(initial);
    expect(result.map((row, index) => row === initial[index])).toEqual(initial.map((_, index) => index !== 25));
    act(() => root.unmount());
  });

  it('recomputes a related reader only for a dependency commit or dependency signature change', () => {
    setupSpecRuntime();
    const { authors, posts } = createRelatedRows();
    authors.insertMany([
      { id: 'author-1', name: 'One' },
      { id: 'author-2', name: 'Two' }
    ]);
    posts.insertMany([
      { id: 'post-1', authorId: 'author-1', title: 'First' },
      { id: 'post-2', authorId: 'author-2', title: 'Second' }
    ]);

    let reads = 0;
    const find = authors.find;
    authors.find = ((id: string | null | undefined) => {
      reads += 1;
      return find(id);
    }) as typeof authors.find;

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
      authors.update('author-1', { name: 'One Updated' });
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
    parents.insertMany([
      { id: 'parent-a', name: 'A' },
      { id: 'parent-b', name: 'B' }
    ]);
    children.insertMany([
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
    parents.insertMany([
      { id: 'parent-a', name: 'A' },
      { id: 'parent-b', name: 'B' }
    ]);
    children.insertMany([
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

  it('adds a newly matching hasMany include to a view', () => {
    setupSpecRuntime();
    const { comments, rows } = createViewRelations();
    rows.insert({ id: 'row-1', groupId: 'group-1', title: 'Row' });
    comments.insert({ id: 'comment-1', parentId: 'row-1', body: 'First' });
    const view = rows.view<{ id: string; comments: CommentRow[] }, { comments: CommentRow[] }>('comments', {
      source: rows.scopes.byGroup,
      include: { comments: 'comments' },
      select: (row, included) => ({ id: row.id, comments: included.comments as CommentRow[] })
    });

    let result!: Array<{ id: string; comments: CommentRow[] }>;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = view.use({ groupId: 'group-1' });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    expect(result[0]?.comments.map(comment => comment.id)).toEqual(['comment-1']);

    act(() => {
      comments.insert({ id: 'comment-2', parentId: 'row-1', body: 'Second' });
    });

    expect(result[0]?.comments.map(comment => comment.id)).toEqual(['comment-1', 'comment-2']);
    act(() => root.unmount());
  });

  it('does not apply read engines during idle parent rerenders', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const rows = createScopeRows();
    rows.insert({ id: 'row-1', groupId: 'group-1', title: 'Title' });

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
    modelA.insertMany(Array.from({ length: countA }, (_, index) => ({ id: `a-${index}`, value: index })));
    modelB.insertMany(Array.from({ length: countB }, (_, index) => ({ id: `b-${index}`, value: index })));
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
      modelB.update('b-0', { value: 100 });
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
    modelA.insert({ id: 'row', value: 1 });
    modelB.insert({ id: 'row', value: 2 });

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
      modelA.update('row', { value: 3 });
    });
    expect(renders).toBe(beforeCommits);
    act(() => {
      modelB.update('row', { value: 4 });
    });
    expect(renders).toBe(beforeCommits + 1);
    act(() => root.unmount());
  });

  it('keeps multi-scope membership content stable', () => {
    setupSpecRuntime();
    const rows = createScopeRows();
    const groupIds = ['group-0', 'group-1', 'group-2', 'group-3', 'group-4', 'group-5'];
    rows.insertMany(groupIds.map((groupId, index) => ({ id: `row-${index}`, groupId, title: groupId })));

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

  it('does not evaluate a hasMany view across idle parent rerenders', () => {
    setupSpecRuntime();
    const { comments, rows } = createViewRelations();
    rows.insertMany(Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, groupId: 'group-1', title: `Row ${index}` })));
    comments.insertMany(Array.from({ length: 50 }, (_, index) => ({ id: `comment-${index}`, parentId: `row-${index}`, body: `Comment ${index}` })));

    let selectCalls = 0;
    const view = rows.view<{ id: string; comments: CommentRow[] }, { comments: CommentRow[] }>('idle-comments', {
      source: rows.scopes.byGroup,
      include: { comments: 'comments' },
      select: (row, included) => {
        selectCalls += 1;
        return { id: row.id, comments: included.comments as CommentRow[] };
      }
    });
    let result!: Array<{ id: string; comments: CommentRow[] }>;
    let force!: () => void;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      const [, setRevision] = React.useState(0);
      force = () => setRevision(current => current + 1);
      result = view.use({ groupId: 'group-1' });
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

  it('updates a shared foreign-key index before a related view recomputes', () => {
    setupSpecRuntime();
    const { comments, rows } = createViewRelations();
    rows.insertMany([
      { id: 'row-1', groupId: 'group-1', title: 'One' },
      { id: 'row-2', groupId: 'group-1', title: 'Two' }
    ]);
    comments.insertMany([
      { id: 'comment-1', parentId: 'row-1', body: 'One' },
      { id: 'comment-2', parentId: 'row-2', body: 'Two' }
    ]);

    let selectCalls = 0;
    const view = rows.view<{ id: string; comments: CommentRow[] }, { comments: CommentRow[] }>('shared-index-comments', {
      source: rows.scopes.byGroup,
      include: { comments: 'comments' },
      select: (row, included) => {
        selectCalls += 1;
        return { id: row.id, comments: included.comments as CommentRow[] };
      }
    });
    let result!: Array<{ id: string; comments: CommentRow[] }>;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = view.use({ groupId: 'group-1' });
      return null;
    };

    diagnostics().reset();
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const initial = result;
    selectCalls = 0;

    act(() => {
      comments.insert({ id: 'comment-outside', parentId: 'outside', body: 'Outside' });
    });

    const snapshot = diagnostics().snapshot();
    expect(result).toBe(initial);
    expect(selectCalls).toBeLessThanOrEqual(2);
    expect(snapshot.fkIndexFullBuilds).toBe(1);
    expect(snapshot.fkIndexIncrementalUpdates).toBe(1);
    act(() => root.unmount());
  });

  it('moves related rows between shared foreign-key buckets', () => {
    setupSpecRuntime();
    const { comments, rows } = createViewRelations();
    rows.insertMany([
      { id: 'row-1', groupId: 'group-1', title: 'One' },
      { id: 'row-2', groupId: 'group-1', title: 'Two' }
    ]);
    comments.insert({ id: 'comment-1', parentId: 'row-1', body: 'First' });
    const view = rows.view<{ id: string; comments: CommentRow[] }, { comments: CommentRow[] }>('transfer-comments', {
      source: rows.scopes.byGroup,
      include: { comments: 'comments' },
      select: (row, included) => ({ id: row.id, comments: included.comments as CommentRow[] })
    });
    let result!: Array<{ id: string; comments: CommentRow[] }>;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      result = view.use({ groupId: 'group-1' });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    act(() => {
      comments.update('comment-1', { parentId: 'row-2' });
    });

    expect(result.map(item => item.comments.map(comment => comment.id))).toEqual([[], ['comment-1']]);
    act(() => root.unmount());
  });
});
