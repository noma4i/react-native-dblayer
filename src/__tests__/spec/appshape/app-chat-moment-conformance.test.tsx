import { configureDb } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';
import { createAppModels } from './appModels';

const moment = (id: string) => ({ id, uuid: 'moment-uuid-1', userId: 'user-1', createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z', media: { id: 'media-1', kind: 'photo', fileUrl: 'file:///moment.jpg' } });

describe('app chat and moment conformance', () => {
  it('CM1 local moment deletion removes every app scope membership and tombstone rejects a stale feed snapshot', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('ChatMomentDelete');
    const row = moment('moment-1');
    models.moments.scopes.feed.seed({}, [row] as any);
    models.moments.scopes.byUser.seed({ userId: 'user-1' }, [row] as any);
    models.moments.scopes.byUuid.seed({ uuid: 'moment-uuid-1' }, [row] as any);
    models.moments.scopes.myMoments.seed({}, [row] as any);
    models.moments.scopes.compassRelations.seed({}, [row] as any);

    models.moments.destroy('moment-1');

    expect(models.moments.find('moment-1')).toBeUndefined();
    expect(models.moments.scopes.feed.read({})).toEqual([]);
    expect(models.moments.scopes.byUser.read({ userId: 'user-1' })).toEqual([]);
    expect(models.moments.scopes.byUuid.read({ uuid: 'moment-uuid-1' })).toEqual([]);
    expect(models.moments.scopes.myMoments.read({})).toEqual([]);
    expect(models.moments.scopes.compassRelations.read({})).toEqual([]);

    models.moments.scopes.feed.seed({}, [row] as any);
    expect(models.moments.find('moment-1')).toBeUndefined();
    expect(models.moments.scopes.feed.read({})).toEqual([]);
  });
});
