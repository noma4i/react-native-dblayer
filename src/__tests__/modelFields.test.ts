import { configureDb, defineModel, defineShape, f, type StoragePlane } from '../index';
import { mockTransport } from './helpers/testRuntime';

const createMemoryStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) {
        if (entry.value === null) values.delete(entry.key);
        else values.set(entry.key, entry.value);
      }
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const mediaZeroShape = defineShape<{ url?: unknown; coverUrl?: unknown; markers?: unknown }>()({
  url: f.str().nullDefault(),
  coverUrl: f.str().nullDefault(),
  markers: f.custom<string[], { markers?: unknown }>(input => (Array.isArray(input.markers) ? input.markers.filter((marker): marker is string => typeof marker === 'string') : []))
});

describe('fields-based model definitions', () => {
  it('builds required nested shape zero-state rows from empty defaults', () => {
    configureDb({ storage: createMemoryStorage(), transport: mockTransport({}) });
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
});
