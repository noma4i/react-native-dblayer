import fs from 'node:fs';
import path from 'node:path';

const operationStateSource = fs.readFileSync(path.resolve(__dirname, '../../../core/planes/operationState.ts'), 'utf8');

describe('persistence implementation discipline', () => {
  it('[P11] keeps JSON validation and round-tripping in the persistence codec', () => {
    expect(operationStateSource).not.toMatch(/const isJsonValue|JSON\.parse\(JSON\.stringify\(input\)\)/);
  });
});
