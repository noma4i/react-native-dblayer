import { act } from 'react-test-renderer';
import { configureDb, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';
import { createAppModels } from './appModels';

const write = (model: any, row: unknown): void => model.insert(row);
const writeMany = (model: any, rows: unknown[]): void => model.insertMany(rows);

const chatRow = (id: string, lastActivityAt = '2026-07-26T00:00:00Z') => ({ id, kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt, userIds: [], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' });

const messageRows = (chatId: string, count: number, offset = 0) => Array.from({ length: count }, (_, index) => ({ id: `${chatId}-message-${index + offset}`, chatId, userId: 'other', kind: 'text', body: `body-${index + offset}`, createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z', sequenceNumber: index + offset }));

const seedAccountScale = (models: ReturnType<typeof createAppModels>): void => {
  write(models.currentUser, { id: 'current-scale', uuid: 'current-scale', fullName: 'Current Scale', username: 'current-scale', online: true, createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z', registrationCompleted: true, balance: 0, filterGender: 'all', filterMinAge: 18, filterMaxAge: 99, kind: 'user', hasCompass: false, hasMoments: false, hasPhoto: false, hasGoodPhoto: false, hasInitialMoment: false, stickyLocation: false, status: 'active', preferenceNotifyConnection: true, preferenceNotifyMessage: true, preferenceVibration: true, receivedGifts: [] });
  writeMany(models.chats, Array.from({ length: 10 }, (_, index) => chatRow(`chat-${index}`, `2026-07-26T00:00:${String(index).padStart(2, '0')}Z`)));
  writeMany(models.messages, Array.from({ length: 10 }, (_, chatIndex) => messageRows(`chat-${chatIndex}`, 300)).flat());
};

describe('app-shaped speed contracts', () => {
  it('P1 inserts 1000 messages into one mounted thread window in two renders with constant fanout work', () => {
    const insertWork = (count: number) => {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const models = createAppModels(`SpeedP1-${count}`);
      write(models.chats, chatRow('chat-1'));
      const reader = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: 30 }));
      diagnostics().reset();
      act(() => writeMany(models.messages, messageRows('chat-1', count)));
      const work = diagnostics().snapshot();
      expect(reader.result().rows).toHaveLength(Math.min(count, 30));
      const renders = reader.renders();
      reader.unmount();
      return { work, renders };
    };
    const single = insertWork(1);
    const batch = insertWork(1000);

    expect(batch.renders).toBeLessThanOrEqual(2);
    expect(batch.work.commits).toBe(1);
    expect(batch.work.commits).toBe(single.work.commits);
    expect(batch.work.commitFanoutCandidates).toBe(single.work.commitFanoutCandidates);
    expect(batch.work.commitFanoutNotified).toBe(single.work.commitFanoutNotified);
    expect(batch.work.readEngineApplies).toBe(single.work.readEngineApplies);
  });

  it('P2 patches one row in a 10000-row model without rendering three foreign thread windows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('SpeedP2');
    writeMany(models.chats, ['target', 'foreign-a', 'foreign-b', 'foreign-c'].map(id => chatRow(id)));
    writeMany(models.messages, [
      ...messageRows('target', 9997),
      ...messageRows('foreign-a', 1),
      ...messageRows('foreign-b', 1),
      ...messageRows('foreign-c', 1)
    ]);
    const foreignReaders = ['foreign-a', 'foreign-b', 'foreign-c'].map(chatId => renderCounted(() => models.messages.scopes.thread.useWindow({ chatId }, { pageSize: 30 })));
    const before = foreignReaders.map(reader => reader.renders());
    diagnostics().reset();
    act(() => {
      models.messages.update('target-message-0', { body: 'patched' });
    });
    const work = diagnostics().snapshot();
    foreignReaders.forEach((reader, index) => expect(reader.renders() - before[index]!).toBe(0));
    foreignReaders.forEach(reader => reader.unmount());
    expect(work.commits).toBe(1);
    expect(work.commitFanoutNotified).toBe(0);
    expect(work.readEngineApplies).toBe(0);
  });

  it('P3 resets and refills ten 300-message chats with repeatable work counters', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('SpeedP3');
    const refillWork = () => {
      act(() => {
        resetRuntime();
        seedAccountScale(models);
      });
      expect(models.messages.scopes.thread.read({ chatId: 'chat-0' })).toHaveLength(300);
      return diagnostics().snapshot();
    };
    const first = refillWork();
    const second = refillWork();

    expect(second.commits).toBe(first.commits);
    expect(second.commitFanoutCandidates).toBe(first.commitFanoutCandidates);
    expect(second.commitFanoutNotified).toBe(first.commitFanoutNotified);
    expect(second.readEngineApplies).toBe(first.readEngineApplies);
    expect(second.mirrorScopePasses).toBe(first.mirrorScopePasses);
    expect(first.commits).toBe(3);
  });
});
