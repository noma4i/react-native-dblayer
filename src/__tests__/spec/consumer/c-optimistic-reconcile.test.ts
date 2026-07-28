import { configureDb, defineModel, f, generateTempId, reconcileOptimisticRows } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type StoredRow = { id: string; chatId: string; text: string; createdAt: string };
type ServerNode = { id: string; chatId: string; text: string; createdAt: string };
type MappedNode = { id: string; threadId: string; createdAt: string };

/**
 * Behavioral contracts for `reconcileOptimisticRows`: candidate resolution (function, shared fields,
 * fieldMap), temp-id gating, createdAt window and ranking, match predicate, and onExisting policy.
 */
const createRows = (suffix: string) => {
  configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
  return defineModel({
    id: `SpecReconcile${suffix}`,
    name: `SpecReconcile${suffix}`,
    fields: { chatId: f.str(), text: f.str(), createdAt: f.str() },
    maintenance: { dropTempRowsAfterMs: 1000 }
  });
};

const insertTemp = (rows: ReturnType<typeof createRows>, values: Omit<StoredRow, 'id'>): string => {
  const tempId = generateTempId();
  rows.insert({ id: tempId, ...values });
  return tempId;
};

describe('optimistic reconcile contracts', () => {
  it('silently drops a node whose id already exists in the model by default', () => {
    const rows = createRows('DropExisting');
    rows.insert({ id: 'server-1', chatId: 'chat-1', text: 'applied', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'echo', createdAt: '2026-07-28T00:00:00Z' }], {
      resolveCandidates: () => [],
      match: () => true,
      commit
    });

    expect(unmatched).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('returns an existing-id node untouched when onExisting is return', () => {
    const rows = createRows('ReturnExisting');
    rows.insert({ id: 'server-1', chatId: 'chat-1', text: 'applied', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();
    const echo: ServerNode = { id: 'server-1', chatId: 'chat-1', text: 'echo', createdAt: '2026-07-28T00:00:00Z' };

    const unmatched = reconcileOptimisticRows(rows, [echo], {
      resolveCandidates: () => [],
      match: () => true,
      commit,
      onExisting: 'return'
    });

    expect(unmatched).toEqual([echo]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('resolves candidates through shared scope fields so other buckets never match', () => {
    const rows = createRows('Fields');
    const tempId = insertTemp(rows, { chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    insertTemp(rows, { chatId: 'chat-2', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows<StoredRow, ServerNode>(
      rows,
      [
        { id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:01Z' },
        { id: 'server-2', chatId: 'chat-9', text: 'hello', createdAt: '2026-07-28T00:00:01Z' }
      ],
      { resolveCandidates: { fields: ['chatId'] }, match: () => true, commit }
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(tempId, expect.objectContaining({ id: 'server-1' }));
    expect(unmatched.map(node => node.id)).toEqual(['server-2']);
  });

  it('maps node fields onto stored fields through fieldMap', () => {
    const rows = createRows('FieldMap');
    const tempId = insertTemp(rows, { chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    insertTemp(rows, { chatId: 'chat-2', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    reconcileOptimisticRows<StoredRow, MappedNode>(rows, [{ id: 'server-1', threadId: 'chat-1', createdAt: '2026-07-28T00:00:01Z' }], {
      resolveCandidates: { fieldMap: { chatId: 'threadId' } },
      match: () => true,
      commit
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(tempId, expect.objectContaining({ id: 'server-1' }));
  });

  it('never treats a non-temp row as a candidate by default', () => {
    const rows = createRows('NonTemp');
    rows.insert({ id: 'stable-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:01Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      match: () => true,
      commit
    });

    expect(commit).not.toHaveBeenCalled();
    expect(unmatched.map(node => node.id)).toEqual(['server-1']);
  });

  it('lets isCandidate widen matching to non-temp rows', () => {
    const rows = createRows('Widen');
    rows.insert({ id: 'stable-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:01Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      isCandidate: candidate => candidate.id === 'stable-1',
      match: () => true,
      commit
    });

    expect(commit).toHaveBeenCalledWith('stable-1', expect.objectContaining({ id: 'server-1' }));
  });

  it('excludes candidates whose createdAt gap exceeds createdAtWindowMs', () => {
    const rows = createRows('Window');
    insertTemp(rows, { chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:10Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      match: () => true,
      createdAtWindowMs: 5000,
      commit
    });

    expect(commit).not.toHaveBeenCalled();
    expect(unmatched.map(node => node.id)).toEqual(['server-1']);
  });

  it('never ranks a candidate with an unparseable createdAt as a match', () => {
    const rows = createRows('NaN');
    insertTemp(rows, { chatId: 'chat-1', text: 'hello', createdAt: 'not-a-date' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:01Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      match: () => true,
      commit
    });

    expect(commit).not.toHaveBeenCalled();
    expect(unmatched.map(node => node.id)).toEqual(['server-1']);
  });

  it('commits the candidate closest by createdAt when several match', () => {
    const rows = createRows('Ranking');
    insertTemp(rows, { chatId: 'chat-1', text: 'far', createdAt: '2026-07-28T00:00:00Z' });
    const nearTempId = insertTemp(rows, { chatId: 'chat-1', text: 'near', createdAt: '2026-07-28T00:00:04Z' });
    const commit = jest.fn();

    reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:05Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      match: () => true,
      commit
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(nearTempId, expect.objectContaining({ id: 'server-1' }));
  });

  it('leaves a node unmatched when the match predicate rejects every candidate', () => {
    const rows = createRows('MatchReject');
    insertTemp(rows, { chatId: 'chat-1', text: 'hello', createdAt: '2026-07-28T00:00:00Z' });
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows<StoredRow, ServerNode>(rows, [{ id: 'server-1', chatId: 'chat-1', text: 'other', createdAt: '2026-07-28T00:00:01Z' }], {
      resolveCandidates: { fields: ['chatId'] },
      match: (candidate, node) => candidate.text === node.text,
      commit
    });

    expect(commit).not.toHaveBeenCalled();
    expect(unmatched.map(node => node.id)).toEqual(['server-1']);
  });
});
