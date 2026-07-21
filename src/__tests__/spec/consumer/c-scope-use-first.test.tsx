import { act } from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// ScopeHandle.useFirst: nullable single-row scope reads.

type ProfileRow = { id: string; uuid: string; score: number };

const createProfiles = (suffix: string) =>
  defineModel({
    id: `SpecScopeUseFirst${suffix}`,
    name: `SpecScopeUseFirst${suffix}`,
    fields: { id: f.str(), uuid: f.str(), score: f.num() },
    scopes: {
      byUuid: scope<ProfileRow>({ by: { uuid: 'uuid' } }),
      ranked: scope<ProfileRow>({ by: { uuid: 'uuid' }, sort: { field: 'score', dir: 'desc' } })
    }
  });

describe('ScopeHandle.useFirst', () => {
  it('returns the first scope row and undefined for empty or nullish values', () => {
    setupSpecRuntime();
    const profiles = createProfiles('Basic');
    profiles.insertStored({ id: 'p-1', uuid: 'u-abc', score: 1 });
    const hit = renderCounted(() => profiles.scopes.byUuid.useFirst({ uuid: 'u-abc' }));
    const miss = renderCounted(() => profiles.scopes.byUuid.useFirst({ uuid: 'u-none' }));
    const nullish = renderCounted(() => profiles.scopes.byUuid.useFirst(null));
    expect(hit.result()?.id).toBe('p-1');
    expect(miss.result()).toBeUndefined();
    expect(nullish.result()).toBeUndefined();
    hit.unmount();
    miss.unmount();
    nullish.unmount();
  });

  it('follows the scope sort and stays reactive', () => {
    setupSpecRuntime();
    const profiles = createProfiles('Sorted');
    profiles.insertStored({ id: 'p-1', uuid: 'u-1', score: 5 });
    const reader = renderCounted(() => profiles.scopes.ranked.useFirst({ uuid: 'u-1' }));
    expect(reader.result()?.id).toBe('p-1');
    act(() => {
      profiles.insertStored({ id: 'p-2', uuid: 'u-1', score: 9 });
    });
    expect(reader.result()?.id).toBe('p-2');
    reader.unmount();
  });
});
