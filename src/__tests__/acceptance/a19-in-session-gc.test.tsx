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
    const detailRow = detailReader.result();
    const rows = listReader.result();
    const detailRenders = detailReader.renders();
    const listRenders = listReader.renders();

    act(() => { collectGarbage(); });

    expect(detailReader.renders()).toBe(detailRenders);
    expect(listReader.renders()).toBe(listRenders);
    expect(detailReader.result()).toBe(detailRow);
    expect(listReader.result()).toBe(rows);
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

  it('unmounted reader rows become collectible', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A19Unmounted', name: 'Unmounted', fields: { title: f.str() } });
    model.insertStored({ id: 'row', title: 'row' });
    const reader = renderCounted(() => model.use.row('row'));
    reader.unmount();

    act(() => { collectGarbage(); });

    expect(model.get('row')).toBeUndefined();
    expect(model.use.where({}).read()).toEqual([]);
  });
});
