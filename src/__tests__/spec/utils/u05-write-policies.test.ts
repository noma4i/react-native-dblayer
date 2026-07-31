import { compileWritePolicies } from '../../testApi';
import { diagnostics } from '../helpers/harness';

type Row = Record<string, unknown> & { id: string };

const gate = (groups: Parameters<typeof compileWritePolicies>[0]) => compileWritePolicies<Row>(groups, 'PolicyMatrix');

/**
 * Owner contract of the single entity write gate: every policy branch decided by a concrete
 * value pair, so a broken comparison can not hide behind another group.
 */
describe('write policy matrix', () => {
  it('accepts a strictly newer tuple and restores an equal or older one', () => {
    const groups = [{ fields: ['seq', 'at'], policy: { monotonic: { tuple: ['seq', 'at'] } } }] as const;
    const newer = gate(groups)({ id: 'r', seq: 1, at: 5 }, { id: 'r', seq: 2, at: 1 }, { origin: 'snapshot' });
    expect(newer).toMatchObject({ seq: 2, at: 1 });
    const equal = gate(groups)({ id: 'r', seq: 2, at: 1 }, { id: 'r', seq: 2, at: 1 }, { origin: 'snapshot' });
    expect(equal).toMatchObject({ seq: 2, at: 1 });
    const older = gate(groups)({ id: 'r', seq: 2, at: 9 }, { id: 'r', seq: 1, at: 99 }, { origin: 'snapshot' });
    expect(older).toMatchObject({ seq: 2, at: 9 });
    // The second tuple member only decides when the first ties.
    const tieBreak = gate(groups)({ id: 'r', seq: 2, at: 1 }, { id: 'r', seq: 2, at: 3 }, { origin: 'snapshot' });
    expect(tieBreak).toMatchObject({ seq: 2, at: 3 });
  });

  it('orders tuple members with null last-loses and mixed types by codepoints', () => {
    const groups = [{ fields: ['mark'], policy: { monotonic: { tuple: ['mark'] } } }] as const;
    expect(gate(groups)({ id: 'r', mark: null }, { id: 'r', mark: 'a' }, { origin: 'snapshot' })).toMatchObject({ mark: 'a' });
    expect(gate(groups)({ id: 'r', mark: 'a' }, { id: 'r', mark: null }, { origin: 'snapshot' })).toMatchObject({ mark: 'a' });
    // Numeric-looking values normalize through the num codec and compare numerically...
    expect(gate(groups)({ id: 'r', mark: 9 }, { id: 'r', mark: '10' }, { origin: 'snapshot' })).toMatchObject({ mark: '10' });
    expect(gate(groups)({ id: 'r', mark: '9' }, { id: 'r', mark: 10 }, { origin: 'snapshot' })).toMatchObject({ mark: 10 });
    // ...and only non-numeric values fall back to codepoint order.
    expect(gate(groups)({ id: 'r', mark: 'b' }, { id: 'r', mark: 'a10' }, { origin: 'snapshot' })).toMatchObject({ mark: 'b' });
    expect(gate(groups)({ id: 'r', mark: 'a10' }, { id: 'r', mark: 'b' }, { origin: 'snapshot' })).toMatchObject({ mark: 'b' });
  });

  it('requires every nonEmpty field to be present before accepting the group', () => {
    const groups = [{ fields: ['first', 'second'], policy: { monotonic: { nonEmpty: true } } }] as const;
    const rejected = gate(groups)({ id: 'r', first: 'kept', second: 'kept' }, { id: 'r', first: 'new', second: '' }, { origin: 'snapshot' });
    expect(rejected).toMatchObject({ first: 'kept', second: 'kept' });
    const accepted = gate(groups)({ id: 'r', first: 'kept', second: 'kept' }, { id: 'r', first: 'new', second: 'also' }, { origin: 'snapshot' });
    expect(accepted).toMatchObject({ first: 'new', second: 'also' });
  });

  it('lets a null ladder side pass, rejects unranked values, and enforces tier order', () => {
    const groups = [{ fields: ['media'], policy: { monotonic: { ladder: { path: 'media.status', tiers: [['processing'], ['done']] } } } }] as const;
    const nullSide = gate(groups)({ id: 'r', media: { status: null } }, { id: 'r', media: { status: 'processing' } }, { origin: 'snapshot' });
    expect(nullSide).toMatchObject({ media: { status: 'processing' } });
    diagnostics().reset();
    const unranked = gate(groups)({ id: 'r', media: { status: 'done' } }, { id: 'r', media: { status: 'weird' } }, { origin: 'snapshot' });
    expect(unranked).toMatchObject({ media: { status: 'done' } });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'unranked-ladder-value', model: 'PolicyMatrix', count: 1 });
    const regress = gate(groups)({ id: 'r', media: { status: 'done' } }, { id: 'r', media: { status: 'processing' } }, { origin: 'snapshot' });
    expect(regress).toMatchObject({ media: { status: 'done' } });
    // A null INCOMING side also passes: absence is not an unranked value and must not report loss.
    diagnostics().reset();
    const nullIncoming = gate(groups)({ id: 'r', media: { status: 'done' } }, { id: 'r', media: { status: null } }, { origin: 'snapshot' });
    expect(nullIncoming).toMatchObject({ media: { status: null } });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('applies nested key policies: positive keeps a positive current over a missing or zero incoming', () => {
    const groups = [{ fields: ['stats'], policy: { keys: { count: 'positive' }, rest: 'server' } }] as const;
    const zeroed = gate(groups)({ id: 'r', stats: { count: 7, label: 'old' } }, { id: 'r', stats: { count: 0, label: 'new' } }, { origin: 'snapshot' });
    expect(zeroed).toMatchObject({ stats: { count: 7, label: 'new' } });
    const grown = gate(groups)({ id: 'r', stats: { count: 7 } }, { id: 'r', stats: { count: 9 } }, { origin: 'snapshot' });
    expect(grown).toMatchObject({ stats: { count: 9 } });
    const fromZero = gate(groups)({ id: 'r', stats: { count: 0 } }, { id: 'r', stats: { count: 0 } }, { origin: 'snapshot' });
    expect(fromZero).toMatchObject({ stats: { count: 0 } });
    // A non-record incoming value replaces the object wholesale.
    const replaced = gate(groups)({ id: 'r', stats: { count: 7 } }, { id: 'r', stats: null }, { origin: 'snapshot' });
    expect(replaced).toMatchObject({ stats: null });
  });

  it('keeps monotonic groups authoritative for replace and inert for patch by default', () => {
    const groups = [{ fields: ['seq'], policy: { monotonic: { tuple: ['seq'] } } }] as const;
    const replace = gate(groups)({ id: 'r', seq: 9 }, { id: 'r', seq: 1 }, { origin: 'replace' });
    expect(replace).toMatchObject({ seq: 1 });
    const patch = gate(groups)({ id: 'r', seq: 9 }, { id: 'r', seq: 1 }, { origin: 'patch' });
    expect(patch).toMatchObject({ seq: 1 });
  });

  it('restores continuity fields only when the incoming value is nullish', () => {
    const groups = [{ fields: ['avatar'], policy: 'continuity' }] as const;
    expect(gate(groups)({ id: 'r', avatar: 'kept.png' }, { id: 'r', avatar: null }, { origin: 'snapshot' })).toMatchObject({ avatar: 'kept.png' });
    expect(gate(groups)({ id: 'r', avatar: 'kept.png' }, { id: 'r', avatar: 'new.png' }, { origin: 'snapshot' })).toMatchObject({ avatar: 'new.png' });
  });

  it('shallow-folds snapshot objects and lets locals survive every non-patch origin', () => {
    const snapshotGroups = [{ fields: ['profile'], policy: { snapshot: true } }] as const;
    const folded = gate(snapshotGroups)(
      { id: 'r', profile: { name: 'old', city: 'kept' } },
      { id: 'r', profile: { name: 'new' } },
      { origin: 'snapshot' }
    );
    expect(folded).toMatchObject({ profile: { name: 'new', city: 'kept' } });

    const localGroups = [{ fields: ['clientId'], policy: 'local' }] as const;
    expect(gate(localGroups)({ id: 'r', clientId: 'mine' }, { id: 'r', clientId: null }, { origin: 'snapshot' })).toMatchObject({ clientId: 'mine' });
    expect(gate(localGroups)({ id: 'r', clientId: 'mine' }, { id: 'r', clientId: 'patched' }, { origin: 'patch' })).toMatchObject({ clientId: 'patched' });
  });
});
