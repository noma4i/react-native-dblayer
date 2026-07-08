import * as pkg from '../index';

describe('package exports surface', () => {
  it('matches the checked-in export name snapshot', () => {
    expect(Object.keys(pkg).sort()).toMatchSnapshot();
  });
});
