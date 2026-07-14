import { createV6TestRuntime } from '../helpers/v6Runtime';
import { createCommitBus } from '../../core/apply/commitBus';

describe('v6 invariant 06: semantic commit bus', () => {
  it('publishes one batch and excludes unrelated field projections', () => {
    const runtime = createV6TestRuntime();
    runtime.applyManyRows();
    expect(runtime.commitBatchCount()).toBe(1);
    expect(runtime.unrelatedProjectionNotifications()).toBe(0);
  });
});

describe('commit bus dependency matching', () => {
  it('matches only declared row fields and row identity', () => {
    const bus = createCommitBus();
    const notify = jest.fn();
    bus.subscribe(notify, [{ kind: 'row', model: 'm', id: '1', fields: ['name'] }]);
    bus.publish({ rows: [{ model: 'm', id: '1', fields: ['name', 'age'] }], scopes: [] });
    bus.publish({ rows: [{ model: 'm', id: '1', fields: ['age'] }], scopes: [] });
    bus.publish({ rows: [{ model: 'm', id: '2', fields: ['name'] }], scopes: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('matches all fields when a changed row has null fields', () => {
    const bus = createCommitBus();
    const notify = jest.fn();
    bus.subscribe(notify, [{ kind: 'row', model: 'm', id: '1', fields: ['name'] }]);
    bus.publish({ rows: [{ model: 'm', id: '1', fields: null }], scopes: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('notifies once when a batch has multiple matching rows', () => {
    const bus = createCommitBus();
    const notify = jest.fn();
    bus.subscribe(notify, [{ kind: 'model', model: 'm' }]);
    bus.publish({ rows: [{ model: 'm', id: '1', fields: ['name'] }, { model: 'm', id: '2', fields: ['name'] }], scopes: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('matches scopes by model and scope key', () => {
    const bus = createCommitBus();
    const notify = jest.fn();
    bus.subscribe(notify, [{ kind: 'scope', model: 'm', scopeKey: 'active' }]);
    bus.publish({ rows: [], scopes: [{ model: 'm', scopeKey: 'other' }, { model: 'n', scopeKey: 'active' }] });
    bus.publish({ rows: [], scopes: [{ model: 'm', scopeKey: 'active' }] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('matches model dependencies for both rows and scopes', () => {
    const bus = createCommitBus();
    const notify = jest.fn();
    bus.subscribe(notify, [{ kind: 'model', model: 'm' }]);
    bus.publish({ rows: [{ model: 'm', id: '1', fields: ['name'] }], scopes: [] });
    bus.publish({ rows: [], scopes: [{ model: 'm', scopeKey: 'active' }] });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
