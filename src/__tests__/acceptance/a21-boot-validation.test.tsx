import { bootDb, defineModel, f, hasMany, resetRuntime } from '../../index';
import { createAcceptanceTransport, createMemoryPlane, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;
const cascadeError = 'optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children';

describe('A21 boot validation', () => {
  it('bootDb rejects destroy mutation on cascade model', async () => {
    const child = defineModel({ id: 'A21CascadeChild', name: 'CascadeChild', fields: { parentId: f.id() } });
    const parent = defineModel({
      id: 'A21CascadeParent',
      name: 'CascadeParent',
      fields: {},
      relations: () => ({ children: hasMany(child, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    parent.mutation('destroy', {
      document,
      result: 'destroy',
      optimistic: { method: 'destroy', model: parent, selectId: (input: { id: string }) => input.id }
    });

    await expect(bootDb({ storage: createMemoryPlane(), transport: createAcceptanceTransport() })).rejects.toThrow(cascadeError);
  });

  it('bootDb passes for non-cascade destroy mutations', async () => {
    const model = defineModel({ id: 'A21Leaf', name: 'Leaf', fields: { title: f.str() } });
    model.mutation('destroy', {
      document,
      result: 'destroy',
      optimistic: { method: 'destroy', model, selectId: (input: { id: string }) => input.id }
    });

    await expect(bootDb({ storage: createMemoryPlane(), transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));
  });

  it('run-time guard still fires without boot', async () => {
    setupAcceptanceRuntime();
    const child = defineModel({ id: 'A21RuntimeChild', name: 'RuntimeChild', fields: { parentId: f.id() } });
    const parent = defineModel({
      id: 'A21RuntimeParent',
      name: 'RuntimeParent',
      fields: {},
      relations: () => ({ children: hasMany(child, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    const mutation = parent.mutation('destroy', {
      document,
      result: 'destroy',
      optimistic: { method: 'destroy', model: parent, selectId: (input: { id: string }) => input.id }
    });

    await expect(mutation.run({ id: 'parent' })).rejects.toThrow(cascadeError);
  });

  it('resetRuntime clears failing boot validations', async () => {
    const child = defineModel({ id: 'A21ResetChild', name: 'ResetChild', fields: { parentId: f.id() } });
    const parent = defineModel({
      id: 'A21ResetParent',
      name: 'ResetParent',
      fields: {},
      relations: () => ({ children: hasMany(child, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    parent.mutation('destroy', {
      document,
      result: 'destroy',
      optimistic: { method: 'destroy', model: parent, selectId: (input: { id: string }) => input.id }
    });

    await expect(bootDb({ storage: createMemoryPlane(), transport: createAcceptanceTransport() })).rejects.toThrow(cascadeError);
    resetRuntime();

    await expect(bootDb({ storage: createMemoryPlane(), transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));
  });
});
