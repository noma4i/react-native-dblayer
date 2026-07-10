import { configureDb, defineFields, defineModel, devClearAllDataAndState } from '../index';
import { getRegisteredModel } from '../core/modelRegistry';
import { clearModelRegistry } from '../core/modelRegistry';
import { f } from '../schema/f';
import { defineShape } from '../schema/shape';
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

const defaultMetaShape = defineShape<{ label?: unknown }>()({
  label: f.str()
});

const mediaZeroShape = defineShape<{ url?: unknown; coverUrl?: unknown; markers?: unknown }>()({
  url: f.str().nullDefault(),
  coverUrl: f.str().nullDefault(),
  markers: f.custom<string[], { markers?: unknown }>(input => (Array.isArray(input.markers) ? input.markers.filter((marker): marker is string => typeof marker === 'string') : []))
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

  it('drops null and id-less entries from a merge payload instead of throwing', () => {
    installMemoryStorage();
    const model = createUserModel('fields-users-sparse-list');

    expect(
      model.applyServerData(
        [
          null,
          { uuid: 'no-id', fullName: 'Missing id' },
          {
            id: 'u1',
            uuid: 'user-1',
            fullName: 'Ada Lovelace',
            age: 36,
            country: { name: 'United Kingdom' }
          }
        ] as never,
        { mode: 'merge' }
      )
    ).toEqual({ merged: 1 });

    expect(model.getAll()).toHaveLength(1);
    expect(model.get('u1')).toMatchObject({ id: 'u1', fullName: 'Ada Lovelace' });
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

  it('builds complete stored rows from factory defaults', () => {
    installMemoryStorage();
    const model = defineModel({
      id: 'fields-build-stored',
      name: 'FieldsBuildStoredModel',
      fields: {
        title: f.str(),
        status: f.enum<'sending' | 'sent'>().default('sending'),
        archived: f.bool().default(false),
        count: f.num().nullable(),
        note: f.str().optional(),
        optionalLabel: f.str().nullable().optional(),
        tags: f.array(f.str()).default(() => []),
        meta: f.object(defaultMetaShape).default(() => ({ label: 'new' })),
        fromTitle: f.str().from<{ nested?: { title?: unknown } }>(input => input.nested?.title).default('from-default'),
        coverUrl: f.str().nullDefault().default('factory-cover')
      }
    });

    const first = model.buildStored({
      id: 'row-1',
      title: 'Draft',
      status: 'sent',
      note: 'local note'
    });
    const second = model.buildStored({ id: 'row-2', title: 'Second' });
    const explicit = model.buildStored({
      id: 'row-3',
      title: 'Explicit',
      count: 7,
      tags: ['given'],
      meta: { label: 'given' },
      coverUrl: 'given-cover'
    });

    expect(first).toEqual({
      id: 'row-1',
      title: 'Draft',
      status: 'sent',
      archived: false,
      count: null,
      note: 'local note',
      tags: [],
      meta: { label: 'new' },
      fromTitle: 'from-default',
      coverUrl: 'factory-cover'
    });
    expect('optionalLabel' in first).toBe(false);
    expect(second.tags).toEqual([]);
    expect(second.meta).toEqual({ label: 'new' });
    expect(first.tags).not.toBe(second.tags);
    expect(first.meta).not.toBe(second.meta);
    expect(explicit).toMatchObject({
      id: 'row-3',
      title: 'Explicit',
      count: 7,
      tags: ['given'],
      meta: { label: 'given' },
      coverUrl: 'given-cover'
    });
  });

  it('normalizes branded inputs without writes and optionally requires complete fields', () => {
    installMemoryStorage();
    type RawInput = { id: string; payload: { title: string }; note?: string };
    const fields = defineFields<RawInput>()({
      title: f.str().from<RawInput>(input => input.payload.title),
      note: f.str().optional()
    });
    const model = defineModel({
      id: 'fields-public-normalize',
      name: 'FieldsPublicNormalizeModel',
      fields
    });

    expect(model.normalize({ id: 'row-1', payload: { title: 'Ready' } })).toEqual({ id: 'row-1', title: 'Ready' });
    expect(model.normalize({ id: 'row-2', payload: { title: 'Complete' } }, { requireComplete: true })).toEqual({ id: 'row-2', title: 'Complete' });
    expect(model.normalize({ id: 'row-3', payload: { title: 1 as unknown as string } }, { requireComplete: true })).toBeNull();
    expect(model.getAll()).toEqual([]);

    if (false) {
      // @ts-expect-error branded fields reject inputs outside their raw contract
      model.normalize({ id: 'invalid' });
    }
  });

  it('builds required nested shape zero-state rows from empty defaults', () => {
    installMemoryStorage();
    const model = defineModel({
      id: 'fields-build-stored-empty-default',
      name: 'FieldsBuildStoredEmptyDefaultModel',
      fields: {
        title: f.str(),
        media: f.object(mediaZeroShape).emptyDefault()
      }
    });

    const omitted = model.buildStored({ id: 'row-1', title: 'Draft' });
    const explicit = model.buildStored({
      id: 'row-2',
      title: 'Ready',
      media: {
        url: 'https://example.test/video.m3u8',
        coverUrl: 'https://example.test/cover.jpg',
        markers: ['intro']
      }
    });

    expect(omitted.media).toEqual({
      url: null,
      coverUrl: null,
      markers: []
    });
    expect(explicit.media).toEqual({
      url: 'https://example.test/video.m3u8',
      coverUrl: 'https://example.test/cover.jpg',
      markers: ['intro']
    });
    expect(omitted.media).not.toBe(model.buildStored({ id: 'row-3', title: 'Fresh' }).media);
  });

  it('enforces buildStored requirements in types and runtime', () => {
    installMemoryStorage();
    const model = defineModel({
      id: 'fields-build-stored-types',
      name: 'FieldsBuildStoredTypesModel',
      fields: {
        title: f.str(),
        status: f.enum<'sending' | 'sent'>().default('sending'),
        count: f.num().nullable(),
        note: f.str().optional(),
        labels: f.array(f.str()).default(() => [])
      }
    });
    model.buildStored({ id: 'row-1', title: 'Draft' });
    model.buildStored({ id: 'row-2', title: 'Draft', count: null, labels: ['a'] });
    expect(() => (model as any).buildStored({ id: 'row-3' })).toThrow('[FieldsBuildStoredTypesModel] buildStored missing required field "title".');

    if (false) {
      // @ts-expect-error required field without a factory default must be provided
      model.buildStored({ id: 'missing-title' });
      // @ts-expect-error row id is always required
      model.buildStored({ title: 'Missing id' });
      // @ts-expect-error factory default values must match the field output type
      f.num().default('bad');
      // @ts-expect-error lazy factory defaults must return the field output type
      f.array(f.str()).default(() => [1]);
    }
  });

  it('registers fields and custom normalize models', () => {
    installMemoryStorage();
    const fieldsModel = createUserModel('fields-users-registry');
    const normalizeModel = defineModel<{ id: string; title: string }, { id: string; title: string }>({
      id: 'normalize-registry',
      name: 'NormalizeRegistryModel',
      normalize: input => ({ id: input.id, title: input.title })
    });

    expect(getRegisteredModel('FieldsUserModel:fields-users-registry')).toBe(fieldsModel);
    expect(getRegisteredModel('NormalizeRegistryModel')).toBe(normalizeModel);
  });
});
