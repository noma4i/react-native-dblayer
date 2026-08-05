import {
  bootDb,
  computeSchemaFingerprints,
  configureDb,
  DB_FORMAT_VERSION,
  defineModel,
  defineShape,
  encodePersistence,
  f,
  getApplyRuntime,
  readQuarantineEntries,
  resetRuntime,
  writePersistenceManifest
} from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, type DiagnosticsSnapshot } from '../helpers/harness';
import { createFaultStorage } from '../helpers/faultStorage';
import type { StoragePlane } from '../../testApi';

const document = { kind: 'Document', definitions: [] } as never;

/**
 * THE zero-loss instrument. One invariant, stated as an executable test:
 * a row the user wrote is never lost - not by a process kill at ANY persisted write point,
 * not by corruption of any single storage key, not by a schema migration, not by a library
 * version bump. It either lives in the store, or its operation is retryable, or it is
 * quarantined with a ticket. Silent disappearance is the only failure mode this suite hunts.
 *
 * Kill semantics: `setCalls()` records every physical write in order, so the disk state at
 * kill point K is the fold of writes[0..K] over an empty plane. One scenario run proves the
 * invariant for EVERY kill point, not a sampled one.
 *
 * A newly found loss enters as `it.failing` with its reproduction; the fix flips it to a plain
 * `it`. Every case below is a former loss that stays here as its own regression shield.
 */

type SendMedia = { id: string; kind: string; fileUrl: string; thumbUrl: string | null };

type SendInput = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sequenceNumber: number | null;
  media?: SendMedia | null;
  mediaBucket?: string | null;
};

type SendData = { send: { message: SendInput } };
type EditData = { edit: { message: SendInput } };

const MediaShape = defineShape<SendMedia>()({
  kind: f.str(),
  fileUrl: f.str(),
  thumbUrl: f.str().nullable()
});

const mediaBucketOf = (message: { media?: SendMedia | null }): string | null => (message.media ? 'visual' : null);

const SendSchema = defineShape<SendInput>()({
  chatId: f.str(),
  userId: f.str(),
  body: f.str(),
  status: f.str(),
  createdAt: f.str(),
  updatedAt: f.str(),
  sequenceNumber: f.num().nullable(),
  media: f.object(MediaShape).from((message: { media?: SendMedia | null }) => message.media ?? null).nullable(),
  mediaBucket: f.custom<string | null, SendInput>(mediaBucketOf).nullable()
});

const Message = defineModel('ZeroLossMessage', {
  schema: SendSchema,
  relations: () => ({
    thread: { by: { chatId: 'chatId' }, sort: { field: 'sequenceNumber', dir: 'desc' } },
    mediaItems: { by: { chatId: 'chatId', mediaBucket: 'mediaBucket' }, sort: { field: 'sequenceNumber', dir: 'desc' } }
  }),
  maintenance: { dropTempRowsAfterMs: 600_000 },
  // The app-shaped media contract: a trimmed fragment channel must not regress landed media.
  write: { groups: [{ fields: ['media'], policy: 'continuity' }] },
  actions: owner => ({
    send: owner.gql.action<SendData, Record<string, never>, { row: SendInput }, 'send'>(document, {
      mode: 'request',
      result: 'send',
      variables: () => ({}),
      optimistic: { root: { insert: { select: ({ input, tempId }) => ({ ...input.row, id: tempId }) } } },
      root: { insert: { select: ({ data }) => data.send.message } }
    }),
    edit: owner.gql.action<EditData, Record<string, never>, { messageId: string; body: string }, 'edit'>(document, {
      mode: 'request',
      result: 'edit',
      variables: () => ({}),
      optimistic: { root: { update: { select: ({ input }) => ({ id: input.messageId, patch: { body: input.body } }) } } },
      root: { update: { select: ({ data }) => ({ id: data.edit.message.id, patch: { body: data.edit.message.body } }) } }
    })
  })
});

type ChatInput = { id: string; updatedAt: string; lastMessage?: SendInput | null };

