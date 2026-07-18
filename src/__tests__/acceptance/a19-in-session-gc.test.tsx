import { act } from 'react-test-renderer';
import { collectGarbage, defineModel, f } from '../../index';
import { renderCounted, setupAcceptanceRuntime } from './harness';

describe('A19 in-session garbage collection', () => {
  it('mounted readers root their rows through collectGarbage', () => {
    setupAcceptanceRuntime();
    const detail = defineModel({ id: 'A19Detail', name: 'Detail', fields: { title: f.str() } });
    const list = defineModel({ id: 'A19List', name: 'List', fields: { title: f.str() } });
    detail.insertStored({ id: 'detail', title: 'detail' });
    list.insertStored({ id: 'list', title: 'list' });
    const detailReader = renderCounted(() => detail.use.row('detail'));
    const listReader = renderCounted(() => list.use.where({}).rows());

    act(() => { collectGarbage(); });

    expect(detailReader.result()).toEqual({ id: 'detail', title: 'detail' });
    expect(listReader.result()).toEqual([{ id: 'list', title: 'list' }]);
    detailReader.unmount();
    listReader.unmount();
  });

  it('unreferenced unscoped rows are evicted', () => {
    setupAcceptanceRuntime();
    const detail = defineModel({ id: 'A19UnreferencedDetail', name: 'UnreferencedDetail', fields: { title: f.str() } });
    const list = defineModel({ id: 'A19UnreferencedList', name: 'UnreferencedList', fields: { title: f.str() } });
    detail.insertStored({ id: 'detail', title: 'detail' });
    list.insertStored({ id: 'list', title: 'list' });

    act(() => { collectGarbage(); });

    expect(detail.use.where({}).read()).toEqual([]);
    expect(list.use.where({}).read()).toEqual([]);
  });
});
