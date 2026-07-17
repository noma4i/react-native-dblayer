globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalError = console.error;

console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
    return;
  }
  if (args.some(arg => typeof arg === 'string' && arg.includes('not wrapped in act'))) {
    return;
  }
  originalError(...args);
};
