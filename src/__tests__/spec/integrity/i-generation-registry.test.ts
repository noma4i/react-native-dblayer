import { bootDb, configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; body: string };

const defineRows = () => defineModelRuntime({ id: 'SpecGenerationRegistry', name: 'SpecGenerationRegistry', fields: { body: f.str() } });

/**
 * One declaration owns one identity per runtime generation. A second declaration of the same model
 * inside one generation is a programming error and is refused before it can shadow the live one; a
 * declaration made after a reset replaces the dead one and serves the new runtime's data, while the
 * dead declaration resurrects nothing. The observable stake: the model the app writes through is the
 * model the app reads from.
 */
describe('declaration identity across runtime generations', () => {
  it('refuses a second declaration of one model inside one generation and keeps the live one serving data', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const rows = defineRows();
    await bootDb();
    rows.insert({ id: 'row-1', body: 'first' } as Row);

    expect(() => defineRows()).toThrow('already registered');
    expect(rows.all().map(row => [row.id, row.body])).toEqual([['row-1', 'first']]);
  });

  it('[I8] [W7] [W16] [F8] serves the new runtime through a declaration made after a reset', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const first = defineRows();
    await bootDb();
    first.insert({ id: 'row-1', body: 'first' } as Row);
    expect(first.all().map(row => row.id)).toEqual(['row-1']);

    resetRuntime();
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const second = defineRows();
    await bootDb();
    second.insert({ id: 'row-2', body: 'second' } as Row);

    // The new declaration owns the identity, and the dead one resurrects nothing from the old runtime.
    expect(second.all().map(row => [row.id, row.body])).toEqual([['row-2', 'second']]);
    expect(first.all()).toEqual([]);
  });
});
