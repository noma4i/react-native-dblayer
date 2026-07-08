import { f } from '../schema/f';
import { defineShape, readShape, readShapeOrThrow } from '../schema/shape';

type MediaInput = {
  url?: unknown;
  coverUrl?: unknown;
  width?: unknown;
  height?: unknown;
  alt?: unknown;
  label?: unknown;
};

type RowInput = {
  id?: unknown;
  media?: unknown;
  payload?: {
    media?: unknown;
  };
  attachments?: unknown;
  memberIds?: unknown;
};

const mediaShape = defineShape<MediaInput>()({
  url: f.str(),
  coverUrl: f.str().nullDefault(),
  width: f.num().nullDefault(),
  height: f.num().nullDefault(),
  alt: f.str().optional(),
  label: f.str().nullable().optional()
});

describe('schema shapes', () => {
  it('reads mixed-mode media-like shapes', () => {
    expect(
      readShape(mediaShape, {
        url: 'https://example.test/video.m3u8',
        coverUrl: 'https://example.test/cover.jpg',
        width: 640,
        height: 360,
        alt: 'Preview',
        label: null
      })
    ).toEqual({
      url: 'https://example.test/video.m3u8',
      coverUrl: 'https://example.test/cover.jpg',
      width: 640,
      height: 360,
      alt: 'Preview',
      label: null
    });

    expect(readShape(mediaShape, { url: 'https://example.test/video.m3u8' })).toEqual({
      url: 'https://example.test/video.m3u8',
      coverUrl: null,
      width: null,
      height: null
    });

    expect(
      readShape(mediaShape, {
        url: 10,
        coverUrl: 20,
        width: '640',
        height: false,
        alt: null,
        label: 1
      })
    ).toEqual({});

    expect(readShape(mediaShape, null)).toBeUndefined();
    expect(readShape(mediaShape, [])).toBeUndefined();
  });

  it('supports standalone readShape escape-hatch usage', () => {
    const input = {
      url: 'https://example.test/image.png',
      coverUrl: undefined,
      width: 200,
      height: 100
    };

    const media = readShape(mediaShape, input);

    expect(media).toEqual({
      url: 'https://example.test/image.png',
      coverUrl: null,
      width: 200,
      height: 100
    });
  });

  it('throws a labelled error for unreadable shape payloads', () => {
    expect(readShapeOrThrow(mediaShape, { url: 'https://example.test/image.png' }, 'MediaShape')).toEqual({
      url: 'https://example.test/image.png',
      coverUrl: null,
      width: null,
      height: null
    });

    expect(() => readShapeOrThrow(mediaShape, null, 'MediaShape')).toThrow('MediaShape: invalid shape payload');
    expect(() => readShapeOrThrow(mediaShape, [], 'MediaShape')).toThrow('MediaShape: invalid shape payload');
  });

  it('reads object fields with sparse and nullable semantics', () => {
    const mediaField = f.object(mediaShape);

    expect(mediaField.read({}, 'media')).toBeUndefined();
    expect(mediaField.read({ media: null }, 'media')).toBeUndefined();
    expect(mediaField.nullable().read({ media: null }, 'media')).toBeNull();
    expect(mediaField.read({ media: { url: 'https://example.test/a.png' } }, 'media')).toEqual({
      url: 'https://example.test/a.png',
      coverUrl: null,
      width: null,
      height: null
    });

    const fromPayload = mediaField.from<RowInput>(input => input.payload?.media);
    expect(fromPayload.read({ payload: { media: { url: 'https://example.test/nested.png' } } }, 'ignored')).toEqual({
      url: 'https://example.test/nested.png',
      coverUrl: null,
      width: null,
      height: null
    });
  });

  it('reads arrays of shapes and drops unreadable elements', () => {
    const attachmentsField = f.array(mediaShape);

    expect(attachmentsField.read({ attachments: 'not-array' }, 'attachments')).toBeUndefined();
    expect(
      attachmentsField.read(
        {
          attachments: [
            { url: 'https://example.test/a.png', width: 100 },
            null,
            'invalid',
            { url: 'https://example.test/b.png', height: 200 }
          ]
        },
        'attachments'
      )
    ).toEqual([
      {
        url: 'https://example.test/a.png',
        coverUrl: null,
        width: 100,
        height: null
      },
      {
        url: 'https://example.test/b.png',
        coverUrl: null,
        width: null,
        height: 200
      }
    ]);
  });

  it('reads arrays of scalar field specs and drops invalid elements', () => {
    const memberIdsField = f.array(f.id());

    expect(memberIdsField.read({ memberIds: 'not-array' }, 'memberIds')).toBeUndefined();
    expect(memberIdsField.read({ memberIds: ['a', 2, false, null, undefined, 'b'] }, 'memberIds')).toEqual(['a', '2', 'b']);
  });
});
