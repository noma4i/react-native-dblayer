import { act } from 'react-test-renderer';
import { configureDb, defineFetch } from '../../../index';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider } from '../helpers/harness';

type NullableResponse = { value: null };
type ValueResponse = { value: string };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
};

describe('defineFetch empty loading state', () => {
  it('shows an empty state for a null selected result', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { value: null } as TData }) })
    });
    const request = defineFetch<NullableResponse, void, null>({
      document,
      key: 'c20-null-empty',
      select: data => data.value
    });
    let latest!: ReturnType<typeof request.use>;
    const reader = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest;
    });

    await settle();

    expect({ hasData: latest.loadingState.hasData, showEmptyState: latest.loadingState.showEmptyState }).toEqual({ hasData: false, showEmptyState: true });
    reader.unmount();
  });

  it('keeps data state for a non-empty selected result', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { value: 'ready' } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const request = defineFetch<ValueResponse, void, string>({
      document,
      key: 'c20-value-data',
      select: data => data.value
    });
    let latest!: ReturnType<typeof request.use>;
    const reader = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest;
    });

    await settle();

    expect({ hasData: latest.loadingState.hasData, showEmptyState: latest.loadingState.showEmptyState }).toEqual({ hasData: true, showEmptyState: false });
    reader.unmount();
  });
});
