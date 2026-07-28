import fs from 'node:fs';
import path from 'node:path';

describe('mmkv instance id stability gate', () => {
  it('keeps the historical MMKV instance id so an update does not orphan persisted user rows', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../utils/mmkvStorage.ts'), 'utf8');

    if (!source.includes("createMMKV({ id: 'tanstack-db' })")) {
      throw new Error('MMKV instance id must remain tanstack-db; renaming it orphans persisted user rows after an update.');
    }
  });
});
