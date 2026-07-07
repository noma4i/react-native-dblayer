import { configureDb, defineModel, devClearAllDataAndState } from '../index';
import { getRegisteredModel } from '../core/modelRegistry';
import { clearModelRegistry } from '../core/modelRegistry';
import { f } from '../schema/f';
import type { ModelInput, ModelStored } from '../schema/infer';
import type { CollectionModel } from '../types';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
    ? true
    : false
  : false;

const userFields = {
  uuid: f.str(),
  fullName: f.str(),
  age: f.num().nullable(),
  countryName: f
    .custom<string, unknown>(input => {
      if (typeof input !== 'object' || input === null) return undefined;
      const country = (input as { country?: { name?: unknown } }).country;
      return typeof country?.name === 'string' ? country.name : undefined;
    })
    .nullable(),
  coverUrl: f.str().nullDefault()
};

const createUserModel = (id: string) =>
  defineModel({
    id,
    name: `FieldsUserModel:${id}`,
    fields: userFields,
    merge: {},
    replace: {},
    defaultSort: { field: 'fullName', direction: 'asc' }
  });

describe('fields-based model definitions', () => {
  afterEach(() => {
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
    clearModelRegistry();
  });

  it('normalizes raw merge payloads through generated fields', () => {
    installMemoryStorage();
    const model = createUserModel('fields-users-merge');

    expect(
      model.applyServerData(
        [
          {
            id: 'u1',
            uuid: 'user-1',
            fullName: 'Ada Lovelace',
            age: 36,
            country: { name: 'United Kingdom' },
            coverUrl: undefined
          },
          {
            id: 2,
            uuid: 'user-2',
            fullName: 'Grace Hopper',
            age: null,
            country: { name: 'United States' },
            coverUrl: 'https://example.test/grace.jpg'
          }
        ],
        { mode: 'merge' }
      )
    ).toEqual({ merged: 2 });

    expect(model.get('u1')).toMatchObject({
      id: 'u1',
      uuid: 'user-1',
      fullName: 'Ada Lovelace',
      age: 36,
      countryName: 'United Kingdom',
      coverUrl: null
    });
    expect(model.get('2')).toMatchObject({
      id: '2',
      uuid: 'user-2',
      fullName: 'Grace Hopper',
      age: null,
      countryName: 'United States',
      coverUrl: 'https://example.test/grace.jpg'
    });
  });

  it('supports rowId and guard row drops', () => {
    installMemoryStorage();
    const model = defineModel({
      id: 'fields-rowid-guard',
      name: 'FieldsRowIdGuardModel',
      fields: {
        title: f.str()
      },
      rowId: input => {
        if (typeof input !== 'object' || input === null) return null;
        const row = input as { tenantId?: string; remoteId?: string };
        return row.tenantId && row.remoteId ? `${row.tenantId}:${row.remoteId}` : null;
      },
      guard: input => typeof input === 'object' && input !== null && (input as { keep?: boolean }).keep !== false,
      merge: {}
    });

    expect(
      model.applyServerData(
        [
          { tenantId: 't1', remoteId: 'r1', title: 'Kept' },
          { tenantId: 't1', remoteId: null, title: 'Missing id' },
          { tenantId: 't1', remoteId: 'r2', title: 'Dropped', keep: false }
        ],
        { mode: 'merge' }
      )
    ).toEqual({ merged: 1 });
    expect(model.getAll().map(row => ({ id: row.id, title: row.title }))).toEqual([{ id: 't1:r1', title: 'Kept' }]);
  });

  it('preserves sparse update semantics for skipped fields', () => {
    installMemoryStorage();
    const model = createUserModel('fields-users-sparse');

    model.applyServerData(
      [
        {
          id: 'u1',
          uuid: 'user-1',
          fullName: 'Ada Lovelace',
          age: 36,
          country: { name: 'United Kingdom' },
          coverUrl: 'https://example.test/ada.jpg'
        }
      ],
      { mode: 'merge' }
    );

    model.applyServerData(
      [
        {
          id: 'u1',
          fullName: 'Ada King',
          age: 'bad',
          country: {},
          coverUrl: undefined
        }
      ],
      { mode: 'merge' }
    );

    expect(model.get('u1')).toMatchObject({
      id: 'u1',
      uuid: 'user-1',
      fullName: 'Ada King',
      age: 36,
      countryName: 'United Kingdom',
      coverUrl: null
    });
  });

  it('throws when fields declare an id key', () => {
    installMemoryStorage();

    expect(() =>
      defineModel({
        id: 'fields-id-key',
        name: 'FieldsIdKeyModel',
        fields: {
          id: f.str()
        }
      })
    ).toThrow('[FieldsIdKeyModel] fields cannot include "id". Use rowId or input.id for the row id.');
  });

  it('supports statics and model-derived types on fields models', () => {
    installMemoryStorage();
    const model = defineModel({
      id: 'fields-users-statics',
      name: 'FieldsUserStaticsModel',
      fields: userFields,
      statics: baseModel => ({
        currentId: () => baseModel.getFirst()?.id
      })
    });

    type Stored = ModelStored<typeof model>;
    type Input = ModelInput<typeof model>;
    type ExpectedStored = {
      id: string;
      uuid: string;
      fullName: string;
      age: number | null;
      countryName: string | null;
      coverUrl: string | null;
    };
    type ExpectedInput = {
      id: string;
      uuid?: string;
      fullName?: string;
      age?: number | null;
      countryName?: string | null;
      coverUrl?: string | null;
    };
    type _StoredShape = Expect<Equal<Stored, ExpectedStored>>;
    type _InputShape = Expect<Equal<Input, ExpectedInput>>;
    const acceptsModel = <TStored extends { id: string; updatedAt?: string | null }>(_model: CollectionModel<unknown, TStored>): void => {};
    acceptsModel(model);

    expect(model.currentId()).toBeUndefined();
    model.insertStored({
      id: 'u1',
      uuid: 'user-1',
      fullName: 'Ada Lovelace',
      age: null,
      countryName: null,
      coverUrl: null
    });
    expect(model.currentId()).toBe('u1');
  });

  it('registers fields and legacy normalize models', () => {
    installMemoryStorage();
    const fieldsModel = createUserModel('fields-users-registry');
    const legacyModel = defineModel<{ id: string; title: string }, { id: string; title: string }>({
      id: 'legacy-registry',
      name: 'LegacyRegistryModel',
      normalize: input => ({ id: input.id, title: input.title })
    });

    expect(getRegisteredModel('FieldsUserModel:fields-users-registry')).toBe(fieldsModel);
    expect(getRegisteredModel('LegacyRegistryModel')).toBe(legacyModel);
  });
});
