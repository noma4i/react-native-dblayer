"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DbProvider = void 0;
var _react = require("react");
var _reactNative = require("react-native");
var _configure = require("./configure.js");
var _lifecycle = require("./lifecycle.js");
var _diagnostics = require("../core/diagnostics.js");
var _fetchReaderRegistry = require("../core/fetch/fetchReaderRegistry.js");
/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
const DbProvider = ({
  children
}) => {
  const [booted, setBooted] = (0, _react.useState)(false);
  const [bootError, setBootError] = (0, _react.useState)(null);
  const bootPromise = (0, _react.useRef)(null);
  const previousAppState = (0, _react.useRef)(_reactNative.AppState.currentState);
  const resumeDrainGeneration = (0, _react.useRef)(0);
  if (bootError) throw bootError;
  (0, _react.useEffect)(() => {
    let mounted = true;
    bootPromise.current ??= (0, _lifecycle.bootDb)();
    void bootPromise.current.then(() => {
      if (mounted) setBooted(true);
    }).catch(error => {
      if (mounted) setBootError(error);
    });
    return () => {
      mounted = false;
    };
  }, []);
  (0, _react.useEffect)(() => {
    const subscription = _reactNative.AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active' && (previousState === 'background' || previousState === 'inactive')) {
        const generation = ++resumeDrainGeneration.current;
        const chunkSize = (0, _configure.getDbRuntimeConfig)().defaults.resumeRefetch?.chunkSize ?? 4;
        if (chunkSize <= 0) throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${chunkSize}`);
        void (0, _fetchReaderRegistry.resumeFetchReaders)(chunkSize, () => resumeDrainGeneration.current === generation).then(_diagnostics.noteResumeDrain);
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
  }, []);
  return booted ? children : null;
};
exports.DbProvider = DbProvider;
//# sourceMappingURL=DbProvider.js.map