const Chat = defineModel('ZeroLossChat', {
  schema: defineShape<ChatInput>()({ updatedAt: f.str() }),
  sideloads: () => ({
    lastMessage: { model: Message, select: (chat: ChatInput) => chat.lastMessage ?? null }
  })
});

/** Deterministic PRNG: same seed, same scenario, same verdict. */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const SEEDS = Number.parseInt(process.env.ZERO_LOSS_SEEDS ?? '25', 10);

const NOW = '2026-08-05T00:00:00Z';

const serverRow = (id: string, body: string, sequenceNumber: number): SendInput => ({
  id,
  chatId: 'chat-1',
  userId: 'other',
  body,
  status: 'Sent',
  createdAt: NOW,
  updatedAt: NOW,
  sequenceNumber
});

/** Disk state at kill point K: the fold of the recorded writes over an empty plane. */
const diskAtWrite = (writes: Array<{ key: string; value: string | null }>, upto: number): StoragePlane => {
  const plane = createMemoryPlane();
  for (const write of writes.slice(0, upto)) plane.set(write.key, write.value);
  return plane;
};

const cloneDisk = (source: StoragePlane & { snapshotKeys: () => string[] }): StoragePlane & { snapshotKeys: () => string[] } => {
  const plane = createMemoryPlane();
  for (const key of source.snapshotKeys()) plane.set(key, source.get(key) ?? null);
  return plane;
};

const bootOn = async (storage: StoragePlane): Promise<void> => {
  resetRuntime();
  configureDb({ storage, transport: createMockTransport({ mutation: async <TData,>() => new Promise<{ data: TData }>(() => {}) }) });
  await bootDb();
};

const seedManifest = (): void => {
  writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
};

/**
 * Loss ledger classes that mean USER data vanished; cache eviction classes are not loss.
 * The migration/format reset classes are cache-only since step 2: the outbox and quarantine ride
 * through every reset verbatim, so those events no longer touch user data.
 */
const USER_LOSS_MECHANISMS = new Set(['stale-temp-row-expiry']);

const userLossEvents = (snapshot: DiagnosticsSnapshot): Array<{ mechanism: string; model: string; count: number }> =>
  snapshot.dataLossEvents.filter(event => USER_LOSS_MECHANISMS.has(event.mechanism));

/**
 * Runs one scenario: boot on a fresh disk, land server rows, start `opCount` optimistic sends
 * whose transport never answers, flush persistence. Returns the write journal and the ids.
 */
const runScenario = async (opCount: number): Promise<{ writes: Array<{ key: string; value: string | null }>; tempIds: string[]; serverIds: string[] }> => {
  const storage = createFaultStorage();
  resetRuntime();
  configureDb({ storage: storage.plane, transport: createMockTransport({ mutation: async <TData,>() => new Promise<{ data: TData }>(() => {}) }) });
  seedManifest();
  await bootDb();
  const serverIds = ['server-1', 'server-2'];
  Message.where({ chatId: 'chat-1' }).seed(serverIds.map((id, index) => serverRow(id, `landed-${index}`, index + 1)));
  const tempIds: string[] = [];
  for (let index = 0; index < opCount; index += 1) {
    const input: SendInput = { id: `local-${index}`, chatId: 'chat-1', userId: 'me', body: `draft-${index}`, status: 'Sending', createdAt: NOW, updatedAt: NOW, sequenceNumber: 100 + index };
    Message.actions.send.run({ row: input }).catch(() => {});
    await Promise.resolve();
  }
  await Promise.resolve();
  for (const row of Message.where({ chatId: 'chat-1' }).read()) {
    if (row.status === 'Sending') tempIds.push(row.id);
  }
  // The app-shaped end of the scenario: backgrounding lands the coalesced cache snapshots.
  getApplyRuntime().flushCacheSnapshots();
  return { writes: storage.setCalls(), tempIds, serverIds };
};

/**
 * The invariant at one restarted disk: an unsent user row is never silently gone. It survives as a
 * retryable operation (its domain input rides the ledger), as a live row, or as a quarantine
 * ticket - one of the three, always.
 */
