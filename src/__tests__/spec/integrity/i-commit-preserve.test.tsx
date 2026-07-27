import { act } from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f } from '../../../index';
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
  it('keeps client-only values while server media and body win on replacement', async () => {
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
      fields: { body: f.str(), media: f.object(mediaShape), localPreviewUrl: f.str().nullable() },
      write: { groups: [{ fields: ['media'] as const, policy: { media: { dimensionKeys: ['width', 'height'], sourceKeys: ['fileUrl', 'thumbUrl', 'coverUrl'], transcodeGuard: { statusField: 'transcodeStatus' } } } }, { fields: ['localPreviewUrl'] as const, policy: 'continuity' }] }
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
        selectServerNode: (data: SendResult) => data.send.message
      }
    });

    await act(async () => {
      await send.run();
    });

    const committed = messages.find('message-1')!;
    expect(committed.media.fileUrl).toBe('https://cdn/full.jpg');
    expect(committed.media.blurHash).toBe('LKO2?U%2');
    expect(committed.media.width).toBeNull();
    expect(committed.media.height).toBeNull();
    expect(committed.localPreviewUrl).toBeNull();
    expect(committed.body).toBe('server body');
  });
});
