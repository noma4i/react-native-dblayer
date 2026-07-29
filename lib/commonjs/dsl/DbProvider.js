'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.DbProvider = void 0;
var _react = require('react');
var _reactNative = require('react-native');
var _configure = require('./configure.js');
var _lifecycle = require('./lifecycle.js');
var _diagnostics = require('../core/diagnostics.js');
var _fetchReaderRegistry = require('../core/fetch/fetchReaderRegistry.js');
/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
const DbProvider = ({ children }) => {
  const [booted, setBooted] = (0, _react.useState)(false);
  const [bootError, setBootError] = (0, _react.useState)(null);
  const bootPromise = (0, _react.useRef)(null);
  const previousAppState = (0, _react.useRef)(_reactNative.AppState.currentState);
  const resumeDrainGeneration = (0, _react.useRef)(0);
  if (bootError) throw bootError;
  (0, _react.useEffect)(() => {
    let mounted = true;
    const bootCurrentGeneration = async () => {
      while (mounted) {
        const generation = (0, _configure.getRuntimeGeneration)();
        bootPromise.current ??= (0, _lifecycle.bootDb)();
        try {
          await bootPromise.current;
          if (generation !== (0, _configure.getRuntimeGeneration)()) {
            bootPromise.current = null;
            continue;
          }
          setBooted(true);
          return;
        } catch (error) {
          if (generation !== (0, _configure.getRuntimeGeneration)()) {
            bootPromise.current = null;
            continue;
          }
          setBootError(error);
          return;
        }
      }
    };
    void bootCurrentGeneration();
    return () => {
      mounted = false;
    };
  }, []);
  (0, _react.useEffect)(() => {
    if (!booted) return;
    const subscription = _reactNative.AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active' && (previousState === 'background' || previousState === 'inactive')) {
        const drainGeneration = ++resumeDrainGeneration.current;
        const runtimeGeneration = (0, _configure.getRuntimeGeneration)();
        const chunkSize = (0, _configure.getDbRuntimeConfig)().defaults.resumeRefetch?.chunkSize ?? 4;
        if (chunkSize <= 0) throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${chunkSize}`);
        const isCurrent = () => resumeDrainGeneration.current === drainGeneration && (0, _configure.getRuntimeGeneration)() === runtimeGeneration;
        void (0, _fetchReaderRegistry.resumeFetchReaders)(chunkSize, isCurrent).then(refetched => {
          if (isCurrent()) (0, _diagnostics.noteResumeDrain)(refetched);
        });
      } else if (state === 'background') {
        resumeDrainGeneration.current += 1;
        (0, _lifecycle.suspendDb)();
      }
      previousAppState.current = state;
    });
    return () => {
      resumeDrainGeneration.current += 1;
      subscription.remove();
    };
  }, [booted]);
  return booted ? children : null;
};
exports.DbProvider = DbProvider;
//# sourceMappingURL=DbProvider.js.map
