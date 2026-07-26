import { act } from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, mergeOptimisticMedia } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const mediaShape = defineShape()({
  id: f.id(),
  kind: f.str(),
  fileUrl: f.str(),
  thumbUrl: f.str(),
  blurHash: f.str().nullDefault(),
  coverUrl: f.str().nullDefault(),
  width: f.num().nullDefault(),
  height: f.num().nullDefault()
});

type MessageRow = {
  id: string;
  body: string;
  media: { id: string; kind: string; fileUrl: string; thumbUrl: string; blurHash: string | null; coverUrl: string | null; width: number | null; height: number | null };
  localPreviewUrl: string | null;
};

type SendResult = { send: { message: MessageRow } };

describe('optimistic commit preserve semantics', () => {
  it('keeps client-only values while server media and body win with merger dimension fallback', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          send: {
            message: {
              id: 'message-1',
              body: 'server body',
              media: {
                id: 'media-1',
                kind: 'photo',
                fileUrl: 'https://cdn/full.jpg',
                thumbUrl: 'https://cdn/thumb.jpg',
                blurHash: 'LKO2?U%2',
                coverUrl: null,
                width: null,
                height: null
              },
              localPreviewUrl: null
            }
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineModel({
      id: 'CommitPreserveMessages',
      name: 'CommitPreserveMessages',
      fields: { body: f.str(), media: f.object(mediaShape), localPreviewUrl: f.str().nullable() }
    });
    const send = messages.mutation<SendResult, void, MessageRow, MessageRow>('send', {
      document,
      result: 'send',
      optimistic: {
        model: messages,
        build: (_input: void, context: { tempId: string | null }) => ({
          id: context.tempId!,
          body: 'optimistic body',
          media: {
            id: 'media-1',
            kind: 'photo',
            fileUrl: 'file:///spool/1.jpg',
            thumbUrl: 'file:///spool/1.jpg',
            blurHash: null,
            coverUrl: null,
            width: 320,
            height: 240
          },
          localPreviewUrl: 'file:///spool/1.jpg'
        }),
        selectServerNode: (data: SendResult) => data.send.message,
        preserveOnCommit: ['media', 'localPreviewUrl', 'body'],
        commitMergers: {
          media: (optimisticMedia: unknown, serverMedia: unknown) => mergeOptimisticMedia(optimisticMedia, serverMedia, { dimensionKeys: ['width', 'height'] })
        }
      }
    });

    await act(async () => {
      await send.run();
    });

    const committed = messages.find('message-1')!;
    expect(committed.media.fileUrl).toBe('https://cdn/full.jpg');
    expect(committed.media.blurHash).toBe('LKO2?U%2');
    expect(committed.media.width).toBe(320);
    expect(committed.media.height).toBe(240);
    expect(committed.localPreviewUrl).toBe('file:///spool/1.jpg');
    expect(committed.body).toBe('server body');
  });
});
