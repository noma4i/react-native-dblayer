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

  it('keeps the delete mark counter consistent across repeated deletes and later writes', () => {
    const core = createRowVersionCore({ maxDeleteMarks: 2 });
    core.noteDelete('first');
    core.noteDelete('first');
    core.noteDelete('second');
    core.noteDelete('third');

    expect(core.getDeleteSeq('first')).toBeUndefined();
    expect(core.getDeleteSeq('second')).toBeDefined();
    expect(core.getDeleteSeq('third')).toBeDefined();

    const writeAfterDelete = createRowVersionCore({ maxDeleteMarks: 1 });
    writeAfterDelete.noteDelete('first');
    writeAfterDelete.noteWrite('first');
    writeAfterDelete.noteDelete('second');

    expect(writeAfterDelete.getWriteSeq('first')).toBeDefined();
    expect(writeAfterDelete.getDeleteSeq('second')).toBeDefined();
  });

  it('reports delete marks within their configured TTL', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const core = createRowVersionCore();
    core.noteDelete('row');

    jest.spyOn(Date, 'now').mockReturnValue(1_999);
    expect(core.wasDeletedWithin('row', 1_000)).toBe(true);

    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    expect(core.wasDeletedWithin('row', 1_000)).toBe(false);
  });
});
