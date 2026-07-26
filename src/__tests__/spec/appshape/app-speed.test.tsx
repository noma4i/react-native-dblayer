import { act } from 'react-test-renderer';
import { configureDb, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, median, renderCounted } from '../helpers/harness';
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
  it('P1 inserts 1000 messages into one mounted thread window within the measured budget and two renders', () => {
    const samples: number[] = [];
    const renderSamples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const models = createAppModels(`SpeedP1-${sample}`);
      write(models.chats, chatRow('chat-1'));
      const reader = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: 30 }));
      const started = performance.now();
      act(() => writeMany(models.messages, messageRows('chat-1', 1000)));
      samples.push(performance.now() - started);
      renderSamples.push(reader.renders());
      expect(reader.result().rows).toHaveLength(30);
      reader.unmount();
    }
    const elapsed = median(samples);
    const renders = Math.max(...renderSamples);
    console.log(`P1 insertMany-1000 median=${elapsed.toFixed(3)}ms renders=${renders}`);
    expect(elapsed).toBeLessThanOrEqual(150);
    expect(renders).toBeLessThanOrEqual(2);
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
    const samples = Array.from({ length: 7 }, (_, index) => {
      const started = performance.now();
      act(() => models.messages.update('target-message-0', { body: `patched-${index}` }));
      return performance.now() - started;
    });
    const elapsed = median(samples);
    console.log(`P2 point-patch-10000 median=${elapsed.toFixed(3)}ms`);
    foreignReaders.forEach((reader, index) => expect(reader.renders() - before[index]!).toBe(0));
    foreignReaders.forEach(reader => reader.unmount());
    expect(elapsed).toBeLessThanOrEqual(5);
  });

  it('P3 resets and refills ten 300-message chats within the measured account-switch budget', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('SpeedP3');
    const samples = Array.from({ length: 5 }, () => {
      const started = performance.now();
      act(() => {
        resetRuntime();
        seedAccountScale(models);
      });
      expect(models.messages.scopes.thread.read({ chatId: 'chat-0' })).toHaveLength(300);
      return performance.now() - started;
    });
    const elapsed = median(samples);
    console.log(`P3 reset-refill-3000 median=${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThanOrEqual(250);
  });
});
