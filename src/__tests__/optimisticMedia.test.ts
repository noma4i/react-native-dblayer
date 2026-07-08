import { mergeOptimisticMedia } from '../index';

type Media = {
  id: string;
  width?: number | null;
  height?: number | null;
  fileUrl?: string | null;
  thumbUrl?: string | null;
  previewUrl?: string | null;
};

describe('optimistic media merge', () => {
  it('preserves optimistic dimensions when server dimensions are missing or zero', () => {
    expect(
      mergeOptimisticMedia<Media>(
        { id: 'media-1', width: 640, height: 360 },
        { id: 'media-1', width: 0, height: null }
      )
    ).toEqual({
      id: 'media-1',
      width: 640,
      height: 360
    });
  });

  it('keeps real server dimensions over optimistic dimensions', () => {
    expect(
      mergeOptimisticMedia<Media>(
        { id: 'media-1', width: 640, height: 360 },
        { id: 'media-1', width: 1280, height: 720 }
      )
    ).toEqual({
      id: 'media-1',
      width: 1280,
      height: 720
    });
  });

  it('falls back to optimistic non-empty sources per configured key', () => {
    expect(
      mergeOptimisticMedia<Media>(
        { id: 'media-1', fileUrl: 'file://local.mov', thumbUrl: 'file://thumb.jpg', previewUrl: 'file://preview.jpg' },
        { id: 'media-1', fileUrl: '', thumbUrl: 'https://cdn.example/thumb.jpg', previewUrl: null },
        { sourceKeys: ['fileUrl', 'thumbUrl', 'previewUrl'] }
      )
    ).toEqual({
      id: 'media-1',
      fileUrl: 'file://local.mov',
      thumbUrl: 'https://cdn.example/thumb.jpg',
      previewUrl: 'file://preview.jpg'
    });
  });

  it('supports custom dimension keys', () => {
    expect(
      mergeOptimisticMedia(
        { pixelWidth: 320, pixelHeight: 180 },
        { pixelWidth: 0, pixelHeight: undefined },
        { dimensionKeys: ['pixelWidth', 'pixelHeight'] }
      )
    ).toEqual({
      pixelWidth: 320,
      pixelHeight: 180
    });
  });

  it('tolerates nullish and non-object inputs', () => {
    expect(mergeOptimisticMedia({ width: 100 }, null)).toBeNull();
    expect(mergeOptimisticMedia({ width: 100 }, undefined)).toBeUndefined();
    expect(mergeOptimisticMedia({ width: 100 }, 'server')).toBe('server');
    expect(mergeOptimisticMedia('optimistic', { id: 'media-1', width: 0 })).toEqual({ id: 'media-1', width: 0 });
  });
});
