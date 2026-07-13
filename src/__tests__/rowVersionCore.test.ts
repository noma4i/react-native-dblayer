import { createRowVersionCore } from '../core/rowVersionCore';

describe('row version core', () => {
  it('arbitrates write and delete marks from one monotonic sequence', () => {
    const core = createRowVersionCore();
    const snapshot = core.snapshot();

    core.noteWrite('row');
    expect(core.wasWrittenAfter('row', snapshot)).toBe(true);
    expect(core.wasDeletedAfter('row', snapshot)).toBe(false);

    core.noteDelete('row');
    expect(core.wasWrittenAfter('row', snapshot)).toBe(false);
    expect(core.wasDeletedAfter('row', snapshot)).toBe(true);

    core.noteWrite('row');
    expect(core.wasDeletedAfter('row', snapshot)).toBe(false);
    expect(core.currentSeq()).toBe(3);
  });

  it('caps delete marks while retaining a monotonic session sequence across reset', () => {
    const core = createRowVersionCore({ maxDeleteMarks: 1 });

    core.noteDelete('first');
    core.noteDelete('second');
    expect(core.getDeleteSeq('first')).toBeUndefined();
    expect(core.getDeleteSeq('second')).toBe(2);

    core.reset();
    expect(core.getDeleteSeq('second')).toBeUndefined();
    expect(core.snapshot()).toBe(2);
  });
});
