import { act } from 'react-test-renderer';
import { defineModel, f } from '../../index';
import { createAcceptanceTransport, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('A16 crud scaffold', () => {
  it('uses an explicit create optimistic override without requiring respond or build', async () => {
    const transport = createAcceptanceTransport({ mutation: async <TData,>() => ({ data: { create: { id: 'server', title: 'server' } } as TData }) });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Override', name: 'A16Override', fields: { title: f.str() } });
    const custom = jest.fn(() => ({ method: 'patch' as const, model, selectId: () => 'row', selectPatch: () => ({ title: 'custom' }) }));
    act(() => { model.insertStored({ id: 'row', title: 'before' }); });
    expect(() => model.crud({ create: { document, result: 'create', optimistic: custom() } }).create).not.toThrow();
  });
});