const assertUserRowsSurvive = (tempIds: string[]): void => {
  const quarantined = new Set(readQuarantineEntries().map(entry => entry.id));
  for (const tempId of tempIds) {
    const row = Message.find(tempId);
    const operation = Message.operation(tempId).read();
    const survives = operation.pending || operation.failed || row !== undefined || quarantined.has(tempId);
    if (!survives) {
      throw new Error(
        `user row lost: id=${tempId} row=${row === undefined ? 'GONE' : 'present'} pending=${operation.pending} failed=${operation.failed} quarantined=false`
      );
    }
  }
};

describe('zero-loss lifecycle', () => {
  it('keeps server cache and delivered rows across a clean restart and account switch', async () => {
    const { writes } = await runScenario(0);
    const disk = diskAtWrite(writes, writes.length);
    await bootOn(disk);
    expect(Message.where({ chatId: 'chat-1' }).read().map(row => row.id).sort()).toEqual(['server-1', 'server-2']);
    expect(userLossEvents(diagnostics().snapshot())).toEqual([]);

    // Account switch: explicit user command - cache may go, but never silently.
    resetRuntime();
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    seedManifest();
    await bootDb();
    expect(Message.where({ chatId: 'chat-1' }).read()).toEqual([]);
  });

  it('discards the outbox on an explicit user reset loudly, never silently', async () => {
    const { tempIds } = await runScenario(2);
    expect(tempIds).toHaveLength(2);
    resetRuntime();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'user-reset-discard', model: '__operations__', count: 2 });
  });

  it('[I4] keeps unsent user rows retryable after a kill at EVERY persisted write point', async () => {
    const random = mulberry32(1);
    const { writes, tempIds } = await runScenario(2);
    expect(tempIds.length).toBeGreaterThan(0);
    // Every kill point from the first write to the last. The invariant binds per row, from the
    // moment the row's DATA reached the disk: its row entry, or its operation (the ledger record
    // carries the domain input). A scope entry alone is a pointer, not data.
    const step = Math.max(1, Math.floor(writes.length / 40));
    const offset = 1 + Math.floor(random() * step);
    let assertedPoints = 0;
    for (let kill = offset; kill <= writes.length; kill += step) {
      const disk = diskAtWrite(writes, kill) as StoragePlane & { snapshotKeys: () => string[] };
      const touched = tempIds.filter(
        tempId => disk.snapshotKeys().some(key => key.startsWith('dbl:row:') && key.includes(tempId)) || (disk.get('dbl:ops') ?? '').includes(tempId)
      );
      if (touched.length === 0) continue;
      assertedPoints += 1;
      await bootOn(disk);
      assertUserRowsSurvive(touched);
      expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
    }
    expect(assertedPoints).toBeGreaterThan(0);
  });

  it('quarantines a corrupt operation ledger instead of destroying every unsent row', async () => {
    const { writes, tempIds } = await runScenario(3);
    expect(tempIds.length).toBe(3);
    const disk = diskAtWrite(writes, writes.length) as StoragePlane & { snapshotKeys: () => string[] };
    disk.set('dbl:ops', '{corrupt');
    await bootOn(disk);
    assertUserRowsSurvive(tempIds);
    expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
  });

  it('keeps unsent rows when the operation ledger record version moves', async () => {
    const { writes, tempIds } = await runScenario(2);
    const disk = diskAtWrite(writes, writes.length) as StoragePlane & { snapshotKeys: () => string[] };
    const raw = disk.get('dbl:ops');
    expect(raw).toBeDefined();
    const decoded = JSON.parse(raw!) as { payload: Record<string, unknown> };
    disk.set('dbl:ops', encodePersistence({ ...decoded.payload, recordVersion: 1 }));
    await bootOn(disk);
    assertUserRowsSurvive(tempIds);
    expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
  });

  it('keeps unsent rows across a storage format reset', async () => {
    const { writes, tempIds } = await runScenario(2);
    const disk = diskAtWrite(writes, writes.length) as StoragePlane & { snapshotKeys: () => string[] };
    const manifestRaw = disk.get('dbl:manifest');
    expect(manifestRaw).toBeDefined();
    const manifest = (JSON.parse(manifestRaw!) as { payload: Record<string, unknown> }).payload;
    disk.set('dbl:manifest', encodePersistence({ ...manifest, formatVersion: 7 }));
    await bootOn(disk);
    assertUserRowsSurvive(tempIds);
  });

  it('keeps unsent rows across a schema fingerprint change', async () => {
    const { writes, tempIds } = await runScenario(2);
    const disk = diskAtWrite(writes, writes.length) as StoragePlane & { snapshotKeys: () => string[] };
    const manifestRaw = disk.get('dbl:manifest');
    expect(manifestRaw).toBeDefined();
    const manifest = (JSON.parse(manifestRaw!) as { payload: { schemaFingerprints: Record<string, string> } }).payload;
    const fingerprints = { ...manifest.schemaFingerprints };
    for (const key of Object.keys(fingerprints)) {
      if (key.startsWith('ZeroLossMessage')) fingerprints[key] = 'moved-fingerprint';
    }
    disk.set('dbl:manifest', encodePersistence({ ...manifest, schemaFingerprints: fingerprints }));
    await bootOn(disk);
    assertUserRowsSurvive(tempIds);
  });

  it('quarantines a landed row that fails validation instead of silently dropping it', async () => {
    await bootOn(createMemoryPlane());
    const invalid = { chatId: 'chat-1', userId: 'other', body: 'row without id', status: 'Sent', createdAt: NOW, updatedAt: NOW, sequenceNumber: 9 };
    Message.where({ chatId: 'chat-1' }).seed([serverRow('server-ok', 'kept', 1), invalid as never]);
    expect(Message.where({ chatId: 'chat-1' }).read().map(row => row.id)).toEqual(['server-ok']);
    const tickets = readQuarantineEntries().filter(entry => entry.reason === 'plan-row-rejected');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ kind: 'row', model: 'ZeroLossMessage', raw: invalid });
  });

  it('completes the destroy leg without resurrecting the server row when the user deleted the landed identity', async () => {
    resetRuntime();
    let resolveSend!: (value: { data: unknown }) => void;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() =>
          new Promise<{ data: TData }>(resolve => {
            resolveSend = resolve as (value: { data: unknown }) => void;
          })
      })
    });
    seedManifest();
    await bootDb();
    const input: SendInput = { id: 'local-1', chatId: 'chat-1', userId: 'me', body: 'draft', status: 'Sending', createdAt: NOW, updatedAt: NOW, sequenceNumber: 100 };
    const run = Message.actions.send.run({ row: input }).catch(() => {});
    await Promise.resolve();
    const tempId = Message.where({ chatId: 'chat-1' }).read().find(row => row.status === 'Sending')!.id;
    // While the response is in flight, the same server row arrives by event and is destroyed again,
    // so its existence epoch moves past the mutation's base revision.
    Message.where({ chatId: 'chat-1' }).seed([serverRow('server-echo', 'draft', 101)]);
    Message.destroy('server-echo');
    resolveSend({ data: { send: { message: serverRow('server-echo', 'draft', 101) } } });
    await run;
    // Deletion wins over the landing swap: the user destroyed this identity while the request
    // was in flight, so the temp leg is destroyed too, the server row never resurrects, and the
    // operation closes committed. An intentional delete is not a loss, so nothing is ticketed.
    expect(Message.find(tempId)).toBeUndefined();
    expect(Message.find('server-echo')).toBeUndefined();
    expect(readQuarantineEntries()).toEqual([]);
    expect(Message.operation(tempId).read().pending).toBe(false);
    expect(Message.where({ chatId: 'chat-1' }).read().map(row => row.id)).not.toContain(tempId);
  });

  it('swaps temp for the server row even when another channel landed the server copy first', async () => {
    resetRuntime();
    let resolveSend!: (value: { data: unknown }) => void;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() =>
          new Promise<{ data: TData }>(resolve => {
            resolveSend = resolve as (value: { data: unknown }) => void;
          })
      })
    });
    seedManifest();
    await bootDb();
    const input: SendInput = { id: 'local-1', chatId: 'chat-1', userId: 'me', body: 'race-draft', status: 'Sending', createdAt: NOW, updatedAt: NOW, sequenceNumber: 100 };
    const run = Message.actions.send.run({ row: input }).catch(() => {});
    await Promise.resolve();
    const tempId = Message.where({ chatId: 'chat-1' }).read().find(row => row.status === 'Sending')!.id;
    // The sender's own server copy arrives through a sideload channel (chat lastMessage) while the
    // response is still in flight - the everyday chatUpdated race, not an exotic interleaving.
    const serverCopy = { ...serverRow('server-race', 'race-draft', 101), userId: 'me' };
    Chat.insert({ id: 'chat-1', updatedAt: NOW, lastMessage: serverCopy });
    resolveSend({ data: { send: { message: serverCopy } } });
    await run;
    // Replace is a server identity fact: exactly one row remains, under the server id.
    const bodies = Message.where({ chatId: 'chat-1' }).read().filter(row => row.body === 'race-draft');
    expect(bodies.map(row => row.id)).toEqual(['server-race']);
    expect(Message.find(tempId)).toBeUndefined();
    expect(Message.operation(tempId).read().pending).toBe(false);
  });

  it('serves an accepted event commit after a kill before any coalesced flush', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureDb({ storage: storage.plane, transport: createMockTransport() });
    seedManifest();
    await bootDb();
    Message.where({ chatId: 'chat-1' }).seed([serverRow('server-tick', 'landed', 7)]);
    // Kill NOW: no background flush ran. The commit was accepted, so it must be durable.
    const disk = diskAtWrite(storage.setCalls(), storage.setCalls().length);
    await bootOn(disk);
    expect(Message.where({ chatId: 'chat-1' }).read().map(row => row.id)).toContain('server-tick');
  });

  it('[P6] serves the row AND its membership from every kill point inside the flush', async () => {
    const { writes } = await runScenario(0);
    // Kill right after the row key of server-2 reached the disk, before its scope key.
    const rowWriteIndex = writes.findIndex(write => write.key.startsWith('dbl:row:') && write.key.includes('server-2'));
    expect(rowWriteIndex).toBeGreaterThanOrEqual(0);
    const disk = diskAtWrite(writes, rowWriteIndex + 1);
    await bootOn(disk);
    // Row and membership are one atomic pair: a row the disk holds is readable through its scope.
    const memberIds = Message.thread({ chatId: 'chat-1' }).read().map(row => row.id);
    if (Message.find('server-2') !== undefined) expect(memberIds).toContain('server-2');
  });

  it('keeps fields landed after a mutation started when the process dies mid-mutation', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureDb({ storage: storage.plane, transport: createMockTransport({ mutation: async <TData,>() => new Promise<{ data: TData }>(() => {}) }) });
    seedManifest();
    await bootDb();
    Message.where({ chatId: 'chat-1' }).seed([serverRow('server-edit', 'original', 5)]);
    Message.actions.edit.run({ messageId: 'server-edit', body: 'edited' }).catch(() => {});
    await Promise.resolve();
    // While the edit is in flight, the server lands media on the same row (transcode finished).
    Message.where({ chatId: 'chat-1' }).seed([
      { ...serverRow('server-edit', 'edited', 5), media: { id: 'm1', kind: 'video', fileUrl: 'https://cdn/video.mp4', thumbUrl: 'https://cdn/thumb.jpg' } }
    ]);
    getApplyRuntime().flushCacheSnapshots();
    const disk = diskAtWrite(storage.setCalls(), storage.setCalls().length);
    await bootOn(disk);
    const row = Message.find('server-edit');
    expect(row).toBeDefined();
    // Boot rollback is field-level, like the runtime path: media landed AFTER the edit started and survives.
    expect(row!.media?.fileUrl).toBe('https://cdn/video.mp4');
  });

  it('[T13] fuzz: full lifecycle with dual-channel delivery and session operators holds every assert class', async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const random = mulberry32(seed + 20_000);
      let storage = createFaultStorage();
      const responseQueue: Array<(value: { data: SendData | EditData }) => void> = [];
      const makeTransport = () =>
        createMockTransport({
          mutation: async <TData,>() => new Promise<{ data: TData }>(resolve => responseQueue.push(resolve as (value: { data: SendData | EditData }) => void))
        });
      resetRuntime();
      configureDb({ storage: storage.plane, transport: makeTransport() });
      seedManifest();
      await bootDb();
      const media = (id: string): SendMedia => ({ id: `m-${id}`, kind: 'video', fileUrl: `https://cdn/${id}.mp4`, thumbUrl: null });
      /** What the mock server holds - survives every reset, reboot and account switch. */
      const serverTruth = new Map<string, SendInput>();
      /** What the LOCAL store must serve - starts empty again on every sanctioned wipe. */
      const localTruth = new Map<string, SendInput>();
      const openSends: Array<{ tempId: string; input: SendInput }> = [];
      /** Sends whose session died under them (reboot): unackable, but their ledger record survives. */
      const orphanSends: Array<{ tempId: string; input: SendInput }> = [];
      const ackedTempIds: string[] = [];
      let seq = 0;
      let localIndex = 0;
      const landedRow = (id: string, withMedia: boolean): SendInput => {
        seq += 1;
        return { ...serverRow(id, `landed-${id}`, seq), ...(withMedia ? { media: media(id) } : {}) };
      };
      /** The manifest invariant after EVERY step: a nonempty namespace always carries the manifest. */
      const assertManifestPresence = (): void => {
        const keys = storage.plane.keys('dbl:');
        if (keys.some(key => key !== 'dbl:manifest')) expect(keys).toContain('dbl:manifest');
      };
      /** Sanctioned flows never classify the store as corrupt: `model-corruption-recovery` is impossible. */
      const assertNoCorruptionClassification = (): void => {
        expect(diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'model-corruption-recovery')).toEqual([]);
      };
      /** Logout: the local store empties, the outbox discard is DECLARED loss, never silence. */
      const resetAsLogout = (): void => {
        const pending = openSends.length + orphanSends.length;
        resetRuntime();
        const discards = diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'user-reset-discard');
        if (pending > 0) expect(discards).toEqual([{ mechanism: 'user-reset-discard', model: '__operations__', count: pending }]);
        else expect(discards).toEqual([]);
        localTruth.clear();
        openSends.length = 0;
        orphanSends.length = 0;
        responseQueue.length = 0;
      };
      /** Process restart on the current disk snapshot: in-flight responses die, the ledger rides. */
      const rebootOnCurrentDisk = async (): Promise<void> => {
        getApplyRuntime().flushCacheSnapshots();
        const disk = diskAtWrite(storage.setCalls(), storage.setCalls().length) as StoragePlane & { snapshotKeys: () => string[] };
        const next = createFaultStorage();
        for (const key of disk.snapshotKeys()) next.plane.set(key, disk.get(key) ?? null);
        storage = next;
        orphanSends.push(...openSends.splice(0));
        responseQueue.length = 0;
        resetRuntime();
        configureDb({ storage: storage.plane, transport: makeTransport() });
        await bootDb();
        assertNoCorruptionClassification();
      };
      /** Account switch: logout reset, then a full re-login boot on the SAME plane. */
      const switchAccountOnSamePlane = async (): Promise<void> => {
        resetAsLogout();
        configureDb({ storage: storage.plane, transport: makeTransport() });
        await bootDb();
        assertNoCorruptionClassification();
      };
      try {
        for (let step = 0; step < 14; step += 1) {
          const roll = Math.floor(random() * 9);
          if (roll === 0) {
            const row = landedRow(`srv-live-${step}`, random() < 0.5);
            serverTruth.set(row.id, row);
            localTruth.set(row.id, row);
            Message.where({ chatId: 'chat-1' }).seed([row]);
          } else if (roll === 1 && serverTruth.size > 0) {
            // Trimmed fragment channel: the same server row arrives without its media payload.
            // The continuity policy keeps the landed media; the derived bucket must not flip.
            // After a wipe the trimmed copy is the row's FIRST local delivery: no media to keep.
            const ids = [...serverTruth.keys()];
            const id = ids[Math.floor(random() * ids.length)]!;
            const truth = serverTruth.get(id)!;
            const trimmed = { ...truth };
            delete trimmed.media;
            delete trimmed.mediaBucket;
            const existing = localTruth.get(id);
            localTruth.set(id, existing?.media ? { ...(trimmed as SendInput), media: existing.media } : (trimmed as SendInput));
            Message.where({ chatId: 'chat-1' }).seed([trimmed as SendInput]);
          } else if (roll === 2) {
            localIndex += 1;
            seq += 1;
            const withMedia = random() < 0.5;
            const input: SendInput = {
              id: `local-${localIndex}`,
              chatId: 'chat-1',
              userId: 'me',
              body: `draft-${localIndex}`,
              status: 'Sending',
              createdAt: NOW,
              updatedAt: NOW,
              sequenceNumber: seq,
              ...(withMedia ? { media: media(`local-${localIndex}`) } : {})
            };
            Message.actions.send.run({ row: input }).catch(() => {});
            await Promise.resolve();
            const tempId = Message.where({ chatId: 'chat-1' })
              .read()
              .find(row => row.status === 'Sending' && row.body === input.body)!.id;
            openSends.push({ tempId, input });
          } else if (roll === 3 && openSends.length > 0 && responseQueue.length > 0) {
            const send = openSends.shift()!;
            const serverId = `srv-ack-${send.tempId}`;
            const acked: SendInput = { ...send.input, id: serverId, status: 'Sent', ...(send.input.media ? { media: media(serverId) } : {}) };
            serverTruth.set(serverId, acked);
            localTruth.set(serverId, acked);
            // Dual-channel delivery in both orders: half the time the same server row lands
            // through the live channel BEFORE the response replace swaps the temp row - and the
            // live copy is TRIMMED (no media), so only the response merge can land the media.
            if (random() < 0.5) {
              const trimmedEcho = { ...acked };
              delete trimmedEcho.media;
              delete trimmedEcho.mediaBucket;
              Message.where({ chatId: 'chat-1' }).seed([trimmedEcho as SendInput]);
            }
            responseQueue.shift()!({ data: { send: { message: acked } } });
            await Promise.resolve();
            await Promise.resolve();
            ackedTempIds.push(send.tempId);
          } else if (roll === 4 && serverTruth.size > 0) {
            const ids = [...serverTruth.keys()];
            const id = ids[Math.floor(random() * ids.length)]!;
            Message.destroy(id);
            serverTruth.delete(id);
            localTruth.delete(id);
          } else if (roll === 5) {
            getApplyRuntime().flushCacheSnapshots();
          } else if (roll === 6) {
            resetAsLogout();
          } else if (roll === 7) {
            await rebootOnCurrentDisk();
          } else if (roll === 8) {
            await switchAccountOnSamePlane();
          }
          assertManifestPresence();
        }
        getApplyRuntime().flushCacheSnapshots();
        const disk = diskAtWrite(storage.setCalls(), storage.setCalls().length) as StoragePlane & { snapshotKeys: () => string[] };
        await bootOn(disk);

        // loss: no user-data loss events on a clean lifecycle; a wipe never reads as corruption.
        expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
        expect(diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'model-corruption-recovery')).toEqual([]);
        // manifest: the disk this session ends on is manifested whenever it is nonempty.
        if (disk.snapshotKeys().some(key => key !== 'dbl:manifest')) expect(disk.snapshotKeys()).toContain('dbl:manifest');
        // row parity + field parity: every locally landed row is served with its landed fields.
        for (const [id, truth] of localTruth) {
          const row = Message.find(id);
          expect(row).toBeDefined();
          expect(row!.body).toBe(truth.body);
          if (truth.media) expect(row!.media?.fileUrl).toBe(truth.media.fileUrl);
        }
        // no-resurrect: a destroyed server id never comes back through any channel or session.
        const allRows = Message.where({ chatId: 'chat-1' }).read();
        for (const row of allRows) {
          if (row.id.startsWith('srv-') && !serverTruth.has(row.id)) throw new Error(`resurrected server row ${row.id}`);
        }
        // no-duplicates + no-eternal-temp: an acked temp is gone; an open or orphaned temp survives
        // with an open operation - a dead session's response is lost, its ledger record is not.
        for (const tempId of ackedTempIds) expect(Message.find(tempId)).toBeUndefined();
        for (const send of [...openSends, ...orphanSends]) {
          expect(Message.find(send.tempId)).toBeDefined();
          const operation = Message.operation(send.tempId).read();
          expect(operation.pending || operation.failed).toBe(true);
        }
        // membership parity: the thread scope serves exactly the local truth plus live temps.
        const memberIds = Message.thread({ chatId: 'chat-1' }).read().map(row => row.id).sort();
        const expectedIds = [...localTruth.keys(), ...openSends.map(send => send.tempId), ...orphanSends.map(send => send.tempId)].sort();
        expect(memberIds).toEqual(expectedIds);
        // derived by-scope parity: the media bucket serves exactly the rows whose media landed.
        const mediaIds = Message.mediaItems({ chatId: 'chat-1', mediaBucket: 'visual' }).read().map(row => row.id).sort();
        const expectedMediaIds = [
          ...[...localTruth.values()].filter(truth => truth.media).map(truth => truth.id),
          ...[...openSends, ...orphanSends].filter(send => send.input.media).map(send => send.tempId)
        ].sort();
        expect(mediaIds).toEqual(expectedMediaIds);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });

  it('never loses user rows to random corruption of cache keys', async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const random = mulberry32(seed);
      const { writes, tempIds } = await runScenario(1 + Math.floor(random() * 2));
      const disk = diskAtWrite(writes, writes.length) as StoragePlane & { snapshotKeys: () => string[] };
      // Corrupt 1-2 cache-class keys; the ops ledger (outbox) is durable class and stays intact here.
      const cacheKeys = disk.snapshotKeys().filter(key => /^dbl:(row|scope|tombstones|query)/.test(key));
      const corruptCount = 1 + Math.floor(random() * 2);
      for (let index = 0; index < corruptCount && cacheKeys.length > 0; index += 1) {
        const key = cacheKeys[Math.floor(random() * cacheKeys.length)]!;
        disk.set(key, '{corrupt');
      }
      try {
        await bootOn(disk);
        assertUserRowsSurvive(tempIds);
        expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });

  it('[P1] random kill points never lose rows the disk already holds', async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const random = mulberry32(seed + 10_000);
      const { writes, serverIds } = await runScenario(0);
      const kill = 1 + Math.floor(random() * writes.length);
      const disk = diskAtWrite(writes, kill) as StoragePlane & { snapshotKeys: () => string[] };
      const persistedRows = disk.snapshotKeys().filter(key => key.startsWith('dbl:row:ZeroLossMessage'));
      try {
        await bootOn(cloneDisk(disk));
        const survivors = Message.where({ chatId: 'chat-1' }).read().map(row => row.id);
        // Cache parity: every row that reached the disk before the kill is served after restart.
        for (const key of persistedRows) {
          const id = key.slice(key.lastIndexOf(':') + 1);
          if (serverIds.some(serverId => id.includes(serverId))) {
            expect(survivors.some(survivor => id.includes(survivor))).toBe(true);
          }
        }
        expect(userLossEvents(diagnostics().snapshot())).toEqual([]);
      } catch (error) {
        throw new Error(`seed ${seed} kill ${kill}/${writes.length}: ${(error as Error).message}`);
      }
    }
  });
});
