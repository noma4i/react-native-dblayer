import fs from 'node:fs';
import path from 'node:path';

describe('mmkv instance id stability gate', () => {
  it('keeps the historical MMKV instance id so an update does not orphan persisted user rows', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../utils/mmkvStorage.ts'), 'utf8');

    // Renaming the instance orphans every persisted user row on the next app update.
    expect(source).toContain("createMMKV({ id: 'tanstack-db' })");
  });
});
