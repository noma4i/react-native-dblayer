import { clearModelRegistry, getRegisteredModel, registerModel } from '../core/modelRegistry';
import { setDbLogger } from '../core/logger';

const noop = (): void => {};

describe('model registry', () => {
  afterEach(() => {
    clearModelRegistry();
    setDbLogger({ debug: noop, error: noop });
  });

  it('registers, reads, and clears models', () => {
    const model = { name: 'UserModel' };

    registerModel('UserModel', model);

    expect(getRegisteredModel('UserModel')).toBe(model);

    clearModelRegistry();

    expect(() => getRegisteredModel('UserModel')).toThrow('[UserModel] model is not registered. No models registered.');
  });

  it('overwrites duplicate names and emits a debug log', () => {
    const debug = jest.fn();
    const first = { version: 1 };
    const second = { version: 2 };
    setDbLogger({ debug, error: noop });

    registerModel('UserModel', first);
    expect(() => registerModel('UserModel', second)).not.toThrow();

    expect(getRegisteredModel('UserModel')).toBe(second);
    expect(debug).toHaveBeenCalledWith('[UserModel] model registry entry replaced.');
  });

  it('lists registered model names in missing-model errors', () => {
    registerModel('MessageModel', {});
    registerModel('UserModel', {});

    expect(() => getRegisteredModel('MomentModel')).toThrow('[MomentModel] model is not registered. Registered models: MessageModel, UserModel.');
  });
});
